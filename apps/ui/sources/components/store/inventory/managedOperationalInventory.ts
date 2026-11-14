import * as React from 'react';
import { useConfiguredHealthResults } from './useConfiguredHealthResults';
import { configuredHealthResultsForTrigger, CONFIGURED_HEALTH_LOADING, type ConfiguredHealthResultsState } from './configuredHealthResults';
import type { Machine, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useInstalledMachines } from '../catalog/storeInstalled';
import type { InstalledScopeAdmission } from '../catalog/storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from '../catalog/storeKinds';
import type { MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { machineSetupSourceOriginKeyV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { useAutomationDefinitionNextCursor, useAutomations, useIsDataReady } from '@/sync/store/hooks';
import { isPluginEventAutomationTrigger, type AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { machineSetupSourceName } from '@/components/machines/setup/machineSetupSourceName';
import { t } from '@/text';
import type { InstalledAppRow, InstalledAppsResult } from '../catalog/storeApps';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useConfiguredCheckDefinitions, configuredCheckDefinitionKey, CONFIGURED_CHECK_DEFINITION_LOADING, type ConfiguredCheckDefinitionFacts } from './useConfiguredCheckDefinitions';

/** Saved backup configuration, independent of whether a backup has ever run. */
export type ManagedConfiguredBackupRow = Omit<InstalledAppRow, 'kind'> & Readonly<{ kind: 'configuredBackup' }>;
const EMPTY_BACKUP_ROWS: readonly ManagedConfiguredBackupRow[] = Object.freeze([]);

/** Project the already acquired App page; deployment owns membership, coverage, paging and invalidation. */
export function useManagedConfiguredBackups(app: InstalledAppsResult) {
    const previous = React.useRef(EMPTY_BACKUP_ROWS);
    const rows = React.useMemo(() => {
        const retained = new Map(previous.current.map(row => [row.key, row]));
        const next = app.rows.filter(row => row.native.backupConfigured === true).map((row): ManagedConfiguredBackupRow => {
            const key = serverAccountScopedResourceKey(row.scope, 'configured-backup', row.native.environment.id);
            const held = retained.get(key);
            if (held?.native === row.native && held.scope === row.scope && held.projectKeys === row.projectKeys && held.projectSource === row.projectSource) return held;
            return { ...row, kind: 'configuredBackup', key, home: buildDeploymentEnvironmentHref({
                serverId: row.native.environment.serverId, projectSourceId: row.native.environment.projectSourceId,
                environmentId: row.native.environment.id, tab: 'settings', section: 'backups',
            }) };
        });
        if (next.length !== previous.current.length || next.some((row, index) => row !== previous.current[index])) {
            previous.current = next.length === 0 ? EMPTY_BACKUP_ROWS : next;
        }
        return previous.current;
    }, [app.rows]);
    return React.useMemo(() => ({ ...app, rows }), [app, rows]);
}

export type ManagedWatchedServiceRow = Readonly<{
    kind: 'watchedService'; key: string; scope: ServerAccountScope; machineId: string;
    native: NonNullable<MachineMetadata['serviceWatchesV1']>['watches'][number];
}>;
type NativeReason = NonNullable<InstalledScopeAdmission['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['snapshot']>;
type WatchedServiceResult = InstalledFamilyResult<ManagedWatchedServiceRow, NativeReason, never>;
const EMPTY_ROWS: readonly ManagedWatchedServiceRow[] = Object.freeze([]);
type WatchedProjection = Readonly<{ rows: readonly ManagedWatchedServiceRow[]; missing: boolean }>;
const EMPTY_WATCHED: WatchedProjection = Object.freeze({ rows: EMPTY_ROWS, missing: false });

/** One attached preset on one Machine. Present from the moment it is attached, whether or not it has run. */
export type ManagedSetupRow = Readonly<{
    kind: 'setup'; key: string; scope: ServerAccountScope; machineId: string;
    source: Exclude<MachineSetupSourceEntryV1, { kind: 'direct' }>;
    name: string; itemCount: number;
}>;
type SetupResult = InstalledFamilyResult<ManagedSetupRow, NativeReason, never>;
type SetupRecord = Omit<ManagedSetupRow, 'name' | 'itemCount'>;
const EMPTY_SETUP_ROWS: readonly ManagedSetupRow[] = Object.freeze([]);
const EMPTY_SETUP_RECORDS: Readonly<{ records: readonly SetupRecord[]; missing: boolean }> = Object.freeze({ records: Object.freeze([]), missing: false });
const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

/** A saved Check, known from its Automation summary alone, so one that has never run is still listed. */
export type ManagedConfiguredCheckRow = Readonly<{
    kind: 'configuredCheck'; key: string; scope: ServerAccountScope; automationId: string; triggerId: string; native: AutomationDefinition;
    lastResults: ConfiguredHealthResultsState;
    definitionFacts: ConfiguredCheckDefinitionFacts;
}>;
type ConfiguredCheckResult = InstalledFamilyResult<ManagedConfiguredCheckRow, NativeReason | 'automation_page' | 'check_definition' | 'domain_page' | 'health_result_page' | 'health_result_unavailable' | 'health_result_loading', () => void>;
const EMPTY_CHECK_ROWS: readonly ManagedConfiguredCheckRow[] = Object.freeze([]);

/** P30 records only adopted Machine watches here; Environment services stay with their App. */
export function useManagedWatchedServices(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): WatchedServiceResult {
    const held = useInstalledMachines(input, demand, admitted.scope);
    const projectRows = React.useMemo(() => {
        let previous: WatchedProjection = EMPTY_WATCHED;
        return (records: readonly Machine[], machines: ReturnType<typeof useInstalledMachines>['machines'], enabled: boolean): WatchedProjection => {
            if (!admitted.scope || !enabled) return EMPTY_WATCHED;
            const visible = new Set(machines.map(machine => machine.id));
            const byKey = new Map(previous.rows.map(row => [row.key, row]));
            // A visible Machine whose content isn't readable yet may hold watches: it leaves the family partial (as Setup).
            let missing = false;
            const next = records.flatMap(machine => {
                if (!visible.has(machine.id)) return [];
                if (!machine.metadata || machine.availability?.kind !== 'available' || machine.access && machine.access.accessState !== 'ready') {
                    missing = true;
                    return [];
                }
                return (machine.metadata.serviceWatchesV1?.watches ?? []).map(native => {
                    const scope = admitted.scope!;
                    const key = serverAccountScopedResourceKey(scope, 'watched-service', machine.id, native.watchId);
                    const retained = byKey.get(key);
                    return retained?.native === native ? retained : {
                        kind: 'watchedService' as const, key, scope, machineId: machine.id, native,
                    };
                });
            });
            const unchanged = next.length === previous.rows.length && next.every((row, index) => row === previous.rows[index]);
            if (!unchanged || missing !== previous.missing) previous = { rows: unchanged ? previous.rows : next, missing };
            return previous;
        };
    // The projection retains native watch identities across Machine metadata/liveness carriers.
    }, [admitted.scope]);
    const projecting = demand.presented && !input.projectKey && !held.failure;
    // Selected from the Home's list: another Machine's daemon publication that changes no watch keeps the rows.
    const { rows, missing } = useMachineListForServerSelection(admitted.scope?.serverId ?? '', React.useCallback(
        (records: readonly Machine[]) => projectRows(records, held.machines, projecting), [projectRows, held.machines, projecting]));
    return React.useMemo<WatchedServiceResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        const snapshot = held.snapshot;
        if (!demand.presented || !snapshot) return { rows: EMPTY_ROWS, coverage: 'loading' };
        if (input.projectKey) return { rows: EMPTY_ROWS, coverage: 'available' };
        return { rows, coverage: !missing && snapshot.kind === 'resolved' && snapshot.settled && snapshot.observation === 'live'
            ? 'available' : { partial: snapshot } };
    }, [admitted.scope, admitted.coverage, held.failure, held.snapshot, demand.presented, input.projectKey, rows, missing]);
}

/** Attached presets from each Machine's recorded Setup. Directly added items are its Software rows, so they are not repeated here. */
export function useManagedSetup(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): SetupResult {
    const held = useInstalledMachines(input, demand, admitted.scope, !input.projectKey);
    const scope = admitted.scope;
    const projecting = demand.presented && !!scope && !input.projectKey;
    const last = React.useRef(EMPTY_SETUP_RECORDS);
    const select = React.useMemo(() => (records: readonly Machine[]) => {
        if (!projecting || !scope) return EMPTY_SETUP_RECORDS;
        const visible = new Set(held.machineIds);
        const byKey = new Map(last.current.records.map(record => [record.key, record]));
        const next: SetupRecord[] = [];
        let missing = false;
        for (const machine of records) {
            if (!visible.has(machine.id)) continue;
            if (!machine.metadata || machine.availability?.kind !== 'available' || machine.access && machine.access.accessState !== 'ready') { missing = true; continue; }
            for (const source of machine.metadata.setup?.sources ?? []) {
                if (source.kind === 'direct') continue;
                const key = serverAccountScopedResourceKey(scope, 'setup', machine.id, machineSetupSourceOriginKeyV1(source));
                const retained = byKey.get(key);
                next.push(retained?.source === source ? retained : { kind: 'setup', key, scope, machineId: machine.id, source });
            }
        }
        const unchanged = next.length === last.current.records.length && next.every((record, index) => record === last.current.records[index]);
        if (!unchanged || missing !== last.current.missing) last.current = { records: unchanged ? last.current.records : next, missing };
        return last.current;
    }, [held.machineIds, projecting, scope]);
    const setupDemand = React.useMemo(() => ({ machineIds: projecting ? held.machineIds : [],
        fields: [{ section: 'metadata', field: 'setup' }] as const }), [held.machineIds, projecting]);
    const selected = useMachineListForServerSelection(scope?.serverId ?? '', select, setupDemand);
    // The Account's preset names are read only when a Machine actually has one attached.
    const namesNeeded = selected.records.some(record => record.source.kind === 'accountPreset');
    const serverIds = React.useMemo(() => namesNeeded && scope ? [scope.serverId] : NO_SERVER_IDS, [namesNeeded, scope]);
    const { presetsByServerId, statesByServerId } = useMachinePresets(serverIds);
    const presets = scope ? presetsByServerId[scope.serverId] : undefined;
    const presetsSettled = !namesNeeded || !!scope && statesByServerId[scope.serverId]?.loading === false;
    const rows = React.useMemo<readonly ManagedSetupRow[]>(() => selected.records.length === 0 ? EMPTY_SETUP_ROWS : selected.records.map(record => ({
        ...record,
        name: record.source.kind === 'accountPreset' && !presetsSettled ? t('common.loading') : machineSetupSourceName(record.source, presets ?? []),
        itemCount: record.source.setup.items?.length ?? 0,
    })), [selected.records, presets, presetsSettled]);
    return React.useMemo<SetupResult>(() => {
        if (!scope) return { rows: EMPTY_SETUP_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_SETUP_ROWS, coverage: { unavailable: held.failure } };
        const snapshot = held.snapshot;
        if (!demand.presented || !snapshot) return { rows: EMPTY_SETUP_ROWS, coverage: 'loading' };
        if (snapshot.kind !== 'resolved') return { rows: EMPTY_SETUP_ROWS, coverage: { unavailable: snapshot } };
        // Setup is Machine-owned, with no per-Project membership claim.
        if (input.projectKey) return { rows: EMPTY_SETUP_ROWS, coverage: 'available' };
        const incomplete = selected.missing || snapshot.settled !== true || snapshot.observation !== 'live';
        return { rows, coverage: incomplete ? { partial: snapshot } : 'available' };
    }, [scope, admitted.coverage, held.failure, held.snapshot, demand.presented, input.projectKey, selected.missing, rows]);
}

/**
 * Saved Checks from the Account's Automation summaries, which name each one whether or not it has run. What a Check
 * watches lives in its private definition, so a Check claims no Machine and is left out of a Machine's own inventory.
 */
export function useManagedConfiguredChecks(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): ConfiguredCheckResult {
    const automations = useAutomations();
    const nextCursor = useAutomationDefinitionNextCursor();
    const ready = useIsDataReady();
    const scope = admitted.scope;
    const listed = demand.presented && !!scope && !input.projectKey && !input.machine;
    const lifetime = React.useMemo(() => admitted.binding ? readServerAccountScopeOwnerLifetime(admitted.binding) : null, [admitted.binding]);
    const definitions = useConfiguredCheckDefinitions(lifetime, listed, automations);
    const loadAutomations = React.useCallback(async () => {
        if (nextCursor) await (await import('@/sync/sync')).sync.loadMoreAutomations(nextCursor);
    }, [nextCursor]);
    const healthResults = useConfiguredHealthResults(scope, listed && automations.some(native => native.triggers.some(trigger =>
        isPluginEventAutomationTrigger(trigger) && trigger.eventRef.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1)));
    const previous = React.useRef(EMPTY_CHECK_ROWS);
    const rows = React.useMemo(() => {
        if (!listed || !scope) return EMPTY_CHECK_ROWS;
        const byKey = new Map(previous.current.map(row => [row.key, row]));
        const next = automations.flatMap(native => native.triggers.flatMap((trigger): ManagedConfiguredCheckRow[] => {
            if (!isPluginEventAutomationTrigger(trigger) || trigger.eventRef.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1) return [];
            const key = serverAccountScopedResourceKey(scope, 'configured-check', native.id, trigger.id);
            const retained = byKey.get(key);
            const lastResults = !healthResults ? CONFIGURED_HEALTH_LOADING : 'kind' in healthResults.value ? healthResults.value
                : configuredHealthResultsForTrigger(healthResults.value, native.id, trigger);
            const definitionFacts = definitions.byTrigger.get(configuredCheckDefinitionKey(native.id, trigger.id)) ?? CONFIGURED_CHECK_DEFINITION_LOADING;
            return [retained?.native === native && retained.lastResults === lastResults && retained.definitionFacts === definitionFacts ? retained
                : { kind: 'configuredCheck', key, scope, automationId: native.id, triggerId: trigger.id, native, lastResults, definitionFacts }];
        }));
        if (next.length !== previous.current.length || next.some((row, index) => row !== previous.current[index])) previous.current = next.length === 0 ? EMPTY_CHECK_ROWS : next;
        return previous.current;
    }, [automations, listed, scope, healthResults, definitions.byTrigger]);
    return React.useMemo<ConfiguredCheckResult>(() => {
        if (!scope) return { rows: EMPTY_CHECK_ROWS, coverage: admitted.coverage };
        if (input.projectKey || input.machine) return { rows: EMPTY_CHECK_ROWS, coverage: 'available' };
        if (!demand.presented || !ready) return { rows: EMPTY_CHECK_ROWS, coverage: 'loading' };
        if (nextCursor !== null) return { rows, coverage: { partial: 'automation_page' }, continuation: loadAutomations };
        if (rows.length === 0) return { rows, coverage: 'available' };
        if (rows.some(row => row.definitionFacts.kind !== 'available')) return { rows, coverage: { partial: 'check_definition' } };
        if (definitions.domainsPending || definitions.domainContinuation) return { rows, coverage: { partial: 'domain_page' }, continuation: definitions.domainContinuation };
        if (!healthResults) return { rows, coverage: { partial: 'health_result_loading' } };
        if ('kind' in healthResults.value) return { rows, coverage: { partial: 'health_result_unavailable' }, continuation: healthResults.loadNext };
        const partial = healthResults.value.preceding || healthResults.value.nextCursor !== undefined;
        return { rows, coverage: partial ? { partial: 'health_result_page' } : 'available',
            ...(partial ? { continuation: healthResults.loadNext } : {}) };
    }, [scope, admitted.coverage, input.projectKey, input.machine, demand.presented, ready, rows, nextCursor, healthResults, loadAutomations, definitions.domainsPending, definitions.domainContinuation]);
}
