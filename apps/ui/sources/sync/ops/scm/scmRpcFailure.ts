import { createScmOperationUnknownOutcome, SCM_OPERATION_ERROR_CODES, ScmOperationErrorCodeSchema, ScmOperationOutcomeSchema, ScmCommitPublicationSchema, ScmCommitHookContentChangesSchema, type ScmOperationErrorCode, type ScmOperationOutcome, type ScmOperationReconciliation } from '@happier-dev/protocol/scm';
import { getScmRpcSideEffectClass } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, isRpcSessionMachineControlUnavailableError, readRpcErrorCode, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { isMachineRpcTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { log } from '@/log';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';
// Reuse the existing safe SCM failure copy; exception identity belongs only in diagnostics.
const SCM_READ_FAILURE_MESSAGE = 'Source control command failed. Refresh repository status and try again.';

type ScmRpcFailureContext = Readonly<{
    method: string;
    request: Readonly<{ cwd?: string; remote?: unknown; branch?: unknown; expectedRemoteOid?: unknown; head?: unknown; base?: unknown; providerId?: unknown; message?: unknown }>;
}>;

export type ScmRpcFailure = Readonly<{
    success: false;
    error: string;
    errorCode: ScmOperationErrorCode;
    /** Local diagnostic identity; never use as display copy or include request content. */
    diagnosticDetail?: string;
    outcome?: ScmOperationOutcome;
    /** UI Action admission is not a Git failure or an uncertain dispatched command. */
    actionErrorCode?: string;
    /**
     * The person declined the Action's in-place confirmation: nothing ran and nothing failed. Presenters
     * stay quiet (see `isScmActionNotRun`); `errorCode` is only the closed-vocabulary placeholder.
     */
    declined?: true;
    /** The Action created an approval request and waits for a decision: nothing ran, nothing failed. Quiet like `declined`. */
    awaitingApproval?: true;
    approvalArtifactId?: string;
}>;

function reconciliationFor({ method, request }: ScmRpcFailureContext): ScmOperationReconciliation {
    const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const remote = readString(request.remote);
    switch (method) {
        case RPC_METHODS.SCM_REMOTE_PUSH:
        case RPC_METHODS.SCM_REMOTE_PULL:
        case RPC_METHODS.SCM_REMOTE_FETCH:
        case RPC_METHODS.SCM_REMOTE_PUBLISH: {
            if (!remote) break;
            const branch = readString(request.branch);
            const expectedOid = readString(request.expectedRemoteOid);
            return { kind: 'remote_ref', remote, ...(branch ? { branch } : {}), ...(expectedOid ? { expectedOid } : {}) };
        }
        case RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE: {
            const head = readString(request.head);
            if (!head) break;
            const base = readString(request.base);
            const providerId = readString(request.providerId);
            return { kind: 'pull_request', head, ...(base ? { base } : {}), ...(providerId ? { providerId } : {}) };
        }
        case RPC_METHODS.SCM_STASH_CREATE: {
            const message = readString(request.message);
            return { kind: 'stash', ...(message ? { message } : {}) };
        }
        case RPC_METHODS.SCM_STASH_APPLY:
        case RPC_METHODS.SCM_STASH_POP:
        case RPC_METHODS.SCM_STASH_DROP:
            // A display ref can move while the request is in flight. Re-read the stash list;
            // never turn that mutable selector into claimed immutable effect identity.
            return { kind: 'stash' };
    }
    return { kind: 'repository_status', ...(request.cwd ? { cwd: request.cwd } : {}) };
}

export function scmFallbackError(error: unknown, context: ScmRpcFailureContext): ScmRpcFailure {
    const isRead = getScmRpcSideEffectClass(context.method) === 'read';
    const rpcErrorCode = readRpcErrorCode(error);
    if (isRead && rpcErrorCode === 'SOCKET_RPC_ABORTED') return {
        success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED, error: 'The read was cancelled.',
    };
    const carrier = error && typeof error === 'object' ? error as {
        scmErrorCode?: unknown; diagnosticDetail?: unknown; name?: unknown; message?: unknown;
    } : undefined;
    const finish = (failure: ScmRpcFailure): ScmRpcFailure => {
        // Writes retain their established uncertain-outcome envelope without private diagnostics.
        if (!isRead) return failure;
        const retainedDetail = typeof carrier?.diagnosticDetail === 'string' ? carrier.diagnosticDetail : undefined;
        const name = typeof carrier?.name === 'string' ? carrier.name.split(/[\r\n]/, 1)[0] : 'Error';
        const message = typeof carrier?.message === 'string' ? carrier.message : typeof error === 'string' ? error : '';
        const diagnosticDetail = retainedDetail ?? `${name}: ${message.split(/[\r\n]/, 1)[0]}`;
        // A repository refresh may rethrow an already normalized read. Its diagnostic was
        // logged at the originating failure; carry it forward without logging it twice.
        if (retainedDetail === undefined) log.log(`[scm] ${context.method} ${failure.errorCode}: ${diagnosticDetail}`);
        return { ...failure, ...(rpcErrorCode ? { actionErrorCode: rpcErrorCode } : {}), diagnosticDetail };
    };
    if (isRead && carrier) {
        const nativeCode = ScmOperationErrorCodeSchema.safeParse(carrier.scmErrorCode);
        if (nativeCode.success) return finish({
            success: false, errorCode: nativeCode.data,
            error: typeof carrier.message === 'string' ? carrier.message : nativeCode.data,
        });
    }
    if (error && typeof error === 'object') {
        const code = readRpcErrorCode(error);
        const rpcError: RpcErrorCarrier = {
            rpcErrorCode: code,
            message: typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined,
        };
        if (isRpcMethodNotAvailableError(rpcError)) {
            return finish({ success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE });
        }
        if (isRpcMethodNotFoundError(rpcError)) {
            return finish({ success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED });
        }
        if (isRpcSessionMachineControlUnavailableError(rpcError)) {
            return finish({ success: false, error: RPC_ERROR_MESSAGES.SESSION_MACHINE_CONTROL_UNAVAILABLE, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE });
        }
    }
    if (!isRead) {
        return {
            success: false,
            error: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN,
            // Saved analysis revisions are not repository mutations and have no Git reconciliation outcome.
            ...(context.method.startsWith('scm.diffSummary.') ? {} : { outcome: createScmOperationUnknownOutcome(reconciliationFor(context)) }),
        };
    }
    // Preserve recognized read outages through the existing native failure
    // vocabulary. Generic refusals still quarantine private Work witnesses.
    if (isMachineRpcTimeoutError(error)) return finish({
        success: false, error: SCM_READ_FAILURE_MESSAGE, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT,
    });
    if (isTransientConnectivityError(error)) return finish({
        success: false, error: SCM_READ_FAILURE_MESSAGE, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED,
    });
    return finish({ success: false, error: SCM_READ_FAILURE_MESSAGE, errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED });
}

export function assertScmResponse<T extends { success: boolean; error?: string; errorCode?: string }>(value: unknown): T {
    if (!value || typeof value !== 'object' || typeof (value as { success?: unknown }).success !== 'boolean') {
        throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
    }
    const outcome = (value as { outcome?: unknown }).outcome;
    // The machine RPC is an untyped transport boundary; validate its envelope and rich outcome here.
    let response = value as T;
    for (const field of ['publication', 'commitPublication'] as const) {
        const publication = (value as Record<string, unknown>)[field];
        if (publication !== undefined) {
            const parsed = ScmCommitPublicationSchema.safeParse(publication);
            if (!parsed.success) throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
            response = { ...response, [field]: parsed.data };
        }
    }
    const hookContentChanges = (value as { hookContentChanges?: unknown }).hookContentChanges;
    if (hookContentChanges !== undefined) {
        const parsed = ScmCommitHookContentChangesSchema.safeParse(hookContentChanges);
        if (!parsed.success) throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
        response = { ...response, hookContentChanges: parsed.data };
    }
    if (outcome !== undefined) {
        const parsed = ScmOperationOutcomeSchema.safeParse(outcome);
        if (!parsed.success) throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
        return { ...response, outcome: parsed.data };
    }
    return response;
}
