import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

const pending = new Map<string, Promise<void>>();

/**
 * Admitted edits of one Account document settle in mutation-entry order. CAS alone
 * cannot provide this: an older callback can otherwise rebase after a newer edit
 * (including a no-op) and become the newest valid server write. Captured Action
 * contexts share this owner; approval happens before entering it.
 */
export function runAccountSettingsMutation<T>(scope: ServerAccountScope, mutate: () => Promise<T>,
    signal: AbortSignal): Promise<T> {
    const key = serverAccountScopeKeySuffix(scope);
    const previous = pending.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
        throwIfAborted(signal);
        return mutate();
    });
    const settled = result.then(() => {}, () => {});
    pending.set(key, settled);
    void settled.then(() => {
        if (pending.get(key) === settled) pending.delete(key);
    });
    return result;
}
