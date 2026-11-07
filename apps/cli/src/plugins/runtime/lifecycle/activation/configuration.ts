import type { AccountPluginDataStorageHost } from '../../context/accountPluginDataStorage';
import { subscribePluginAccountCollectionWatchInvalidation } from '../../context/pluginAccountSettingsChangeBroker';
import type { ActivationTarget, PluginContributionActivationDemand } from './targets';
import { logger } from '@/ui/logger';
import { projectPluginFailureText } from '../utils';

/**
 * Configuration is positive activation demand only. The activated plugin still
 * owns enabled state, currentness, credentials, domain reconciliation and effects.
 * Read failures keep the incumbent eager lifecycle, including its recovery path.
 */
export async function observePluginConfigurationActivation(params: Readonly<{
    targets: readonly ActivationTarget[];
    accountStorage: AccountPluginDataStorageHost;
    readAutomationEventSourceDemand(pluginId: string, signal: AbortSignal): Promise<boolean>;
    subscribeAutomationEventSources(listener: () => void): () => void;
    activate(demands: readonly PluginContributionActivationDemand[]): Promise<unknown>;
    isActivated(pluginId: string): boolean;
    isTargetCurrent(pluginId: string): boolean;
    readOccurrenceId(pluginId: string): string | null;
    isCurrent(): boolean;
    signal: AbortSignal;
}>): Promise<Readonly<{ dispose(): void }>> {
    const targets = params.targets.filter(target => target.manifest.activation?.configuration && !target.account);
    const disposers: Array<() => void> = [];
    const pending = new Set(targets);
    const watchedCollections = new Set<string>();
    let disposed = false;
    let running: Promise<void> | null = null;
    const current = () => !disposed && !params.signal.aborted && params.isCurrent();
    const collectionKey = (ref: Readonly<{ pluginId: string; collectionId: string }>) => `${ref.pluginId}\u0000${ref.collectionId}`;

    const enqueue = (selected: readonly ActivationTarget[]): void => {
        if (!current()) return;
        for (const target of selected) if (params.isTargetCurrent(target.pluginId) && !params.isActivated(target.pluginId)) pending.add(target);
        if (pending.size > 0) void flush().catch(error => {
            if (current()) logger.warn('[PLUGIN RUNTIME] Configuration activation failed', { error: projectPluginFailureText(error) });
        });
    };
    async function reconcile(selected: readonly ActivationTarget[]): Promise<void> {
        const demands = new Set<string>();
        const refs = [...new Map(selected.flatMap(target => target.manifest.activation?.configuration?.accountCollections ?? [])
            .map(ref => [collectionKey(ref), ref])).values()];
        if (refs.length > 0) {
            try {
                const owner = selected[0]!;
                const occurrenceId = params.readOccurrenceId(owner.pluginId);
                if (!occurrenceId) throw new Error('Configuration activation occurrence is unavailable');
                const presence = await params.accountStorage.readCollectionPresence({ collections: refs }, {
                    pluginId: owner.pluginId, occurrenceId, signal: params.signal, isOccurrenceCurrent: current,
                });
                if (!current()) return;
                // Subscribe from the query cursor. The broker catches up any
                // matching change received while the authenticated read ran.
                for (const ref of refs) {
                    const key = collectionKey(ref);
                    if (watchedCollections.has(key)) continue;
                    disposers.push(subscribePluginAccountCollectionWatchInvalidation({
                        accountScopeKey: presence.accountScopeKey, ...ref, startingCursor: presence.changeCursor,
                    }, () => enqueue(targets.filter(target => target.manifest.activation?.configuration?.accountCollections
                        ?.some(candidate => collectionKey(candidate) === key)))));
                    watchedCollections.add(key);
                }
                const present = new Set(presence.collections.filter(row => row.present).map(collectionKey));
                for (const target of selected) if (target.manifest.activation?.configuration?.accountCollections
                    ?.some(ref => present.has(collectionKey(ref)))) demands.add(target.pluginId);
            } catch {
                // Unavailable is unknown, never empty. In particular an older
                // Home keeps today's eager activation and provider recovery.
                for (const target of selected) if (target.manifest.activation?.configuration?.accountCollections?.length) demands.add(target.pluginId);
            }
        }
        for (const target of selected) {
            if (!target.manifest.activation?.configuration?.automationEventSources || demands.has(target.pluginId)) continue;
            try {
                if (await params.readAutomationEventSourceDemand(target.pluginId, params.signal)) demands.add(target.pluginId);
            } catch {
                demands.add(target.pluginId);
            }
        }
        if (!current()) return;
        // One exact declared registration demands the complete existing target.
        // No parallel module loader, activation registry or service owner exists.
        const contributionDemands = selected.flatMap(target => {
            if (!params.isTargetCurrent(target.pluginId) || !demands.has(target.pluginId)) return [];
            const right = target.registrationRights[0];
            return right ? [{ pluginId: target.pluginId, family: right.family, localId: right.localId }] : [];
        });
        if (contributionDemands.length > 0) await params.activate(contributionDemands);
    }
    function flush(): Promise<void> {
        if (running) return running;
        running = (async () => {
            while (current() && pending.size > 0) {
                const selected = [...pending].filter(target => params.isTargetCurrent(target.pluginId) && !params.isActivated(target.pluginId));
                pending.clear();
                if (selected.length > 0) await reconcile(selected);
            }
        })().finally(() => {
            running = null;
            // A push can enqueue in the microtask between loop settlement and
            // this cleanup. It still owns a fresh read, without a timer.
            if (current() && pending.size > 0) enqueue([]);
        });
        return running;
    }
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        pending.clear();
        for (const dispose of disposers.splice(0)) dispose();
        params.signal.removeEventListener('abort', dispose);
    };
    params.signal.addEventListener('abort', dispose, { once: true });
    if (targets.some(target => target.manifest.activation?.configuration?.automationEventSources)) {
        disposers.push(params.subscribeAutomationEventSources(() => enqueue(targets.filter(target =>
            target.manifest.activation?.configuration?.automationEventSources))));
    }
    try {
        await flush();
        if (params.signal.aborted) dispose();
        return Object.freeze({ dispose });
    } catch (error) {
        dispose();
        throw error;
    }
}
