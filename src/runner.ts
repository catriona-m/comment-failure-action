import * as core from '@actions/core'
import * as github from '@actions/github'
import {GitHub} from '@actions/github/lib/utils'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PullRequest {
  [key: string]: any
  number: number
}

interface IssueComment {
  [key: string]: any
  id: number
  body: string
}

interface CheckRun {
  [key: string]: any
  output: {
    [key: string]: any
    title: string
  }
  html_url: string
}

/* eslint-enable @typescript-eslint/no-explicit-any */

interface Env {
  api_token: string
  check_suite_id: number
  head_branch: string
  head_commit: string
  workflow: string
  owner: string
  repo: string
}

export class Runner {
  private env: Env
  private octokit: InstanceType<typeof GitHub>
  private signature: string
  private separator: string
  private tag: string

  constructor(env: Env) {
    this.env = env
    this.octokit = github.getOctokit(this.env.api_token)

    this.signature = `GitHub Action status on ${this.env.head_commit} generated by comment-failure-action`
    this.separator = '\n<!-- SEPARATOR -->\n'
    this.tag = `<!-- WORKFLOW:${this.env.workflow} -->`
  }

  async run(): Promise<void> {
    if (!this.is_pull_request()) {
      core.info('Invoked without pull request')
      return
    }

    const prs = await this.find_pull_requests()
    if (prs.length === 0) {
      core.info(
        `No open pull requests found with ${this.env.head_branch} branch`
      )
      return
    }

    const failed_runs = await this.find_failed_check_runs()
    const section = this.generate_section(failed_runs)

    for (const pr of prs) {
      const comment = await this.find_comment(pr)
      if (comment) {
        await this.update_comment(comment, section)
        core.info('Updated comment')
        await this.add_label(pr)
      } else if (failed_runs.length > 0) {
        await this.create_comment(pr, section)
        core.info('Created comment')
        await this.add_label(pr)
      }
    }
  }

  is_pull_request(): boolean {
    return (
      this.env.head_branch !== undefined &&
      this.env.head_branch !== null &&
      this.env.head_branch !== ''
    )
  }

  generate_section(failed_runs: CheckRun[]): string {
    const strings: string[] = []

    strings.push(this.tag)
    strings.push(`### ${this.env.workflow}`)

    if (failed_runs.length === 0) {
      strings.push('No jobs failed :+1:')
    } else {
      strings.push('| job | url |')
      strings.push('|-----|-----|')

      for (const failed_run of failed_runs) {
        const job = failed_run.output.title
        const url = failed_run.html_url
        strings.push(`| ${job} | ${url} |`)
      }
    }

    return strings.join('\n')
  }

  async find_pull_requests(): Promise<PullRequest[]> {
    return (await this.octokit.paginate(this.octokit.pulls.list, {
      owner: this.env.owner,
      repo: this.env.repo,
      state: 'open',
      head: `${this.env.owner}:${this.env.head_branch}`
    })) as PullRequest[]
  }

  async find_failed_check_runs(): Promise<CheckRun[]> {
    const response = await this.octokit.paginate(
      this.octokit.checks.listForSuite,
      {
        owner: this.env.owner,
        repo: this.env.repo,
        check_suite_id: this.env.check_suite_id,
        status: 'completed'
      }
    )
    return response.filter(check_run => {
      return (
        check_run.conclusion !== 'success' && check_run.conclusion !== 'neutral'
      )
    }) as CheckRun[]
  }

  async find_comment(pr: PullRequest): Promise<IssueComment | null> {
    const comments = await this.octokit.paginate(
      this.octokit.issues.listComments,
      {
        owner: this.env.owner,
        repo: this.env.repo,
        issue_number: pr.number
      }
    )
    return comments.find(
      c => c.body !== undefined && c.body.includes(this.signature)
    ) as IssueComment | null
  }

  async update_comment(comment: IssueComment, section: string): Promise<void> {
    const old_sections = this.split_body(comment.body)
    const new_sections = this.replace_or_append_section(section, old_sections)
    const body = this.generate_body(new_sections)

    await this.octokit.issues.updateComment({
      owner: this.env.owner,
      repo: this.env.repo,
      comment_id: comment.id,
      body
    })
  }
  
 async add_label(pr: PullRequest): Promise<void> {

    await this.octokit.issues.addLabels({
      owner: this.env.owner,
      repo: this.env.repo,
      issue_number: pr.number,
      labels: "waiting-response"
    })
  }

  async create_comment(pr: PullRequest, section: string): Promise<void> {
    const body = this.generate_body([section])

    await this.octokit.issues.createComment({
      owner: this.env.owner,
      repo: this.env.repo,
      issue_number: pr.number,
      body
    })
  }

  split_body(body: string): string[] {
    return body
      .split(this.separator)
      .filter((section: string) => !section.includes(this.signature))
  }

  replace_or_append_section(section: string, old_sections: string[]): string[] {
    let replaced = false

    const new_sections = old_sections.map((old_section: string) => {
      if (old_section.includes(this.tag)) {
        replaced = true
        return section
      } else {
        return old_section
      }
    })

    if (!replaced) {
      new_sections.push(section)
    }

    return new_sections
  }

  generate_body(sections: string[]): string {
    return [this.signature].concat(sections).join(this.separator)
  }
}
