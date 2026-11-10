import { describe, expect, it } from 'vitest';

import { githubCheckStatusKindV1, githubOverviewStatusToneV1 } from './story.js';

describe('the mark of one GitHub check row', () => {
  it('draws each GitHub status and conclusion as the shared check mark, never a failure as anything else', () => {
    const row = { key: 'github-check-run:1', resourceKind: 'check-run' as const, name: 'build', status: 'completed' };
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'success' })).toBe('passed');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'failure' })).toBe('failed');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'timed_out' })).toBe('failed');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'skipped' })).toBe('skipped');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'cancelled' })).toBe('cancelled');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'neutral' })).toBe('neutral');
    expect(githubCheckStatusKindV1({ ...row, conclusion: 'unrecognized' })).toBe('unknown');
    expect(githubCheckStatusKindV1({ ...row, status: 'queued' })).toBe('queued');
    expect(githubCheckStatusKindV1({ ...row, status: 'waiting' })).toBe('waiting');
    expect(githubCheckStatusKindV1({ ...row, status: 'in_progress' })).toBe('running');
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
