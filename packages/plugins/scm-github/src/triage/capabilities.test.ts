import { describe, expect, it } from 'vitest';

import { projectGithubRepositoryCapabilities } from './capabilities.js';

const readable = {
  kind: 'readable' as const,
  repositoryId: '4210',
  mergeSettings: { merge: true, squash: false, rebase: null },
  archived: false,
  hasIssues: true,
  viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
};

describe('GitHub repository capability projection', () => {
  it('publishes only explicitly enabled merge methods', () => {
    const result = projectGithubRepositoryCapabilities(readable, 'pull-request');
    expect(result.mergeMethods).toEqual({
      merge: { kind: 'available' },
      squash: { kind: 'unavailable', code: 'repository_unsupported' },
      rebase: { kind: 'unavailable', code: 'api_not_exposed' },
    });
  });

  it('denies every write when GitHub says the repository is archived', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, archived: true }, 'issue');
    expect(Object.values(result.operations).every((value) =>
      value.kind === 'denied' && value.code === 'repository_archived')).toBe(true);
  });

  it('fails issue controls closed when issue availability was omitted', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, hasIssues: null }, 'issue');
    expect(result.operations.issueComment).toEqual({ kind: 'unavailable', code: 'api_not_exposed' });
  });

  it('fails authority closed when GitHub omitted viewer permissions', () => {
    const result = projectGithubRepositoryCapabilities({
      ...readable,
      viewerPermissions: { admin: null, maintain: null, push: null, triage: null, pull: true },
    }, 'pull-request');
    expect(result.operations.pullRequestMerge).toEqual({ kind: 'unavailable', code: 'api_not_exposed' });
  });

  it('fails writes closed when GitHub omitted archive state', () => {
    const result = projectGithubRepositoryCapabilities({ ...readable, archived: null }, 'pull-request');
    expect(result.operations.pullRequestClose).toEqual({ kind: 'unavailable', code: 'api_not_exposed' });
  });
});
