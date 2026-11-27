import { describe, expect, expectTypeOf, it } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol/scm';
import { invokeUiScmAction, normalizeUiScmFacadeResult, type UiScmActionExecutor, type UiScmActionFailure } from './scmActionInvocation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

const settled = (result: unknown): UiScmActionExecutor => createFrontDoorActionExecute({
    execute: async () => ({ ok: true, result }),
});

// The Protocol owns Zod Mini response schemas; the UI Action invoker must accept them as-is.
describe('invokeUiScmAction with a Protocol (Zod Mini) response schema', () => {
    it.each(['returned', 'thrown'] as const)('retains %s refusal diagnostics through the SCM facade and failure presenter', async (delivery) => {
        const refusal = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'credential_scope_denied',
            error: 'This source-control action needs Manage access.', requestId: 'scm-request', effectAttempted: false,
            failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: 403 } });
        const executor = createFrontDoorActionExecute({ execute: async () => {
            if (delivery === 'thrown') throw createActionExecuteFailureError(refusal);
            return refusal;
        } });
        const result = normalizeUiScmFacadeResult(await invokeUiScmAction({ actionId: 'scm.diff.file', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor }));
        expect(result).toMatchObject({ success: false, actionErrorCode: refusal.errorCode,
            requestId: refusal.requestId, effectAttempted: false, failureCause: refusal.failureCause });
        if (result.success || !result.errorCode) throw new Error('Expected an SCM refusal');
        const presented = presentActionExecutionFailure({ ...result, errorCode: result.errorCode });
        expect(presented.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'requestId', value: refusal.requestId }),
            expect.objectContaining({ key: 'effectAttempted', value: 'false' }),
            expect.objectContaining({ key: 'causePhase', value: refusal.failureCause!.phase }),
            expect.objectContaining({ key: 'causeCode', value: refusal.failureCause!.errorCode }),
            expect.objectContaining({ key: 'httpStatus', value: '403' }),
        ]));
    });

    it('preserves a thrown transport refusal code through the SCM adapter', async () => {
        // The executor crosses the machine transport; its typed rejection must survive this adapter.
        const executor = createFrontDoorActionExecute({ execute: async () => {
            throw new RpcError('The target disconnected.', 'RPC_OUTCOME_UNKNOWN');
        } });
        const result = await invokeUiScmAction({ actionId: 'scm.diff.file', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor });
        expect(result).toMatchObject({ success: false, errorCode: 'RPC_OUTCOME_UNKNOWN' });
    });

    it('settles an aborted read as cancelled without invoking the machine', async () => {
        const abort = new AbortController();
        abort.abort();
        const result = await invokeUiScmAction({ actionId: 'scm.diff.file', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: { signal: abort.signal },
            executor: settled({}) });
        expect(result).toMatchObject({ success: false, errorCode: 'COMMAND_CANCELLED' });
    });
    it('parses a valid response and keeps the schema output type', async () => {
        const failure = { success: false, error: 'No model selected.', errorCode: 'MODEL_UNAVAILABLE' };
        const result = await invokeUiScmAction({ actionId: 'scm.diffSummary.generate', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor: settled(failure) });
        expectTypeOf(result).toEqualTypeOf<ScmDiffSummaryGenerateOutput | UiScmActionFailure>();
        expect(result).toEqual(failure);
    });

    it('reports an invalid_action_output failure for a response the schema rejects', async () => {
        const result = await invokeUiScmAction({ actionId: 'scm.diffSummary.generate', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor: settled({ success: 'maybe' }) });
        expect(result).toMatchObject({ success: false, errorCode: 'invalid_action_output' });
    });
});
