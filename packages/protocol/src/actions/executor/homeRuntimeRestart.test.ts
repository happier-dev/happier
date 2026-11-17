import { expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionOutputDiagnostic } from './actionFailureDiagnostic.js';

it.each(['detect', 'start', 'wait'] as const)('retains a private restart %s cause through terminal settlement', async phase => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  // Connected-Machine capability RPC is the external boundary.
  const executor = createActionExecutor({
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    homeRuntimeTaskRpc: async request => {
      const step = request.method === 'detect' ? 'detect' : request.request.method;
      if (step === phase) throw Object.assign(new TypeError('PRIVATE_RESTART_RESPONSE'), { code: 'ECONNRESET' });
      if (step === 'detect') return { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true,
        data: { available: true, methods: ['start', 'wait'], kinds: ['relay.runtime.restart.v1'] } } } };
      return { ok: true, result: { taskId: 'restart-task' } };
    },
  });
  const result = await executor.execute('home.runtime.restart', { machineId: 'machine' }, {
    surface: 'cli', authority: 'present_user', bypassApprovals: true,
  });
  expect(result).toEqual({ ok: true, result: phase === 'detect'
    ? { status: 'unavailable', reason: 'system_tasks_unavailable' }
    : { status: 'outcome_unknown', ...(phase === 'wait' ? { taskId: 'restart-task' } : {}) } });
  expect(diagnostics).toMatchObject([{ source: `home.runtime.restart.${phase}`,
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNRESET' } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});
