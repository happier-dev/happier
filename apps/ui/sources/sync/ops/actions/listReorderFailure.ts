import type { ListReorderOutputV1 } from '@happier-dev/protocol';
import { TodoReorderError } from '@/sync/domains/todos/todoOps';

/** Only canonical owner refusals are definitive after a request may have been issued. */
export function resolveListReorderFailure(error: unknown, dispatched: boolean): ListReorderOutputV1 {
    if (error instanceof TodoReorderError && error.code !== 'todo_reorder_scope_changed') {
        return { status: 'refused', reason: error.code };
    }
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code === 'not_authenticated' || code === 'pending_reorder_rejected'
        || code === 'session_access_authentication_required' || code === 'session_access_authentication_unavailable') {
        return { status: 'refused', reason: code };
    }
    return { status: dispatched ? 'unknown' : 'refused', reason: code ?? 'reorder_failed' };
}
