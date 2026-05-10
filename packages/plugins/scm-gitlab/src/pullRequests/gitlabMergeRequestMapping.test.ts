import type { ScmHostingProviderRef } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { mapGitlabMergeRequest } from './gitlabMergeRequestMapping.js';

const provider: ScmHostingProviderRef = {
  id: 'scm.gitlab',
  kind: 'gitlab',
  displayName: 'GitLab',
  baseUrl: 'https://gitlab.com',
  nameWithOwner: 'happier-dev/mobile/app',
  urlSafety: { allowedSchemes: ['https:'] },
};

describe('GitLab merge request mapping', () => {
  it('maps GitLab MR fields to canonical pull request summary fields', async () => {
    expect(mapGitlabMergeRequest(provider, {
      iid: 17,
      id: 9917,
      title: 'Add GitLab MRs',
      web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
      source_branch: 'feature/gitlab-mrs',
      target_branch: 'main',
      state: 'opened',
      description: 'body should not appear in summaries',
    })).toEqual({
      provider,
      number: 17,
      providerNativeId: '9917',
      title: 'Add GitLab MRs',
      url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
      baseBranch: 'main',
      headBranch: 'feature/gitlab-mrs',
      state: 'open',
    });
  });

  it('maps closed merged and unknown states without throwing', async () => {
    const basePayload = {
      iid: 18,
      title: 'Stateful MR',
      web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/18',
      source_branch: 'feature/state',
      target_branch: 'main',
    };

    expect(mapGitlabMergeRequest(provider, { ...basePayload, state: 'closed' })).toMatchObject({ state: 'closed' });
    expect(mapGitlabMergeRequest(provider, { ...basePayload, state: 'merged' })).toMatchObject({ state: 'merged' });
    expect(mapGitlabMergeRequest(provider, { ...basePayload, state: 'locked' })).toMatchObject({ state: 'unknown' });
  });

  it('returns null for invalid payloads and includes description only for detail mapping', async () => {
    expect(mapGitlabMergeRequest(provider, {
      iid: '17',
      title: 'Invalid MR',
      web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
      source_branch: 'feature/gitlab-mrs',
      target_branch: 'main',
      state: 'opened',
    })).toBeNull();

    expect(mapGitlabMergeRequest(provider, {
      iid: 19,
      title: 'Detailed MR',
      web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/19',
      source_branch: 'feature/detail',
      target_branch: 'main',
      state: 'opened',
      description: 'detailed body',
    }, { includeDescription: true })).toMatchObject({
      description: 'detailed body',
    });
  });
});
