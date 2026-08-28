import { describe, expect, it } from 'vitest';

import { gitlabChangesEvidenceUrlV1 } from './changeEvidence.js';

describe('GitLab change evidence links', () => {
  it('derives provider-owned structured evidence from the admitted MR URL', () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/7';
    expect(gitlabChangesEvidenceUrlV1(url)).toBe(`${url}/diffs`);
  });

  it('refuses a non-HTTP locator instead of inventing a route', () => {
    expect(gitlabChangesEvidenceUrlV1('not a url')).toBeNull();
  });

  it('does not carry locator query or fragment bytes into the evidence route', () => {
    expect(gitlabChangesEvidenceUrlV1(
      'https://gitlab.com/group/project/-/merge_requests/7?view=parallel#note_1',
    )).toBe('https://gitlab.com/group/project/-/merge_requests/7/diffs');
  });
});
