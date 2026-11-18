import * as React from 'react';
import { storeKinds, type InstalledFamilyResult, type InstalledRow, type StoreDemand, type StoreInstalledInput } from '../catalog/storeKinds';
import { useManagedInventoryAttention } from './useManagedInventoryAttention';
import { useManagedConfiguredBackups, useManagedConfiguredChecks, useManagedSetup, useManagedWatchedServices, type ManagedConfiguredBackupRow, type ManagedConfiguredCheckRow, type ManagedSetupRow,
    type ManagedWatchedServiceRow } from './managedOperationalInventory';
import { useInstalledScope } from '../catalog/storeAccountAdmission';

export type ManagedInventoryRow = InstalledRow | ManagedWatchedServiceRow | ManagedSetupRow | ManagedConfiguredCheckRow | ManagedConfiguredBackupRow;

export type ManagedInventoryKind = ManagedInventoryRow['kind'];
export type ManagedInventoryQuery = StoreInstalledInput & StoreDemand & Readonly<{ kinds?: readonly ManagedInventoryKind[] }>;
const HIDDEN_DEMAND: StoreDemand = Object.freeze({ presented: false });
const PRESENTED_DEMAND: StoreDemand = Object.freeze({ presented: true });
export type ManagedInventoryFamilies = Readonly<{
    [Kind in keyof typeof storeKinds as (typeof storeKinds)[Kind]['useInstalled'] extends undefined ? never : Kind]:
        ReturnType<Extract<(typeof storeKinds)[Kind]['useInstalled'], (...args: never[]) => unknown>>;
}>;
export type ManagedInventoryView = Readonly<{
    families: ManagedInventoryFamilies;
    operationalFamilies: Readonly<{
        watchedService: ReturnType<typeof useManagedWatchedServices>;
        setup: ReturnType<typeof useManagedSetup>;
        configuredCheck: ReturnType<typeof useManagedConfiguredChecks>;
        configuredBackup: ReturnType<typeof useManagedConfiguredBackups>;
    }>;
    rows: readonly ManagedInventoryRow[];
    coverage: 'complete' | 'partial' | 'unavailable';
    loading: boolean;
    attention: ReturnType<typeof useManagedInventoryAttention>['attention'];
    noticeSource: ReturnType<typeof useManagedInventoryAttention>['noticeSource'];
}>;

/** Summary only; callers retain each original family for reason, recovery and paging. */
export function summarizeInstalledFamilies(results: readonly InstalledFamilyResult<unknown, unknown, unknown>[]) {
    const loading = results.some(family => family.coverage === 'loading');
    const coverage = results.length > 0 && results.every(family => typeof family.coverage === 'object' && 'unavailable' in family.coverage)
        ? 'unavailable' : results.every(family => family.coverage === 'available')
            ? 'complete' : 'partial';
    return { loading, coverage } as const;
}

/** One Account admission; native adapters retain membership and acquisition authority. */
export function useManagedInventory(query: ManagedInventoryQuery): ManagedInventoryView {
    const input = React.useMemo<StoreInstalledInput>(() => ({ scope: query.scope, machine: query.machine,
        projectKey: query.projectKey }), [query.scope, query.machine, query.projectKey]);
    const requested = (kind: ManagedInventoryKind) => query.kinds === undefined || query.kinds.includes(kind);
    const demand = (kind: ManagedInventoryKind) => query.presented && requested(kind) ? PRESENTED_DEMAND : HIDDEN_DEMAND;
    // Backups project the App page, so they share its acquisition without exposing unrequested App rows.
    const appDemand = query.presented && (requested('app') || requested('configuredBackup')) ? PRESENTED_DEMAND : HIDDEN_DEMAND;
    const admitted = useInstalledScope(input);
    const acquiredApps = storeKinds.app.useInstalled(input, appDemand, admitted);
    const backupProjection = useManagedConfiguredBackups(acquiredApps);
    const appPresented = demand('app').presented;
    const backupPresented = demand('configuredBackup').presented;
    const app = React.useMemo(() => appPresented ? acquiredApps : { ...acquiredApps, rows: [] }, [acquiredApps, appPresented]);
    const configuredBackup = React.useMemo(() => backupPresented ? backupProjection : { ...backupProjection, rows: [] }, [backupProjection, backupPresented]);
    const browserExtension = storeKinds.browserExtension.useInstalled(input, demand('browserExtension'), admitted);
    const mcpServer = storeKinds.mcpServer.useInstalled(input, demand('mcpServer'), admitted);
    const skill = storeKinds.skill.useInstalled(input, demand('skill'), admitted);
    const agent = storeKinds.agent.useInstalled(input, demand('agent'), admitted);
    const provider = storeKinds.provider.useInstalled(input, demand('provider'), admitted);
    const plugin = storeKinds.plugin.useInstalled(input, demand('plugin'), admitted);
    const software = storeKinds.software.useInstalled(input, demand('software'), admitted);
    const theme = storeKinds.theme.useInstalled(input, demand('theme'), admitted);
    const watchedService = useManagedWatchedServices(input, demand('watchedService'), admitted);
    const setup = useManagedSetup(input, demand('setup'), admitted);
    const configuredCheck = useManagedConfiguredChecks(input, demand('configuredCheck'), admitted);
    const operationalFamilies = React.useMemo(() => ({ watchedService, setup, configuredCheck, configuredBackup }), [watchedService, setup, configuredCheck, configuredBackup]);
    const families = React.useMemo(() => ({ app, browserExtension, mcpServer, skill, agent, provider, plugin, software, theme }),
        [app, browserExtension, mcpServer, skill, agent, provider, plugin, software, theme]);
    const rows = React.useMemo<readonly ManagedInventoryRow[]>(() => [...app.rows, ...browserExtension.rows, ...mcpServer.rows, ...agent.rows, ...skill.rows,
        ...provider.rows, ...plugin.rows, ...software.rows, ...theme.rows, ...setup.rows, ...watchedService.rows, ...configuredCheck.rows, ...configuredBackup.rows].filter(row => query.presented && (query.kinds === undefined || query.kinds.includes(row.kind))),
        [query.presented, query.kinds, app.rows, browserExtension.rows, mcpServer.rows, agent.rows, skill.rows, provider.rows, plugin.rows, software.rows, theme.rows, setup.rows, watchedService.rows, configuredCheck.rows, configuredBackup.rows]);
    const attentionQuery = React.useMemo(() => ({ ...input, presented: query.presented }), [input, query.presented]);
    const attention = useManagedInventoryAttention(attentionQuery, families, rows, admitted.scope);
    return React.useMemo(() => {
        // Checks claim no Machine, so on a Machine door they neither add to nor soften that Machine's own coverage.
        const results = [...Object.entries(families).filter(([kind]) =>
            (kind !== 'theme' || families.theme.appliesToScope)
            && (query.kinds === undefined || query.kinds.includes(kind as keyof ManagedInventoryFamilies))).map(([, family]) => family),
            ...(requested('configuredBackup') && !requested('app') ? [configuredBackup] : []),
            ...(requested('watchedService') ? [watchedService] : []), ...(requested('setup') ? [setup] : []),
            ...(!input.machine && requested('configuredCheck') ? [configuredCheck] : [])];
        return { families, operationalFamilies, rows, ...summarizeInstalledFamilies(results), ...attention };
    }, [query.kinds, families, operationalFamilies, watchedService, setup, configuredCheck, configuredBackup, input.machine, rows, attention.attention, attention.noticeSource]);
}
