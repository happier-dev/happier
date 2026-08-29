import { describe, expect, it } from 'vitest';

import { projectGithubRepositoryCapabilities } from './capabilities.js';

const readable = {
  kind: 'readable' as const,
  repositoryId: '4210',
  mergeSettings: { merge: true, squash: false, rebase: null },
  archived: false,
  hasIssues: true,
};

describe('GitHub repository capability projection', () => {
  it('suppresses only merge methods GitHub explicitly disabled', () => {
    const result = projectGithubRepositoryCapabilities(readable);
    expect(result.mergeMethods).toEqual({
      merge: { kind: 'available' },
      squash: { kind: 'unavailable', code: 'repository_unsupported' },
      rebase: { kind: 'available' },
    });
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
});
