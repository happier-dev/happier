import { describe, expect, it } from 'vitest';

import { findCompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { EXECUTION_RUN_WAIT_PRESENTATION } from './executionRunPresentation';

describe('execution Run wait presentation', () => {
  it.each(['needs_attention', 'snapshot', 'observation_timeout'] as const)('preserves the actual Run snapshot for %s', async (disposition) => {
    const command = findCompiledActionCliCommand(['session', 'run', 'wait']);
    if (!command) throw new Error('Missing canonical wait command');
    const run = {
      runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: disposition === 'observation_timeout' ? 'succeeded' : 'running', startedAtMs: 1,
      ...(disposition === 'needs_attention' ? { attention: { kind: 'permission_required', requestIds: ['permission-1'] } } : {}),
    };
    const output = captureConsoleJsonOutput();
    try {
      await EXECUTION_RUN_WAIT_PRESENTATION.presentSuccess?.({ ok: true, status: run.status,
        disposition, result: { run }, ...(disposition === 'observation_timeout'
          ? { runId: run.runId, timeoutMs: 1_000, observedAtMs: 1_000, deadlineAtMs: 1_000 } : {}) }, {
        command, json: true, input: { sessionId: 'session-1', runId: run.runId }, callerInput: {},
      });
      expect(output.json()).toMatchObject({ ok: true, data: { sessionId: 'session-1', runId: run.runId,
        status: run.status, disposition, result: { run } } });
      if (disposition !== 'observation_timeout') expect(output.json()).not.toMatchObject({ data: { disposition: 'observation_timeout' } });
    } finally { output.restore(); }
  });
});
