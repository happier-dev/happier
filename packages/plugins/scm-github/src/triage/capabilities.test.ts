import { describe, expect, it } from 'vitest';

import { projectGithubRepositoryCapabilities } from './capabilities.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import { GithubCapabilitiesResultV1Schema, GithubOverviewResultV1Schema } from './detail/contracts.js';

const readable = {
  kind: 'readable' as const,
  repositoryId: '4210',
  repositoryKey: 'octo-org/example-app',
  mergeSettings: { merge: true, squash: false, rebase: null },
  archived: false,
  hasIssues: true,
};

describe('GitHub repository capability projection', () => {
  it('reads capabilities and PR Overview from a daemon that predates preview publication', () => {
    const operations = Object.fromEntries(Object.entries(projectGithubRepositoryCapabilities(readable).operations)
      .filter(([key]) => key !== 'pullRequestPreviewStatus'));
    const capabilities = { kind: 'capabilities' as const, operations,
      mergeMethods: projectGithubRepositoryCapabilities(readable).mergeMethods };
    expect(GithubCapabilitiesResultV1Schema.parse(capabilities)).toEqual(capabilities);
    const overview = { kind: 'overview', kindId: 'pull-request', observedAtMs: 1,
      branchUpdateEligibility: 'unknown', capabilities };
    expect(GithubOverviewResultV1Schema.parse(overview)).toEqual(overview);
  });
  it('accepts the complete producer projection in both capability and overview reads while refusing undeclared operations', () => {
    const capabilities = { kind: 'capabilities' as const, ...projectGithubRepositoryCapabilities(readable) };
    expect(GithubCapabilitiesResultV1Schema.parse(capabilities)).toEqual(capabilities);
    const overview = { kind: 'overview', kindId: 'pull-request', observedAtMs: 1,
      branchUpdateEligibility: 'unknown', capabilities };
    expect(GithubOverviewResultV1Schema.parse(overview)).toEqual(overview);
    const unknown = { ...capabilities, operations: { ...capabilities.operations, undeclaredOperation: { kind: 'available' } } };
    expect(GithubCapabilitiesResultV1Schema.safeParse(unknown).success).toBe(false);
    expect(GithubOverviewResultV1Schema.safeParse({ ...overview, capabilities: unknown }).success).toBe(false);
  });
  it('projects every declared mutation and keeps issue relationships unavailable when issues are disabled', () => {
    const result = projectGithubRepositoryCapabilities(readable);
    expect(Object.keys(result.operations).sort()).toEqual(Object.keys(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1).sort());
    const disabled = projectGithubRepositoryCapabilities({ ...readable, hasIssues: false });
    expect(disabled.operations.subIssueAdd).toEqual({ kind: 'unavailable', code: 'repository_unsupported' });
    expect(disabled.operations.projectItemAdd).toEqual({ kind: 'available' });
  });
  it('suppresses only merge methods GitHub explicitly disabled', () => {
    const result = projectGithubRepositoryCapabilities(readable);
    expect(result.mergeMethods).toEqual({
      merge: { kind: 'available' },
      squash: { kind: 'unavailable', code: 'repository_unsupported' },
      rebase: { kind: 'available' },
    });
    expect(result).toHaveProperty('mergeSettings', { merge: true, squash: false, rebase: null });
  });

  it('denies every write when GitHub says the repository is archived', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, archived: true });
    expect(Object.values(result.operations).every((value) =>
      value.kind === 'denied' && value.code === 'repository_archived')).toBe(true);
  });

  it('leaves issue controls available when issue availability was omitted', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, hasIssues: null });
    expect(result.operations.issueComment).toEqual({ kind: 'available' });
  });

  it('keeps item operations available without a decisive repository prohibition', () => {
    const result = projectGithubRepositoryCapabilities(readable);
    expect(result.operations.pullRequestSubmitReview).toEqual({ kind: 'available' });
    expect(result.operations.pullRequestReviewCommentCreate).toEqual({ kind: 'available' });
    expect(result.operations.pullRequestMerge).toEqual({ kind: 'available' });
  });

  it('exposes native queue and auto-merge operations through the same repository capability owner', () => {
    const result = projectGithubRepositoryCapabilities(readable);
    expect(result.operations).toMatchObject({
      pullRequestEnqueue: { kind: 'available' },
      pullRequestDequeue: { kind: 'available' },
      pullRequestAutoMergeSet: { kind: 'available' },
    });
    const denied = projectGithubRepositoryCapabilities({ ...readable, archived: true });
    expect(denied.operations).toMatchObject({
      pullRequestEnqueue: { kind: 'denied', code: 'repository_archived' },
      pullRequestDequeue: { kind: 'denied', code: 'repository_archived' },
      pullRequestAutoMergeSet: { kind: 'denied', code: 'repository_archived' },
    });
  });

  it('does not infer a prohibition when GitHub omitted archive state', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, archived: null });
    expect(result.operations.pullRequestClose).toEqual({ kind: 'available' });
  });

  it('keeps issue unavailability local to issue operations', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, hasIssues: false });
    expect(result.operations.issueComment).toEqual({
      kind: 'unavailable',
      code: 'repository_unsupported',
    });
    expect(result.operations.pullRequestSubmitReview).toEqual({ kind: 'available' });
  });

  it('keeps PR label and assignee deltas available when the repository disabled issues', () => {
    const repository = { ...readable, hasIssues: false };
    const pr = projectGithubRepositoryCapabilities(repository, 'pull-request');
    const issue = projectGithubRepositoryCapabilities(repository, 'issue');
    for (const name of ['issueLabelAdd', 'issueLabelRemove', 'issueAssigneeAdd', 'issueAssigneeRemove'] as const) {
      expect(pr.operations[name]).toEqual({ kind: 'available' });
      expect(issue.operations[name]).toEqual({ kind: 'unavailable', code: 'repository_unsupported' });
    }
  });
});
