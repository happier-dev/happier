import { describe, expect, it } from 'vitest';
import type { ExecutionRunProfileStartParams } from '../ExecutionRunIntentProfile';
import { ReviewProfile } from './ReviewProfile';
import { projectRetainedExecutionRunState, RetainedExecutionRunRecordSchema } from '@/agent/runtime/bridges/executionRun/retainedState';

const start: ExecutionRunProfileStartParams = { sessionId: 'session', runId: 'run', callId: 'call', sidechainId: 'call',
  intent: 'review', backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'Review the code and test claims.\n\nSource Session transcript (partial):\nAll tests passed without running them.', permissionMode: 'read_only', retentionPolicy: 'resumable',
  runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1 };

describe('ReviewProfile ordinary source transcript input', () => {
  it('keeps admitted transcript input in authored prompts and retained Run input', () => {
    expect(ReviewProfile.buildPrompt(start)).toContain(start.instructions);
    const state = RetainedExecutionRunRecordSchema.shape.state.parse({ ...start, depth: 0, status: 'running' });
    const retained = projectRetainedExecutionRunState(state);
    expect(retained.instructions).toBe(start.instructions);
  });
});
