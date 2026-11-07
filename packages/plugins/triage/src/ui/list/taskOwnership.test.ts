import { expect, it } from 'vitest';
import { TriageSourceEntrySnapshotV1Schema } from '@happier-dev/triage-protocol/v1';
import { projectLinearIssue } from '../../../../linear/src/source.js';
import { issue as linearIssue } from '../../../../linear/src/fixtures.test-support.js';
import { projectJiraIssue, readJiraIssue } from '../../../../jira/src/source/model.js';
import { decodeGithubSearchItem, projectGithubEntry } from '../../../../scm-github/src/triage/mapping/entry.js';
import { toTriageSnapshot } from '../../../../scm-github/src/triage/mapping/protocol.js';
import { GITHUB_SEARCH_ISSUE_ITEM, GITHUB_FIXTURE_REPOSITORY_ID } from '../../../../scm-github/src/triage/__fixtures__/githubResponses.js';

it('carries source-owned assignment independently of authorship, including unassigned and unknown', () => {
  for (const [assignee, expected] of [[{ id: 'owner', name: 'Mara' }, 'Mara'], [null, null]] as const) {
    expect.soft(projectLinearIssue({ ...linearIssue, assignee }, 'viewer').snapshot).toHaveProperty('assigneeLabel', expected);
    const jira = readJiraIssue({ id: '1', key: 'TASK-1', fields: { project: { id: '1', name: 'Project' },
      summary: 'Task', status: { name: 'To do', statusCategory: { key: 'new' } },
      assignee: assignee === null ? null : { accountId: assignee.id, displayName: assignee.name } } })!;
    expect.soft(projectJiraIssue(jira, 'https://example.atlassian.net', 'viewer').snapshot).toHaveProperty('assigneeLabel', expected);
    const github = projectGithubEntry(decodeGithubSearchItem({ ...GITHUB_SEARCH_ISSUE_ITEM,
      assignees: assignee === null ? [] : [{ login: assignee.name }] })!, GITHUB_FIXTURE_REPOSITORY_ID)!;
    expect.soft(TriageSourceEntrySnapshotV1Schema.parse(toTriageSnapshot(github.snapshot, github.locator, github.localRef.entryId)))
      .toHaveProperty('assigneeLabel', expected);
  }
  const jira = readJiraIssue({ id: '1', key: 'TASK-1', fields: { project: { id: '1' }, summary: 'Task' } })!;
  expect(projectJiraIssue(jira, 'https://example.atlassian.net', 'viewer').snapshot).not.toHaveProperty('assigneeLabel');
});
