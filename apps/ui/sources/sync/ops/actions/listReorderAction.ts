import { PendingReorderInputV1Schema, TodoReorderInputV1Schema,
    type ListReorderOutputV1 } from '@happier-dev/protocol/actions/listReorderAction';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resolvePendingReorderIds } from '@/sync/domains/pending/pendingReorder';
import { reorderTodos, TodoReorderError } from '@/sync/domains/todos/todoOps';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { sync } from '@/sync/sync';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveListReorderFailure } from './listReorderFailure';

/** The answering UI's existing sync Account owns execution; no mounted reorder registry. */
export async function executeListReorderAction(args: Readonly<{
    actionId: 'session.pending.reorder' | 'todos.reorder'; input: unknown; signal?: AbortSignal;
}>): Promise<ListReorderOutputV1> {
    const parsed = (args.actionId === 'session.pending.reorder' ? PendingReorderInputV1Schema : TodoReorderInputV1Schema).safeParse(args.input);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_input' };
    const input = parsed.data;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const credentials = sync?.getCredentials();
    if (!lifetime || !credentials) return { status: 'unavailable' };
    const snapshot = getActiveServerSnapshot();
    const isCurrent = () => lifetime.isCurrent() && areServerAccountScopesEqual(lifetime.scope, input.scope)
        && snapshot.serverId === input.scope.serverId && sync?.getCredentials()?.token === credentials.token;
    try {
        if (!isCurrent() || parseToken(credentials.token) !== input.scope.accountId) {
            return { status: 'refused', reason: 'scope_changed' };
        }
    } catch { return { status: 'refused', reason: 'scope_changed' }; }
    if (args.signal?.aborted) return { status: 'refused', reason: 'cancelled' };
    let dispatched = false;
    const request: ServerFetch = async (path, init, options) => {
        if (!isCurrent() || args.signal?.aborted) throw new TodoReorderError('todo_reorder_scope_changed');
        return serverFetch(path, { ...init, ...(args.signal ? { signal: args.signal } : {}) }, {
            ...options, expectedActiveServer: { serverId: snapshot.serverId, generation: snapshot.generation },
            onIssued: () => {
                if (init?.method === 'POST') dispatched = true;
                options?.onIssued?.();
            },
        });
    };
    try {
        if (args.actionId === 'session.pending.reorder') {
            const pending = PendingReorderInputV1Schema.parse(input);
            const state = storage.getState().sessionPending[pending.sessionId];
            if (!state?.isLoaded) return { status: 'unavailable' };
            const ids = resolvePendingReorderIds(state.messages, pending);
            if (!ids) return { status: 'refused', reason: 'pending_reorder_stale' };
            if (!isCurrent() || args.signal?.aborted) return { status: 'refused', reason: 'scope_changed' };
            // The sync owner exposes no issue witness; its typed pre-admission refusals
            // override this conservative fallback for otherwise ambiguous failures.
            dispatched = true;
            await sync.reorderPendingMessages(pending.sessionId, ids, pending.recipient ?? undefined, { serverId: pending.scope.serverId });
        } else {
            if (!storage.getState().todosLoaded) return { status: 'unavailable' };
            await reorderTodos(credentials, input.sourceId, input.position, { request, isCurrent, signal: args.signal });
        }
        return { status: 'applied' };
    } catch (error) {
        return resolveListReorderFailure(error, dispatched);
    }
}
