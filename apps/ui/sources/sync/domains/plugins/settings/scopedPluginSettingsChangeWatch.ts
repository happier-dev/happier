import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { ScopedPluginSettingsAccountTarget } from './scopedPluginSettingsAdapter';

export type ScopedPluginSettingsChangeWatch = Readonly<{
    dispose(): void;
}>;

type ActiveScopedPluginSettingsChangeWatch = Readonly<{
    pluginId: string;
    /**
     * The current active Account lifetime establishes this portable target's
     * exact server/account scope. AccountChange itself deliberately carries no
     * credentials, target identity, settings values, or renderer state.
     */
    target: ScopedPluginSettingsAccountTarget;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated(): void;
}>;

const activeScopedPluginSettingsChangeWatches = new Set<ActiveScopedPluginSettingsChangeWatch>();
const NOOP_WATCH: ScopedPluginSettingsChangeWatch = Object.freeze({ dispose(): void {} });

function notifyWatches(watches: Iterable<ActiveScopedPluginSettingsChangeWatch>): void {
    for (const watch of watches) {
        if (!activeScopedPluginSettingsChangeWatches.has(watch) || !watch.lifetime.isCurrent()) continue;
        try {
            watch.onInvalidated();
        } catch {
            // A presentation callback cannot affect the AccountChange owner,
            // the captured Account lifetime, or a sibling Settings record.
        }
    }
}

/**
 * Registers one content-free, level-triggered AccountChange wakeup for an
 * already admitted Account Settings record. The runtime adapter captures the
 * exact active target/lifetime before reaching this owner; this module merely
 * filters the incumbent AccountChange stream by the closed Settings hint.
 */
export function watchActiveScopedPluginSettingsChanges(input: Readonly<{
    pluginId: string;
    target: ScopedPluginSettingsAccountTarget;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated(): void;
}>): ScopedPluginSettingsChangeWatch {
    if (!input.lifetime.isCurrent()) return NOOP_WATCH;
    const watch: ActiveScopedPluginSettingsChangeWatch = Object.freeze({
        pluginId: input.pluginId,
        target: input.target,
        lifetime: input.lifetime,
        onInvalidated: input.onInvalidated,
    });
    let disposed = false;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        activeScopedPluginSettingsChangeWatches.delete(watch);
        retirement?.dispose();
        retirement = null;
    };

    activeScopedPluginSettingsChangeWatches.add(watch);
    retirement = input.lifetime.onRetire(dispose);
    if (!input.lifetime.isCurrent()) dispose();
    return Object.freeze({ dispose });
}

/**
 * Called only from the incumbent AccountChange application path. The schema
 * remains closed: malformed rows and every non-Settings plugin domain are not
 * wakeups for this record owner.
 */
export function publishActiveScopedPluginSettingsChanges(changes: readonly unknown[]): void {
    const affected = new Set<ActiveScopedPluginSettingsChangeWatch>();
    for (const rawChange of changes) {
        const parsed = PluginDomainChangeEntrySchema.safeParse(rawChange);
        if (
            !parsed.success
            || parsed.data.hint.pluginDomain !== 'settings'
            || parsed.data.hint.scope !== 'account'
        ) {
            continue;
        }
        for (const watch of activeScopedPluginSettingsChangeWatches) {
            if (watch.pluginId === parsed.data.hint.pluginId) affected.add(watch);
        }
    }
    notifyWatches(affected);
}

/**
 * A successful Account snapshot repair is another level-triggered source of
 * truth. Reuse the existing reset boundary instead of introducing a poller or
 * a second stream.
 */
export function resetActiveScopedPluginSettingsChangeWatches(): void {
    notifyWatches(activeScopedPluginSettingsChangeWatches);
}
