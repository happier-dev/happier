import { expect, it } from 'vitest';
import { createPluginSurfaceActionFailureError, projectClientActionInvocationFailure, clientActionPreparationFailure } from './actionFailure';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { triageTaskWriteInvocationFailureV1 } from '../../../../../../packages/plugins/triage/src/actions/taskWriteFailure';

it.each([
    { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' },
    { status: 'failed', code: 'plugin_action_current_intent_unavailable' },
    { status: 'unavailable', code: 'plugin_action_current_intent_rejected' },
    { status: 'failed', code: 'plugin_action_current_intent_rejected' },
] as const)('classifies a proven pre-handler client $status $code as refused', ({ status, code }) => {
    const outcome = projectClientActionInvocationFailure({ status,
        code, message: code,
        actionHandlerInvocation: 'notStarted' }, { readOnly: false }, {});
    expect(triageTaskWriteInvocationFailureV1(createPluginSurfaceActionFailureError(outcome)))
        .toEqual({ kind: 'refused', reason: code });
});

it('retains a host-proven preparation refusal before source invocation', () => {
    const code = 'plugin_action_current_intent_unavailable';
    const outcome = clientActionPreparationFailure(createPluginActionHandlerNotStartedError({ code }));
    expect(triageTaskWriteInvocationFailureV1(createPluginSurfaceActionFailureError(outcome)))
        .toEqual({ kind: 'refused', reason: code });
});

it('keeps the admission comparison detail in the client refusal', () => {
    const detail = { currentIntentMismatch: { field: 'fingerprint_source' } };
    expect(projectClientActionInvocationFailure({ status: 'unavailable',
        code: 'plugin_action_current_intent_mismatch', message: 'plugin_action_current_intent_mismatch',
        data: { details: detail } }, { readOnly: false }, {})).toMatchObject({
        ok: false, code: 'unavailable', reason: 'plugin_action_current_intent_mismatch', details: detail,
    });
});
