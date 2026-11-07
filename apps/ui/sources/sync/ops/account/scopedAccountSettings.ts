import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadAccountSettings, subscribeAccountSettingsPersistenceMutations } from '@/sync/domains/state/accountSettingsPersistence';
import { accountSettingsKeysChanged } from '@/sync/domains/state/accountSettingsPersistenceSubscriptions';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { storage } from '@/sync/domains/state/storageStore';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

type Listener = (settings: Settings | null) => void;
const observations = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createObservation>>();

/** One remote read projection per demanded Account; focused Sync already materializes local keys. */
function createObservation(lifetime: ServerAccountScopeLifetime, remove: () => void) {
    const consumers = new Map<Listener, readonly (keyof Settings)[]>();
    let settings: Settings | undefined;
    let failed = false;
    let abort: AbortController | undefined;
    const refresh = (remote: boolean) => {
        if (!lifetime.isCurrent()) return;
        abort?.abort();
        const cancellation = new AbortController();
        abort = cancellation;
        void (async () => {
            const account = await captureLazyActionAccountContext(lifetime.scope.serverId, cancellation.signal);
            try {
                if (account.accountId !== lifetime.scope.accountId) throw new Error('action_account_scope_changed');
                const next = retainDeep(settings, remote ? settingsParse((await account.readRawSettingsSnapshot()).raw) : await account.readSettings());
                account.assertCurrent();
                if (cancellation.signal.aborted) return;
                const previous = failed ? undefined : settings;
                settings = next;
                failed = false;
                for (const [listener, keys] of consumers) if (accountSettingsKeysChanged(previous, next, keys)) listener(next);
            } finally { account.dispose(); }
        })().catch(() => {
            if (cancellation.signal.aborted || !lifetime.isCurrent() || failed) return;
            failed = true;
            for (const listener of consumers.keys()) listener(null);
        });
    };
    const unsubscribeHome = subscribeHomeAccountChange(event => {
        if (event.accountSettingsAffects === false) return;
        // Focused Sync delivers persisted key changes. Its coarse Account wake
        // must not start another read; a failed first read still needs recovery.
        if (!failed && areAccountSettingsScopesEqual(storage.getState().settingsScope, lifetime.scope)) return;
        refresh(true);
    }, { serverIds: [lifetime.scope.serverId], reconnect: { readNotCurrent: () => failed || settings === undefined } });
    const retirement = lifetime.onRetire(() => abort?.abort());
    return {
        subscribe(keys: readonly (keyof Settings)[], listener: Listener) {
            consumers.set(listener, keys);
            const unsubscribeKeys = subscribeAccountSettingsPersistenceMutations(() => {
                if (!lifetime.isCurrent()) return;
                abort?.abort();
                settings = retainDeep(settings, settingsParse(loadAccountSettings(lifetime.scope).settings));
                failed = false;
                listener(settings);
            }, { scope: lifetime.scope, keys });
            if (failed) listener(null);
            else if (settings) listener(settings);
            else if (!abort) refresh(false);
            return () => {
                unsubscribeKeys(); consumers.delete(listener);
                if (consumers.size) return;
                abort?.abort(); unsubscribeHome(); retirement.dispose(); remove();
            };
        },
    };
}

/** Consumers subscribe once by key; Account hydration and recovery belong to this shared reader. */
export function subscribeScopedAccountSettings(binding: ServerAccountScopeLifetime,
    keys: readonly (keyof Settings)[], listener: Listener): () => void {
    const lifetime = readServerAccountScopeOwnerLifetime(binding);
    let observation = observations.get(lifetime);
    if (!observation) {
        observation = createObservation(lifetime, () => observations.delete(lifetime));
        observations.set(lifetime, observation);
    }
    return observation.subscribe(keys, listener);
}
