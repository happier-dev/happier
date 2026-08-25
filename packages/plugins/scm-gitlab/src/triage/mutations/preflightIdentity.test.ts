import { describe, expect, it } from 'vitest';

import { gitlabMutationRowMatchesRouteV1 } from './preflight.js';

describe('gitlabMutationRowMatchesRouteV1', () => {
  it('requires full project identity even when the IID matches', () => {
    expect(gitlabMutationRowMatchesRouteV1(
      { projectId: 99, iid: '7' },
      { projectId: 3, iid: '7' },
    )).toBe(false);
    expect(gitlabMutationRowMatchesRouteV1(
      { projectId: 3, iid: '7' },
      { projectId: 3, iid: '7' },
    )).toBe(true);
  });
});
