import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from './serverAccountScope';

export type ActiveServerAccountScopeLifetime = Readonly<{
    /** The exact active server/account scope this consumer captured. */
    scope: ServerAccountScope;
    /** False as soon as this Account scope retires or is no longer active. */
    isCurrent(): boolean;
    /**
     * Register owner-local synchronous retirement work. The callback is never
     * awaited: it only gives the consumer an immediate chance to abort/retire
     * its own work before the next Account mounts.
     */
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

type MutableActiveServerAccountScopeLifetime = ActiveServerAccountScopeLifetime & {
    retire(): void;
};

let activeLifetime: MutableActiveServerAccountScopeLifetime | null = null;

const NOOP_DISPOSABLE = Object.freeze({ dispose(): void {} });

export function getActiveServerAccountScope(): ServerAccountScope | null {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const profileScope = readRegisteredStorageState()?.profileScope ?? null;
    if (!activeServerId || !profileScope) return null;
    return areServerProfileIdentifiersEquivalent(profileScope.serverId, activeServerId) ? profileScope : null;
}

function retireLifetime(lifetime: MutableActiveServerAccountScopeLifetime): void {
    lifetime.retire();
    if (activeLifetime === lifetime) activeLifetime = null;
}

/**
 * Capture the sole UI-sync Account lifetime for the current active scope.
 *
 * This is intentionally a small extension of the existing active-scope owner,
 * not a second epoch or reset bus. `sync.resetServerScopedRuntimeState()`
 * retires it as part of the incumbent generation reset, while a direct scope
 * change is also fenced here before a new capture can be returned.
 */
export function captureActiveServerAccountScopeLifetime(): ActiveServerAccountScopeLifetime | null {
    const scope = getActiveServerAccountScope();
    if (!scope) {
        if (activeLifetime) retireLifetime(activeLifetime);
        return null;
    }
    if (activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, scope)) {
        return activeLifetime;
    }
    if (activeLifetime) retireLifetime(activeLifetime);

    let retired = false;
    const cancellations = new Set<() => void>();
    let lifetime: MutableActiveServerAccountScopeLifetime;
    lifetime = Object.freeze({
        scope,
        isCurrent(): boolean {
            return !retired
                && activeLifetime === lifetime
                && areServerAccountScopesEqual(getActiveServerAccountScope(), scope);
        },
        onRetire(cancel: () => void) {
            if (typeof cancel !== 'function') return NOOP_DISPOSABLE;
            if (retired) {
                try {
                    cancel();
                } catch {
                    // One consumer's cleanup failure cannot prevent the caller
                    // from observing the already-retired lifetime.
                }
                return NOOP_DISPOSABLE;
            }
            let removed = false;
            cancellations.add(cancel);
            return Object.freeze({
                dispose(): void {
                    if (removed) return;
                    removed = true;
                    cancellations.delete(cancel);
                },
            });
        },
        retire(): void {
            if (retired) return;
            // Mark stale before invoking a consumer, so cancellation can never
            // race a newly started Account-A operation.
            retired = true;
            const pending = [...cancellations];
            cancellations.clear();
            for (const cancel of pending) {
                try {
                    cancel();
                } catch {
                    // Retirement is best-effort per consumer, never a barrier
                    // for the next Account's established sync reset path.
                }
            }
        },
    });
    activeLifetime = lifetime;
    return lifetime;
}

/**
 * Capture the Account lifetime that owns one in-flight request as a plain
 * currentness fence.
 *
 * This is the same lifetime `captureActiveServerAccountScopeLifetime()` returns —
 * no second Account registry — with the one case that owner cannot express: a
 * request started while NO Account was mounted. An Account mounting mid-flight is
 * still an Account-lifetime change, so that case fences on "still nothing mounted"
 * rather than fencing on nothing at all.
 *
 * Use it wherever a request captured under Account A must not publish rows, apply
 * annotations, or complete navigation after a switch to Account B.
 */
export function captureActiveServerAccountScopeCurrentness(): ActiveServerAccountScopeLifetime | Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime) return lifetime;
    return Object.freeze({
        isCurrent: (): boolean => getActiveServerAccountScope() === null,
        onRetire: (): Readonly<{ dispose(): void }> => NOOP_DISPOSABLE,
    });
}

/**
 * The synchronous hook from the incumbent server-scoped reset owner.
 * Repeated reset/disconnect paths are intentionally idempotent.
 */
export function retireActiveServerAccountScopeLifetime(): void {
    if (activeLifetime) retireLifetime(activeLifetime);
}
