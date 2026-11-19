import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { MACHINE_OUTCOME_SUMMARY_PREFIX, machineOutcomeSummaryAddress, MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1,
    type MachineResourceOutcomeV1 } from '@happier-dev/plugin-sdk/events';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { MACHINE_SERVICES_PLUGIN_ID } from './healthSetup.js';

type Home = { rows: Map<string, readonly MachineResourceOutcomeV1[]>; changedKeys: Set<string>;
    fullRead: boolean; sources: Set<string> };

/** One demanded retained-summary read per Home. Native settlement owns the
 * facts; this reader applies committed row addresses and existing reset wakes. */
export function createMachineOutcomeSummaryReader(host: BackgroundServiceContext['services']['events']['host']) {
    const homes = new Map<string, Home>();
    let syncSubscriptions: (() => void) | undefined;
    return {
        async read(context: BackgroundServiceContext, serverId: string, sourceInstanceId: string) {
            let home = homes.get(serverId);
            if (!home) {
                home = { rows: new Map(), changedKeys: new Set(), fullRead: true, sources: new Set() };
                homes.set(serverId, home);
            }
            home.sources.add(sourceInstanceId);
            syncSubscriptions?.();
            const full = home.fullRead;
            const keys = [...home.changedKeys];
            if (full || keys.length) {
                home.fullRead = false;
                for (const key of keys) home.changedKeys.delete(key);
                try {
                    const result = await context.services.actions.execute(MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1, {
                        serverId, ...(full ? {} : { keys }),
                    }, { signal: context.signal });
                    context.signal.throwIfAborted();
                    if (!('status' in result) || result.status !== 'ready') throw new PluginError({ code: 'target_unavailable',
                        message: 'Retained Machine resource outcomes are unavailable.' });
                    // Invalidation arriving during this read stays dirty for the
                    // next finite read. Rows absent from a changed-key read vanish.
                    const rows = full ? new Map<string, MachineResourceOutcomeV1[]>()
                        : new Map([...home.rows].map(([key, values]) => [key, [...values]]));
                    if (!full) for (const key of keys) rows.delete(key);
                    for (const fact of result.outcomes) {
                        const { key } = machineOutcomeSummaryAddress(fact);
                        const values = rows.get(key) ?? [];
                        values.push(fact);
                        rows.set(key, values);
                    }
                    home.rows = rows;
                } catch (error) {
                    if (full) home.fullRead = true;
                    else for (const key of keys) home.changedKeys.add(key);
                    throw error;
                }
            }
            return [...home.rows.values()].flat();
        },
        retire(definitions: readonly PluginCheckpointedEventSourceDefinitionV1[]) {
            const active = new Set(definitions.map(definition => definition.sourceInstanceId));
            for (const [serverId, home] of homes) {
                for (const id of home.sources) if (!active.has(id)) home.sources.delete(id);
                if (!home.sources.size) homes.delete(serverId);
            }
            syncSubscriptions?.();
        },
        subscribeWake(wake: (sourceInstanceId?: string) => Promise<void>) {
            let rows: { dispose(): void } | undefined;
            let resets: { dispose(): void } | undefined;
            syncSubscriptions = () => {
                if (!homes.size) {
                    rows?.dispose(); resets?.dispose(); rows = undefined; resets = undefined;
                } else if (!rows) {
                    rows = host.subscribe({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' } }, async event => {
                        const hints = event.payload.accountKvChanges ?? [];
                        if (!hints.length) return;
                        for (const home of homes.values()) {
                            let relevant = false;
                            for (const hint of hints) {
                                if ('full' in hint) { home.fullRead = true; relevant = true; }
                                else for (const key of hint.keys) if (key.startsWith(MACHINE_OUTCOME_SUMMARY_PREFIX)) {
                                    home.changedKeys.add(key); relevant = true;
                                }
                            }
                            if (relevant) for (const id of home.sources) await wake(id);
                        }
                    });
                    resets = host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
                        if (event.payload.pluginIds && !event.payload.pluginIds.includes(MACHINE_SERVICES_PLUGIN_ID)) return;
                        for (const home of homes.values()) {
                            home.fullRead = true;
                            for (const id of home.sources) await wake(id);
                        }
                    });
                }
            };
            syncSubscriptions();
            return { dispose() { rows?.dispose(); resets?.dispose(); syncSubscriptions = undefined; } };
        },
    };
}
