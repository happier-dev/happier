import { describe, expect, it } from 'vitest';

import { gitlabChangesEvidenceUrlV1, gitlabRawDiffEvidenceUrlV1 } from './changeEvidence.js';

describe('GitLab change evidence links', () => {
  it('derives provider-owned raw and structured evidence from the admitted MR URL', () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/7';
    expect(gitlabRawDiffEvidenceUrlV1(url)).toBe(`${url}.diff`);
    expect(gitlabChangesEvidenceUrlV1(url)).toBe(`${url}/diffs`);
  });

  it('refuses a non-HTTP locator instead of inventing a route', () => {
    expect(gitlabRawDiffEvidenceUrlV1('file:///tmp/7')).toBeNull();
    expect(gitlabChangesEvidenceUrlV1('not a url')).toBeNull();
  });

  it('does not carry locator query or fragment bytes into the evidence route', () => {
    expect(gitlabRawDiffEvidenceUrlV1(
      'https://gitlab.com/group/project/-/merge_requests/7?view=parallel#note_1',
    )).toBe('https://gitlab.com/group/project/-/merge_requests/7.diff');
  });
});
