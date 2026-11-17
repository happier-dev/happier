import { expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionOutputDiagnostic } from './executor/actionFailureDiagnostic.js';

const transportError = () => Object.assign(new TypeError('Transport response lost'), { code: 'ECONNRESET' });
const context = { surface: 'ui', authority: 'present_user', bypassApprovals: true, defaultSessionId: 's1' } as const;
const startContext = {
  caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'm1', directory: '/workspace' }, ledSubtreeSessionIds: [], workDepthLimit: 4,
  roles: {}, callerPermissionCeiling: 'read-only',
} as const;

it('records the wait cause while retaining the already-started Run identity', async () => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({ recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    resolveAgentStartContext: async () => startContext,
    executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'm1' }),
    executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
    executionRunWait: async () => { throw transportError(); },
  });
  const result = await executor.execute('execution.run.start', { sessionId: 's1', intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Do it', permissionMode: 'read_only',
    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', waitForCompletion: true }, context);
  expect(result).toEqual({ ok: true, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
    wait: { ok: false, code: 'execution_run_failed' } } });
  expect(diagnostics).toMatchObject([{ source: 'action.execution_run.start.wait',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNRESET' } }]);
});

it('records report discovery failure while retaining the successful lead archive', async () => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({ recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    sessionArchiveSet: async () => ({ ok: true }), sessionList: async () => { throw transportError(); },
  });
  const result = await executor.execute('session.archive', { sessionId: 's1', alsoArchiveReports: true }, context);
  expect(result).toMatchObject({ ok: true, result: { success: true, sessionId: 's1', reports: [], reportsError: {
    errorCode: expect.any(String), error: 'Transport response lost',
  } } });
  expect(JSON.stringify(result)).not.toContain('failureCause');
  expect(diagnostics).toMatchObject([{ source: 'action.session_archive.reports',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNRESET' } }]);
});

it.each(['start', 'narration'] as const)('records a review %s transport failure inside the existing aggregate result', async phase => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({ recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    resolveAgentStartContext: async () => startContext,
    reviewEnginesList: async () => ({ items: ['codex', 'claude'].map(value => ({ value, label: value,
      capabilities: { structuredNarration: true } })) }),
    executionRunStart: async () => {
      if (phase === 'start') throw transportError();
      return { runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' };
    },
    executionRunAction: async () => { throw transportError(); },
  });
  const result = await executor.execute('review.start', { sessionId: 's1', engineIds: ['codex', 'claude'],
    instructions: 'Review', outputs: ['walkthrough'], comparisonId: 'comparison-1' }, context);
  expect(result).toMatchObject({ ok: true, result: { narration: { state: 'failed' } } });
  expect(JSON.stringify(result)).not.toContain('failureCause');
  expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
    source: phase === 'start' ? 'action.execution_run.fanout.start' : 'action.review.narration',
    failureCause: expect.objectContaining({ errorClass: 'TypeError', errorCode: 'ECONNRESET' }),
  })]));
});
