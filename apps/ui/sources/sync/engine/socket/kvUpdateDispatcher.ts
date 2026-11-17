import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { handleTodoKvBatchUpdate } from '@/sync/engine/social/syncFeed';

export type KvSocketChange = Readonly<{ key: string; value: string | null; version: number }>;
/**
 * A KV change a prefix subscriber hears. A socket push names its key and version. The changes catch-up
 * (what a socket missed while away or reconnecting) names its key without a version, or no key at all
 * (`null`) when the write changed too many keys to list: then any key under the prefix may have changed.
 */
export type KvKeyChange = Readonly<{ key: string | null; version: number | null }>;
type KvSubscription = Readonly<{
    prefix: string;
    credentials: AuthCredentials;
    shouldContinue: () => boolean;
    listener: (changes: readonly KvKeyChange[]) => void;
}>;
const subscriptions = new Set<KvSubscription>();
// The Account-change cursor of the latest socket push per credential and key. The catch-up page that
// carries the same write is then not delivered a second time.
const pushedCursorByKey = new Map<string, number>();
const pushedKey = (token: string, key: string) => `${token}\u0000${key}`;

/** Subscribers retain their mounted Account lifetime; no KV value is owned here. */
export function subscribeKvPrefixChanges(
    prefix: string,
    listener: KvSubscription['listener'],
    scope: Pick<KvSubscription, 'credentials' | 'shouldContinue'>,
): () => void {
    const subscription = { prefix, listener, ...scope };
    subscriptions.add(subscription);
    return () => { subscriptions.delete(subscription); };
}

function readChanges(value: unknown): KvSocketChange[] {
    if (!Array.isArray(value)) return [];
    return value.filter((change): change is KvSocketChange => {
        if (typeof change !== 'object' || change === null) return false;
        return 'key' in change && typeof change.key === 'string'
            && 'value' in change && (typeof change.value === 'string' || change.value === null)
            && 'version' in change && typeof change.version === 'number' && Number.isInteger(change.version);
    });
}

/**
 * The changes catch-up delivers KV keys the socket did not push (the page was hidden, the app was in the
 * background, or the socket reconnected). `keys: null` means the write changed keys it did not list.
 * Keys whose latest socket push is at or after `cursor` (the page's latest KV row) were already delivered.
 */
export function dispatchKvFeedChanges(params: Readonly<{
    credentials?: AuthCredentials | null;
    keys: readonly string[] | null;
    cursor: number;
}>): void {
    const token = params.credentials?.token;
    if (!token) return;
    const fresh = params.keys?.filter(key => (pushedCursorByKey.get(pushedKey(token, key)) ?? -1) < params.cursor);
    if (fresh?.length === 0) return;
    for (const subscription of [...subscriptions]) {
        if (!subscriptions.has(subscription) || !subscription.shouldContinue() || subscription.credentials.token !== token) continue;
        const matching: KvKeyChange[] = fresh
            ? fresh.filter(key => key.startsWith(subscription.prefix)).map(key => ({ key, version: null }))
            : [{ key: null, version: null }];
        if (matching.length > 0) subscription.listener(matching);
    }
}

export async function dispatchKvBatchUpdate(params: Readonly<{
    kvUpdate: { changes?: unknown };
    credentials?: AuthCredentials | null;
    /** The Account-change cursor this push carries (its update seq). */
    cursor?: number;
    shouldContinue: () => boolean;
    applyTodoSocketUpdates: (changes: KvSocketChange[]) => Promise<void>;
    invalidateTodosSync: () => void;
    log: { log: (message: string) => void };
}>): Promise<void> {
    if (!params.shouldContinue()) return;
    const changes = readChanges(params.kvUpdate.changes);
    const token = params.credentials?.token;
    if (token && params.cursor !== undefined) {
        for (const change of changes) {
            const id = pushedKey(token, change.key);
            pushedCursorByKey.set(id, Math.max(pushedCursorByKey.get(id) ?? -1, params.cursor));
        }
    }
    // Notify other domains before the effectful todo handler can yield or fail.
    for (const subscription of [...subscriptions]) {
        if (!params.shouldContinue()) return;
        if (!subscriptions.has(subscription) || !subscription.shouldContinue()
            || subscription.credentials.token !== params.credentials?.token) continue;
        const matching = changes.filter(change => change.key.startsWith(subscription.prefix));
        if (matching.length > 0) subscription.listener(matching);
    }
    if (!params.shouldContinue()) return;
    const todoChanges = changes.filter(change => change.key.startsWith('todo.'));
    if (todoChanges.length === 0) return;
    await handleTodoKvBatchUpdate({
        kvUpdate: { changes: todoChanges },
        applyTodoSocketUpdates: async scopedChanges => {
            if (params.shouldContinue()) await params.applyTodoSocketUpdates(scopedChanges);
        },
        invalidateTodosSync: () => {
            if (params.shouldContinue()) params.invalidateTodosSync();
        },
        log: params.log,
    });
}
