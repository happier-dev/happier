import { SessionOrganizationMoveInputSchema, type SessionOrganizationMoveOutput } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { commitSessionListDragIntent, resolveSessionListDragIntent, type CommitSessionListDragIntentContext } from './commitSessionListDragIntent';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';

export type SessionListOrganizationAction = (request: Readonly<{ input: unknown; mutationScope: SessionOrganizationMutationScope; signal?: AbortSignal }>) => Promise<SessionOrganizationMoveOutput>;

/** The mounted list supplies current state and the existing organization writers at execution time. */
export function createSessionListOrganizationActionAdapter(
    getContext: (mutationScope: SessionOrganizationMutationScope) => CommitSessionListDragIntentContext | null,
): SessionListOrganizationAction {
    return async ({ input, mutationScope, signal }) => {
        const parsed = SessionOrganizationMoveInputSchema.safeParse(input);
        if (!parsed.success) return { status: 'refused', reason: 'invalid_parameters' };
        if (signal?.aborted) return { status: 'refused', reason: 'cancelled' };
        let context: CommitSessionListDragIntentContext | null;
        try { mutationScope.assertCurrent?.(); context = getContext(mutationScope); }
        catch { return { status: 'unavailable' }; }
        if (!context) return { status: 'unavailable' };
        const intent = { ...parsed.data, sourceSnapshotSignature: '' };
        const admission = resolveSessionListDragIntent({ intent, context });
        if (!admission.ok) return { status: 'refused', reason: admission.relationReason ?? admission.reason };
        // Reporting relationships have their own Action and authority; this operation cannot bypass it.
        if (admission.effect !== 'organization') return { status: 'refused', reason: 'unsupported_operation' };
        try {
            const result = await commitSessionListDragIntent({ intent, context });
            return result.ok ? { status: 'applied' } : { status: 'refused', reason: result.reason };
        } catch {
            // The existing writers can throw after dispatch or after an earlier effect acknowledged.
            // They cannot prove that nothing changed; retain uncertainty and never replay the move.
            return { status: 'unknown', reason: 'organization_write_outcome_unknown' };
        }
    };
}

let mounted: SessionListOrganizationAction | null = null;

/** One answering list owner. Cleanup cannot retire a newer mounted owner. */
export function registerMountedSessionListOrganizationAction(execute: SessionListOrganizationAction): () => void {
    mounted = execute;
    return () => { if (mounted === execute) mounted = null; };
}

export async function invokeSessionListOrganizationAction(request: Parameters<SessionListOrganizationAction>[0]): Promise<SessionOrganizationMoveOutput> {
    return mounted ? await mounted(request) : { status: 'unavailable' };
}
