import * as React from 'react';
import { storeKinds, type InstalledRow, type StoreDemand, type StoreInstalledInput } from '../catalog/storeKinds';
import { useManagedInventoryAttention } from './useManagedInventoryAttention';
import { useManagedConfiguredChecks, useManagedSetup, useManagedWatchedServices, type ManagedConfiguredCheckRow, type ManagedSetupRow,
    type ManagedWatchedServiceRow } from './managedOperationalInventory';
import { useInstalledScope } from '../catalog/storeAccountAdmission';

export type ManagedInventoryRow = InstalledRow | ManagedWatchedServiceRow | ManagedSetupRow | ManagedConfiguredCheckRow;

export type ManagedInventoryQuery = StoreInstalledInput & StoreDemand;
export type ManagedInventoryFamilies = Readonly<{
    [Kind in keyof typeof storeKinds]: ReturnType<(typeof storeKinds)[Kind]['useInstalled']>;
}>;
export type ManagedInventoryView = Readonly<{
    families: ManagedInventoryFamilies;
    operationalFamilies: Readonly<{
        watchedService: ReturnType<typeof useManagedWatchedServices>;
        setup: ReturnType<typeof useManagedSetup>;
        configuredCheck: ReturnType<typeof useManagedConfiguredChecks>;
    }>;
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
    const setup = useManagedSetup(input, demand, admitted);
    const configuredCheck = useManagedConfiguredChecks(input, demand, admitted);
    const operationalFamilies = React.useMemo(() => ({ watchedService, setup, configuredCheck }), [watchedService, setup, configuredCheck]);
    const families = React.useMemo(() => ({ app, browserExtension, mcpServer, skill, agent, provider, plugin, software }),
        [app, browserExtension, mcpServer, skill, agent, provider, plugin, software]);
    const rows = React.useMemo<readonly ManagedInventoryRow[]>(() => [...app.rows, ...browserExtension.rows, ...mcpServer.rows, ...agent.rows, ...skill.rows,
        ...provider.rows, ...plugin.rows, ...software.rows, ...setup.rows, ...watchedService.rows, ...configuredCheck.rows],
        [app.rows, browserExtension.rows, mcpServer.rows, agent.rows, skill.rows, provider.rows, plugin.rows, software.rows, setup.rows, watchedService.rows, configuredCheck.rows]);
    const attentionQuery = React.useMemo(() => ({ ...input, presented: demand.presented }), [input, demand.presented]);
    const attention = useManagedInventoryAttention(attentionQuery, families, rows, admitted.scope);
    return React.useMemo(() => {
        // Checks claim no Machine, so on a Machine door they neither add to nor soften that Machine's own coverage.
        const results = [...Object.values(families), watchedService, setup, ...(input.machine ? [] : [configuredCheck])];
        return { families, operationalFamilies, rows, ...summarizeInstalledFamilies(results), ...attention };
    }, [families, operationalFamilies, watchedService, setup, configuredCheck, input.machine, rows, attention.attention, attention.noticeSource]);
}
