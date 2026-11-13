import { describe, expect, it } from 'vitest';

import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';

import { buildExecutionRunPrompt } from './buildExecutionRunPrompt';

const start: ExecutionRunProfileStartParams = {
  sessionId: 'sess_1',
  runId: 'run_1',
  callId: 'call_1',
  sidechainId: 'call_1',
  intent: 'review',
  backendId: 'claude',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  instructions: 'Review the plan.',
  permissionMode: 'read_only',
  retentionPolicy: 'resumable',
  runClass: 'bounded',
  ioMode: 'streaming',
  startedAtMs: 1,
};

describe('buildExecutionRunPrompt', () => {
  it.each(['review', 'plan', 'delegate'] as const)('keeps a roleless %s prompt byte-identical to the profile prompt', (intent) => {
    const profile = resolveExecutionRunIntentProfile(intent);
    expect(buildExecutionRunPrompt(profile, { ...start, intent })).toBe(profile.buildPrompt({ ...start, intent }));
  });

  it('puts the run-scoped role block first and keeps the caller instructions and output contract after it', () => {
    const profile = resolveExecutionRunIntentProfile('review');
    const prompt = buildExecutionRunPrompt(profile, {
      ...start,
      role: { id: 'reviewer', name: 'Reviewer', instructions: 'Independently compare the request with the candidate.' },
    });
    const profilePrompt = profile.buildPrompt(start);
    expect(prompt.startsWith('Current run role: Reviewer\n\nIndependently compare the request with the candidate.\n\n')).toBe(true);
    expect(prompt.endsWith(profilePrompt)).toBe(true);
    expect(prompt).toContain('applies to this run only');
    expect(prompt).not.toContain('until this session is reassigned');
    expect(prompt.match(/Current run role:/g)).toHaveLength(1);
  });
});
