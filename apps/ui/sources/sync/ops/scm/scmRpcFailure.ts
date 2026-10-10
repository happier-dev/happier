import { createScmOperationUnknownOutcome, SCM_OPERATION_ERROR_CODES, ScmOperationOutcomeSchema, ScmCommitPublicationSchema, ScmCommitHookContentChangesSchema, type ScmOperationErrorCode, type ScmOperationOutcome, type ScmOperationReconciliation } from '@happier-dev/protocol/scm';
import { getScmRpcSideEffectClass } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';

type ScmRpcFailureContext = Readonly<{
    method: string;
    request: Readonly<{ cwd?: string; remote?: unknown; branch?: unknown; expectedRemoteOid?: unknown; head?: unknown; base?: unknown; providerId?: unknown; message?: unknown }>;
}>;

export type ScmRpcFailure = Readonly<{
    success: false;
    error: string;
    errorCode: ScmOperationErrorCode;
    outcome?: ScmOperationOutcome;
    /** UI Action admission is not a Git failure or an uncertain dispatched command. */
    actionErrorCode?: string;
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
    if (error && typeof error === 'object') {
        const rpcError: RpcErrorCarrier = {
            rpcErrorCode: typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string' ? (error as { rpcErrorCode: string }).rpcErrorCode : undefined,
            message: typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined,
        };
        if (isRpcMethodNotAvailableError(rpcError)) {
            return { success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE };
        }
        if (isRpcMethodNotFoundError(rpcError)) {
            return { success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED };
        }
    }
    if (getScmRpcSideEffectClass(context.method) !== 'read') {
        return {
            success: false,
            error: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN,
            // Saved analysis revisions are not repository mutations and have no Git reconciliation outcome.
            ...(context.method.startsWith('scm.diffSummary.') ? {} : { outcome: createScmOperationUnknownOutcome(reconciliationFor(context)) }),
        };
    }
    if (error instanceof Error && error.message === SCM_UNSUPPORTED_RESPONSE_ERROR) {
        return { success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED };
    }
    return { success: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE };
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
