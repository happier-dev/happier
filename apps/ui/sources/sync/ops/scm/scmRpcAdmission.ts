import type { ScmCapabilities, ScmCommitCreateRequest, ScmRemotePolicy } from '@happier-dev/protocol/scm';
import { admitScmCommitPolicy, admitScmCommitUndoLast, admitScmRemotePolicy, ScmBackendDescribeResponseSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { assertScmResponse, type ScmRpcFailure } from './scmRpcFailure';

type ScmRpcPolicyRequest = Pick<ScmCommitCreateRequest, 'mode' | 'signOff' | 'expectedHeadOid' | 'expectedRef'> & ScmRemotePolicy & Readonly<{ cwd?: string; backendPreference?: unknown }>;

export async function runScmRpcWithAdmission<T extends { success: boolean; error?: string; errorCode?: string }>(input: Readonly<{
    method: string;
    request: ScmRpcPolicyRequest;
    call: (method: string, request: Readonly<object>) => Promise<unknown>;
}>): Promise<T | ScmRpcFailure> {
    const commitAdmission = input.method === RPC_METHODS.SCM_COMMIT_CREATE ? admitScmCommitPolicy(input.request) : { success: true };
    const remoteAdmission = admitScmRemotePolicy(input.request);
    const undoAdmission = input.method === RPC_METHODS.SCM_COMMIT_UNDO_LAST ? admitScmCommitUndoLast() : { success: true };
    if (!commitAdmission.success || !remoteAdmission.success || !undoAdmission.success) {
        let capabilities: ScmCapabilities | undefined;
        try {
            const description = ScmBackendDescribeResponseSchema.safeParse(await input.call(RPC_METHODS.SCM_BACKEND_DESCRIBE, {
                ...(input.request.cwd === undefined ? {} : { cwd: input.request.cwd }),
                ...(input.request.backendPreference === undefined ? {} : { backendPreference: input.request.backendPreference }),
            })).data;
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
    const response = await input.call(input.method, input.request);
    return assertScmResponse<T>(response);
}
