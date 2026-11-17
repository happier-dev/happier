import { expect, it } from 'vitest';
import { createPluginSurfaceActionFailureError, projectClientActionInvocationFailure, clientActionPreparationFailure } from './actionFailure';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { triageTaskWriteInvocationFailureV1 } from '../../../../../../packages/plugins/triage/src/actions/taskWriteFailure';

it.each([
    { code: 'plugin_action_aborted', reason: 'plugin_action_aborted' },
    { code: 'plugin_action_outcome_unknown', reason: 'plugin_ui_action_outcome_unknown' },
])('preserves the invocation owner terminal result $code', ({ code, reason }) => {
    const outcome = projectClientActionInvocationFailure({ status: 'unavailable', code, message: code }, { readOnly: true }, {});
    expect(outcome).toMatchObject({ ok: false, reason });
});

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
        .toMatchObject({ kind: 'refused', reason: code });
});

it('retains a host-proven preparation refusal before source invocation', () => {
    const code = 'plugin_action_current_intent_unavailable';
    const outcome = clientActionPreparationFailure(createPluginActionHandlerNotStartedError({ code }));
    expect(triageTaskWriteInvocationFailureV1(createPluginSurfaceActionFailureError(outcome)))
        .toMatchObject({ kind: 'refused', reason: code });
});

it('keeps the admission comparison detail in the client refusal', () => {
    const detail = { currentIntentMismatch: { field: 'fingerprint_source' } };
    expect(projectClientActionInvocationFailure({ status: 'unavailable',
        code: 'plugin_action_current_intent_mismatch', message: 'plugin_action_current_intent_mismatch',
        data: { details: detail } }, { readOnly: false }, {})).toMatchObject({
        ok: false, code: 'unavailable', reason: 'plugin_action_current_intent_mismatch', details: detail,
    });
});

import { projectPluginActionFailure } from './actionFailure';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { createPluginSurfaceActionFailurePayload } from './actionFailure';
import { readPluginSurfaceHostApiErrorPayload } from './createPluginSurfaceHostApi';

const typedRefusal = { errorCode: 'credential_scope_denied', error: 'Choose another credential',
    requestId: 'issued-refusal', effectAttempted: false,
    failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null },
    remediation: { kind: 'retry' }, details: { reason: 'credential_scope_denied' } } as const;

it.each(['plugin', 'client'] as const)('preserves %s refusal evidence and authored recovery through the presenter', placement => {
    const projected = placement === 'client'
        ? projectClientActionInvocationFailure({ status: 'failed', code: typedRefusal.errorCode,
            message: typedRefusal.error, data: { ...typedRefusal } }, { readOnly: false }, {})
        : projectPluginActionFailure({ ...typedRefusal, code: typedRefusal.errorCode, message: typedRefusal.error });
    expect(projected).toMatchObject({ code: typedRefusal.errorCode, requestId: typedRefusal.requestId,
        effectAttempted: false, failureCause: typedRefusal.failureCause, remediation: typedRefusal.remediation });
    const payload = readPluginSurfaceHostApiErrorPayload(createPluginSurfaceActionFailurePayload(projected));
    expect(payload).toMatchObject({ requestId: typedRefusal.requestId, effectAttempted: false,
        failureCause: typedRefusal.failureCause, remediation: typedRefusal.remediation });
    const presented = presentActionExecutionFailure({ ...projected, errorCode: projected.code });
    expect(presented.reason).toContain(typedRefusal.error);
    expect(presented.technicalDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'requestId', value: typedRefusal.requestId }),
        expect.objectContaining({ key: 'causePhase', value: typedRefusal.failureCause.phase }),
        expect.objectContaining({ key: 'effectAttempted', value: 'false' }),
    ]));
});

import { settlePluginSurfaceHostApiRequest } from './createPluginSurfaceHostApi';
import { PluginError } from '@happier-dev/plugin-sdk';
it('keeps a thrown typed refusal through the shared physical-transport settlement', async () => {
    const response = await settlePluginSurfaceHostApiRequest({ version: 1, requestId: typedRefusal.requestId,
        method: 'executeAction', surface: { pluginId: 'acme.preview', contributionId: 'preview', surfaceId: 'surface',
            placement: 'sessionPane', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] } },
        () => { throw new PluginError({ code: typedRefusal.errorCode, message: typedRefusal.error,
            details: { requestId: typedRefusal.requestId, effectAttempted: false },
            failureCause: typedRefusal.failureCause, remediation: typedRefusal.remediation }); });
    expect(response).toMatchObject({ kind: 'error', requestId: typedRefusal.requestId, payload: {
        code: typedRefusal.errorCode, failureCause: typedRefusal.failureCause, remediation: typedRefusal.remediation,
    } });
});
