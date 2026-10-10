import { SessionOrganizationMoveInputSchema, type SessionOrganizationMoveOutput } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { commitSessionListDragIntent, resolveSessionListDragIntent, type CommitSessionListDragIntentContext } from './commitSessionListDragIntent';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';

export type SessionListOrganizationAction = (request: Readonly<{ input: unknown; mutationScope: SessionOrganizationMutationScope; signal?: AbortSignal }>) => Promise<SessionOrganizationMoveOutput>;

/** The mounted list supplies current state and the existing organization writers at execution time. */
export function createSessionListOrganizationActionAdapter(
    getContext: (mutationScope: SessionOrganizationMutationScope, projection?: 'rail') => CommitSessionListDragIntentContext | null,
): SessionListOrganizationAction {
    return async ({ input, mutationScope, signal }) => {
        const parsed = SessionOrganizationMoveInputSchema.safeParse(input);
        if (!parsed.success) return { status: 'refused', reason: 'invalid_parameters' };
        if (signal?.aborted) return { status: 'refused', reason: 'cancelled' };
        let context: CommitSessionListDragIntentContext | null;
        try { mutationScope.assertCurrent?.(); context = getContext(mutationScope, parsed.data.projection); }
        catch { return { status: 'unavailable' }; }
        if (!context) return { status: 'unavailable' };
        if (parsed.data.projection === 'rail') {
            const pinned = context.pinnedOrganization;
            if (!pinned) return { status: 'unavailable' };
            if (parsed.data.sourceKind !== 'leaf'
                || !['reorder-before', 'reorder-after'].includes(parsed.data.instructionKind)) {
                return { status: 'refused', reason: 'unsupported_operation' };
            }
            if (!pinned.railSessionRowIds.includes(parsed.data.sourceRowId)
                || !parsed.data.targetRowId || !pinned.railSessionRowIds.includes(parsed.data.targetRowId)) {
                return { status: 'refused', reason: 'rail_pin_not_available' };
            }
            context = { ...context, latestItems: pinned.items, latestTree: undefined };
        }
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

let mountedList: SessionListOrganizationAction | null = null;
let mountedRail: SessionListOrganizationAction | null = null;

/** Fixed mounted list/rail projections share the same adapter; neither substitutes for an absent view. */
export function registerMountedSessionListOrganizationAction(execute: SessionListOrganizationAction, projection: 'list' | 'rail' = 'list'): () => void {
    if (projection === 'rail') {
        mountedRail = execute;
        return () => { if (mountedRail === execute) mountedRail = null; };
    }
    mountedList = execute;
    return () => { if (mountedList === execute) mountedList = null; };
}

export async function invokeSessionListOrganizationAction(request: Parameters<SessionListOrganizationAction>[0]): Promise<SessionOrganizationMoveOutput> {
    const input = SessionOrganizationMoveInputSchema.safeParse(request.input);
    if (!input.success) return { status: 'refused', reason: 'invalid_parameters' };
    const mounted = input.data.projection === 'rail' ? mountedRail : mountedList;
    return mounted ? await mounted(request) : { status: 'unavailable' };
}
