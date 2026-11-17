import { expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionOutputDiagnostic } from './executor/actionFailureDiagnostic.js';

it.each(['ECONNRESET', 'PRIVATE_EXTERNAL_CODE'])('records a thrown interception cause without changing its public refusal (%s)', async code => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    // The external plugin hook is the failing boundary.
    interceptActionExecution: async () => { throw Object.assign(new TypeError('PRIVATE_HOOK_RESPONSE'), { code }); },
  });
  const result = await executor.execute('session.read_state.set', { sessionId: 'session-1', state: 'read' }, {
    surface: 'cli', authority: 'present_user', bypassApprovals: true,
  });
  expect(result).toEqual({ ok: false, errorCode: 'action_interception_failed', error: 'action_interception_failed',
    details: { code: 'plugin_hook_handler_failed' } });
  expect(diagnostics).toMatchObject([{ source: 'action.interception',
    failureCause: { errorClass: 'TypeError', errorCode: code === 'ECONNRESET' ? code : null } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});

it.each(['ECONNRESET', 'PRIVATE_EXTERNAL_CODE'])('records a dispatched plugin Session input cause behind the existing unknown outcome (%s)', async code => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
    // Session message transport is the external boundary.
    sessionSendMessage: async () => { throw Object.assign(new TypeError('PRIVATE_SESSION_RESPONSE'), { code }); },
  });
  const result = await executor.execute('session.message.send', {
    sessionId: 's1', message: 'Hello', idempotencyKey: 'message-42',
  }, { surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'acme.channels', contributionLocalId: 'inbound' } });
  expect(result).toEqual({ ok: true, result: { status: 'outcomeUnknown',
    localId: 'plugin-input-v1:39j_qcTWrVcq__rGFFM0w0Qlbv2PLRf6Iq32ot1bYcY', code: 'session_input_action_execution_failed' } });
  expect(diagnostics).toMatchObject([{ source: 'action.plugin_session_input.dispatch',
    failureCause: { errorClass: 'TypeError', errorCode: code === 'ECONNRESET' ? code : null } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});
