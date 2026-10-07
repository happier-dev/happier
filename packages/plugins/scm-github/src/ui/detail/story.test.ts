import { describe, expect, it } from 'vitest';

import { githubCheckToneV1, githubOverviewStatusToneV1 } from './story.js';

describe('the tone of one GitHub check row', () => {
  it('keeps neutral and unreported completed outcomes distinct from failures', () => {
    const row = { key: 'github-check-run:1', resourceKind: 'check-run' as const, name: 'build', status: 'completed' };
    expect(githubCheckToneV1({ ...row, conclusion: 'skipped' })).toBe('neutral');
    expect(githubCheckToneV1({ ...row, conclusion: 'unrecognized' })).toBe('neutral');
    expect(githubCheckToneV1(row)).toBe('neutral');
    expect(githubCheckToneV1({ ...row, conclusion: 'failure' })).toBe('danger');
  });

  it('lets a passed or running check say nothing: only a failure is coloured', () => {
    const row = { key: 'github-check-run:1', resourceKind: 'check-run' as const, name: 'build', status: 'completed' };
    expect(githubCheckToneV1({ ...row, conclusion: 'success' })).toBe('neutral');
    expect(githubCheckToneV1({ ...row, status: 'in_progress' })).toBe('neutral');
  });
});

describe('the tone of the GitHub overview state', () => {
  it('keeps open and merged quiet, a draft quieter, and never colours a healthy state', () => {
    expect(githubOverviewStatusToneV1('Open')).toBe('secondary');
    expect(githubOverviewStatusToneV1('Merged')).toBe('secondary');
    expect(githubOverviewStatusToneV1('Draft')).toBe('muted');
    expect(githubOverviewStatusToneV1('Closed')).toBe('neutral');
  });
});
