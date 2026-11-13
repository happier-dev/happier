import type { WorkspaceIntegrationHandlers } from '@happier-dev/plugin-sdk/scm/backend';
import { normalizeScmOperationOutcome, SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { getGitSnapshot } from '../repository.js';
import { gitBranchCheckout, gitDetachedCheckout } from './branchOperations.js';
import { fetchGitRemoteCheckoutRef } from './fetchRemoteCheckoutRef.js';
import { resolveGitCommitRef } from './exportCommit.js';

/** Source full refs use the same explicit fetch as provider PR checkout, then detach without moving branches. */
export const checkoutGitRef: NonNullable<WorkspaceIntegrationHandlers['checkoutRef']> = async input => {
    input.signal?.throwIfAborted();
    if (!input.ref.startsWith('refs/')) {
        return gitBranchCheckout({ context: input.context,
            request: { name: input.ref, strategy: 'bring_changes' } });
    }
    const snapshot = await getGitSnapshot({ context: input.context, request: { detail: 'facts' } });
    if (!snapshot.success || !snapshot.snapshot) return { success: false,
        errorCode: snapshot.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        error: snapshot.error ?? 'Failed to inspect configured checkout remote' };
    const fetched = await fetchGitRemoteCheckoutRef({ context: input.context, snapshot: snapshot.snapshot,
        remoteRef: input.ref, ...(input.signal ? { signal: input.signal } : {}) });
    if (!fetched.success) return fetched;
    let commit: string;
    try {
        commit = await resolveGitCommitRef({ context: input.context, ref: 'FETCH_HEAD',
            ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        input.signal?.throwIfAborted();
        const result = { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: error instanceof Error ? error.message : 'Fetched ref is not a commit' };
        return { ...result, outcome: normalizeScmOperationOutcome(result) };
    }
    const checkout = await gitDetachedCheckout({ context: input.context, commit,
        ...(input.signal ? { signal: input.signal } : {}) });
    input.signal?.throwIfAborted();
    return checkout;
};
