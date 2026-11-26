import type { ScmCapabilities, ScmCommitCreateRequest, ScmRemotePolicy } from '@happier-dev/protocol/scm';
import { admitScmCommitPolicy, admitScmCommitUndoLast, admitScmRemotePolicy, ScmBackendDescribeResponseSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { assertScmResponse, type ScmRpcFailure } from './scmRpcFailure';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Transport admission refusals are Action receipts, not SCM domain outputs. */
export type ScmRpcTransportResult<T> = T | ScmRpcFailure | ActionExecuteFailure;

type ScmRpcPolicyRequest = Pick<ScmCommitCreateRequest, 'mode' | 'signOff' | 'expectedHeadOid' | 'expectedRef' | 'gitIdentity'> & ScmRemotePolicy & Readonly<{ cwd?: string; backendPreference?: unknown }>;

// Only pending reads are shared; settled results are never cached.
const pendingDescriptions = new Map<string, Promise<unknown>>();

function describeBackend(input: Readonly<{
    request: ScmRpcPolicyRequest;
    describeScope?: string;
    call: (method: string, request: Readonly<object>) => Promise<unknown>;
}>): Promise<unknown> {
    const request = {
        ...(input.request.cwd === undefined ? {} : { cwd: input.request.cwd }),
        ...(input.request.backendPreference === undefined ? {} : { backendPreference: input.request.backendPreference }),
        ...(input.request.gitIdentity === undefined ? {} : { gitIdentity: input.request.gitIdentity }),
    };
    if (!input.describeScope) return input.call(RPC_METHODS.SCM_BACKEND_DESCRIBE, request);
    const key = JSON.stringify([input.describeScope, request]);
    const pending = pendingDescriptions.get(key);
    if (pending) return pending;
    const read = input.call(RPC_METHODS.SCM_BACKEND_DESCRIBE, request).finally(() => pendingDescriptions.delete(key));
    pendingDescriptions.set(key, read);
    return read;
}

export async function runScmRpcWithAdmission<T extends { success: boolean; error?: string; errorCode?: string }>(input: Readonly<{
    method: string;
    describeScope?: string;
    request: ScmRpcPolicyRequest;
    call: (method: string, request: Readonly<object>) => Promise<unknown>;
}>): Promise<ScmRpcTransportResult<T>> {
    const commitAdmission = input.method === RPC_METHODS.SCM_COMMIT_CREATE ? admitScmCommitPolicy(input.request) : { success: true };
    const remoteAdmission = admitScmRemotePolicy(input.request);
    const undoAdmission = input.method === RPC_METHODS.SCM_COMMIT_UNDO_LAST ? admitScmCommitUndoLast() : { success: true };
    if (!commitAdmission.success || !remoteAdmission.success || !undoAdmission.success) {
        let capabilities: ScmCapabilities | undefined;
        try {
            const description = ScmBackendDescribeResponseSchema.safeParse(await describeBackend(input)).data;
            capabilities = description?.success ? description.capabilities : undefined;
        } catch {
            // This is a read-only preflight. No advanced write has been dispatched.
        }
        if (input.method === RPC_METHODS.SCM_COMMIT_CREATE) {
            const verifiedCommit = admitScmCommitPolicy(input.request, capabilities);
            if (!verifiedCommit.success) return verifiedCommit;
        }
        const verifiedRemote = admitScmRemotePolicy(input.request, capabilities);
        if (!verifiedRemote.success) return verifiedRemote;
        if (input.method === RPC_METHODS.SCM_COMMIT_UNDO_LAST) {
            const verifiedUndo = admitScmCommitUndoLast(capabilities);
            if (!verifiedUndo.success) return verifiedUndo;
        }
    }
    const response = input.method === RPC_METHODS.SCM_BACKEND_DESCRIBE
        ? await describeBackend(input)
        : await input.call(input.method, input.request);
    if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        const refusal = ActionExecuteFailureSchema.safeParse(response);
        if (refusal.success) return refusal.data;
    }
    return assertScmResponse<T>(response);
}
