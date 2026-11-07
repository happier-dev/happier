import * as React from 'react';
import { storeKinds, type InstalledRow, type StoreDemand, type StoreInstalledInput } from '../catalog/storeKinds';
import { useManagedInventoryAttention } from './useManagedInventoryAttention';
import { useManagedWatchedServices, type ManagedWatchedServiceRow } from './managedOperationalInventory';
import { useInstalledScope } from '../catalog/storeAccountAdmission';

export type ManagedInventoryRow = InstalledRow | ManagedWatchedServiceRow;

export type ManagedInventoryQuery = StoreInstalledInput & StoreDemand;
export type ManagedInventoryFamilies = Readonly<{
    [Kind in keyof typeof storeKinds]: ReturnType<(typeof storeKinds)[Kind]['useInstalled']>;
}>;
export type ManagedInventoryView = Readonly<{
    families: ManagedInventoryFamilies;
    operationalFamilies: Readonly<{ watchedService: ReturnType<typeof useManagedWatchedServices> }>;
    rows: readonly ManagedInventoryRow[];
    coverage: 'complete' | 'partial' | 'unavailable';
    loading: boolean;
    attention: ReturnType<typeof useManagedInventoryAttention>['attention'];
    noticeSource: ReturnType<typeof useManagedInventoryAttention>['noticeSource'];
}>;

/** Summary only; callers retain each original family for reason, recovery and paging. */
export function summarizeInstalledFamilies<Result extends Pick<ManagedInventoryFamilies[keyof ManagedInventoryFamilies], 'coverage'>>(results: readonly Result[]) {
    const loading = results.some(family => family.coverage === 'loading');
    const coverage = results.every(family => typeof family.coverage === 'object' && 'unavailable' in family.coverage)
        ? 'unavailable' : results.every(family => family.coverage === 'available')
            ? 'complete' : 'partial';
    return { loading, coverage } as const;
}

/** One Account admission; native adapters retain membership and acquisition authority. */
export function useManagedInventory(query: ManagedInventoryQuery): ManagedInventoryView {
    const input = React.useMemo<StoreInstalledInput>(() => ({ scope: query.scope, machine: query.machine,
        projectKey: query.projectKey }), [query.scope, query.machine, query.projectKey]);
    const demand = React.useMemo(() => ({ presented: query.presented }), [query.presented]);
    const admitted = useInstalledScope(input);
    const app = storeKinds.app.useInstalled(input, demand, admitted);
    const browserExtension = storeKinds.browserExtension.useInstalled(input, demand, admitted);
    const mcpServer = storeKinds.mcpServer.useInstalled(input, demand, admitted);
    const skill = storeKinds.skill.useInstalled(input, demand, admitted);
    const agent = storeKinds.agent.useInstalled(input, demand, admitted);
    const provider = storeKinds.provider.useInstalled(input, demand, admitted);
    const plugin = storeKinds.plugin.useInstalled(input, demand, admitted);
    const software = storeKinds.software.useInstalled(input, demand, admitted);
    const watchedService = useManagedWatchedServices(input, demand, admitted);
    const operationalFamilies = React.useMemo(() => ({ watchedService }), [watchedService]);
    const families = React.useMemo(() => ({ app, browserExtension, mcpServer, skill, agent, provider, plugin, software }),
        [app, browserExtension, mcpServer, skill, agent, provider, plugin, software]);
    const rows = React.useMemo<readonly ManagedInventoryRow[]>(() => [...app.rows, ...browserExtension.rows, ...mcpServer.rows, ...agent.rows, ...skill.rows,
        ...provider.rows, ...plugin.rows, ...software.rows, ...watchedService.rows],
        [app.rows, browserExtension.rows, mcpServer.rows, agent.rows, skill.rows, provider.rows, plugin.rows, software.rows, watchedService.rows]);
    const attentionQuery = React.useMemo(() => ({ ...input, presented: demand.presented }), [input, demand.presented]);
    const attention = useManagedInventoryAttention(attentionQuery, families, rows, admitted.scope);
    return React.useMemo(() => {
        const results = [...Object.values(families), watchedService];
        return { families, operationalFamilies, rows, ...summarizeInstalledFamilies(results), ...attention };
    }, [families, operationalFamilies, watchedService, rows, attention.attention, attention.noticeSource]);
}
