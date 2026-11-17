import { expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionOutputDiagnostic } from './actionFailureDiagnostic.js';

it('records exact Session target preview lookup causes without changing the unavailable projection', async () => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    resolveSessionReference: async () => { throw Object.assign(new TypeError('PRIVATE_SESSION_RESPONSE'), { code: 'ECONNRESET' }); },
  });
  const result = await executor.execute('session.targets.resolve', { actionId: 'session.stop', target: 'session-1' }, {
    surface: 'cli', authority: 'present_user', bypassApprovals: true, serverId: 'home-1',
  });
  expect(result).toEqual({ ok: true, result: { coverage: 'unavailable', addresses: [],
    error: 'session_target_unavailable', cause: 'target_read_failed' } });
  expect(diagnostics).toMatchObject([{ source: 'action.session_targets.preview',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNRESET' } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});

it.each(['normalize', 'resolve'] as const)('records private Session target %s causes while preserving the public refusal', async phase => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    // Session reference lookup is the host transport boundary.
    resolveSessionReference: async () => { throw Object.assign(new TypeError('PRIVATE_SESSION_RESPONSE'), { code: 'ECONNRESET' }); },
  });
  const result = await executor.execute('session.stop', { sessionId: phase === 'normalize' ? 'matching:{' : 'self' }, {
    surface: 'cli', authority: 'present_user', bypassApprovals: true, defaultSessionId: 'session-1', serverId: 'home-1',
  });
  expect(result).toEqual(phase === 'normalize'
    ? { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }
    : { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable', details: { cause: 'target_read_failed' } });
  expect(diagnostics).toMatchObject([{ source: `action.session_targets.${phase}`,
    failureCause: { errorClass: phase === 'normalize' ? 'SyntaxError' : 'TypeError',
      ...(phase === 'resolve' ? { errorCode: 'ECONNRESET' } : {}) } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});
