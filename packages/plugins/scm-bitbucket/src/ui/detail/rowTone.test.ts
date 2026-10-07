import { describe, expect, it } from 'vitest';

import { bitbucketBuildToneV1 } from './rowTone.js';

describe('the tone of one Bitbucket build status row', () => {
  it('colours only a failed build: a successful or running one says nothing', () => {
    const row = { key: 'build-1', name: 'build' };
    expect(bitbucketBuildToneV1({ ...row, state: 'FAILED' })).toBe('danger');
    expect(bitbucketBuildToneV1({ ...row, state: ' error ' })).toBe('danger');
    expect(bitbucketBuildToneV1({ ...row, state: 'SUCCESSFUL' })).toBe('neutral');
    expect(bitbucketBuildToneV1({ ...row, state: 'INPROGRESS' })).toBe('neutral');
    expect(bitbucketBuildToneV1({ ...row, state: 'STOPPED' })).toBe('neutral');
  });
});
