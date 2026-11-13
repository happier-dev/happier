import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';

import { runBoundedCompletionWithRepair } from './runBoundedCompletionWithRepair';

const start: ExecutionRunProfileStartParams = {
  sessionId: 'sess_1',
  runId: 'run_1',
  callId: 'call_1',
  sidechainId: 'call_1',
  intent: 'delegate',
  backendId: 'claude',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  instructions: 'Do it.',
  permissionMode: 'workspace_write',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
  startedAtMs: 1,
};

const valid = JSON.stringify({ summary: 'Done.', deliverables: [{ id: 'd1', title: 'Deliverable' }] });

describe('runBoundedCompletionWithRepair', () => {
  it('completes a profile-valid output without a repair turn', async () => {
    const runRepairTurn = vi.fn(async (_prompt: string) => valid);
    const result = await runBoundedCompletionWithRepair({
      profile: resolveExecutionRunIntentProfile('delegate'), start, rawText: valid, finishedAtMs: 5, runRepairTurn,
    });
    expect(result.completion.status).toBe('succeeded');
    expect(result.repaired).toBe(false);
    expect(runRepairTurn).not.toHaveBeenCalled();
  });

  it('runs exactly one intent-specific repair turn for invalid structured output', async () => {
    const runRepairTurn = vi.fn(async (_prompt: string) => valid);
    const result = await runBoundedCompletionWithRepair({
      profile: resolveExecutionRunIntentProfile('delegate'), start, rawText: 'Prose without the contract.', finishedAtMs: 5, runRepairTurn,
    });
    expect(runRepairTurn).toHaveBeenCalledTimes(1);
    expect(runRepairTurn.mock.calls[0]![0]).toContain('Return ONLY valid JSON');
    expect(runRepairTurn.mock.calls[0]![0]).toContain('Prose without the contract.');
    expect(result.completion.status).toBe('succeeded');
    expect(result.repaired).toBe(true);
  });

  it('fails after the single repair when the repaired output is still invalid', async () => {
    const runRepairTurn = vi.fn(async (_prompt: string) => 'Still prose.');
    const result = await runBoundedCompletionWithRepair({
      profile: resolveExecutionRunIntentProfile('delegate'), start, rawText: 'Prose.', finishedAtMs: 5, runRepairTurn,
    });
    expect(runRepairTurn).toHaveBeenCalledTimes(1);
    expect(result.completion.status).toBe('failed');
  });
});
