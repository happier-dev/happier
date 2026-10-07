import { describe, expect, it } from 'vitest';

import { githubCheckToneV1 } from './story.js';

describe('the tone of one GitHub check row', () => {
  it('keeps neutral and unreported completed outcomes distinct from failures', () => {
    const row = { key: 'github-check-run:1', resourceKind: 'check-run' as const, name: 'build', status: 'completed' };
    expect(githubCheckToneV1({ ...row, conclusion: 'skipped' })).toBe('neutral');
    expect(githubCheckToneV1({ ...row, conclusion: 'unrecognized' })).toBe('neutral');
    expect(githubCheckToneV1(row)).toBe('neutral');
    expect(githubCheckToneV1({ ...row, conclusion: 'failure' })).toBe('danger');
  });
});

