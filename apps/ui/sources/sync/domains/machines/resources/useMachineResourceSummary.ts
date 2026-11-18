import * as React from 'react';
import type { MachineResourceAttentionV1, MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { EMPTY_MACHINE_RESOURCE_STATE, isMachineResourceStateStale, machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';
import { readMachineResourceObservation, type MachineVitalsPublication } from './machineResourceAvailability';
import { readMachineMonitoringMode } from './useMachineMonitoringMode';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type MachineResourceAvailability =
    | Readonly<{ kind: 'reporting'; summary: MachineResourceSummaryV1 | null; freshness: 'live' | 'held' | 'stale';
        /** A failed watch retains values while its existing observation lifecycle recovers. */
        readStatus?: 'slow' | 'error';
        /** Canonical attention is separate from transient metric values; absence is unknown. */
        attention?: MachineResourceAttentionV1 | null }>
    | Readonly<{ kind: 'never_sampled' }>
    | Readonly<{ kind: 'monitoring_off' }>
    | Readonly<{ kind: 'unavailable'; errorCode?: string }>
    | Readonly<{ kind: 'not_reported'; reason: 'older_happier' | 'unsupported' }>;

const NEVER_SAMPLED: MachineResourceAvailability = { kind: 'never_sampled' };
const MONITORING_OFF: MachineResourceAvailability = { kind: 'monitoring_off' };
const OLDER_HAPPIER: MachineResourceAvailability = { kind: 'not_reported', reason: 'older_happier' };
const UNSUPPORTED: MachineResourceAvailability = { kind: 'not_reported', reason: 'unsupported' };
const UNAVAILABLE: MachineResourceAvailability = { kind: 'unavailable' };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Row-local read of already demanded state; this hook is deliberately passive. */
export function useMachineResourceSummary(input: MachineResourceKey): MachineResourceAvailability | null {
    const target = useMachineDaemonReadIdentities([input])[0]!;
    const presence = useMachinePresenceSummary(target.key.serverId, input.machineId);
    const selectMachine = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => resolveServerScopedMachine(state, target.key.serverId, input.machineId), [input.machineId, target.key.serverId]);
    // Exact facts of the row, not the record: a daemon publication that changes none of them renders nothing.
    const hasMachine = storage(React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => selectMachine(state) !== null, [selectMachine]));
    const metadata = storage(React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => selectMachine(state)?.metadata ?? null, [selectMachine]));
    const daemonResources = storage(React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => {
        const daemonState: unknown = selectMachine(state)?.daemonState;
        return isRecord(daemonState) ? daemonState.resources ?? null : null;
    }, [selectMachine]));
    const monitoring = React.useMemo(() => readMachineMonitoringMode(metadata), [metadata]);
    const viewed = target.enabled;
    const key = React.useMemo(() => ({ ...target.key, view: 'summary' as const }), [target.key]);
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, target.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const stale = isMachineResourceStateStale(state, Date.now());
    // Keyed by the published facts, not the daemon-state carrier: another field's publication keeps this row's answer.
    const resources = daemonResources;
    const vitals = isRecord(resources) ? resources.vitals : null;
    const vitalsState = isRecord(vitals) && (vitals.state === 'reporting' || vitals.state === 'unavailable') ? vitals.state : null;
    const vitalsReason = isRecord(vitals) && typeof vitals.reason === 'string' ? vitals.reason : null;
    const vitalsSince = isRecord(vitals) && typeof vitals.since === 'number' ? vitals.since : null;
    const publication = React.useMemo<MachineVitalsPublication | null>(() => vitalsState
        ? { state: vitalsState, reason: vitalsReason, since: vitalsSince } : null, [vitalsReason, vitalsSince, vitalsState]);
    const retainedResources = React.useRef<ReturnType<typeof readMachineVitalsResourcesProjectionV1>>(undefined);
    const publishedResources = React.useMemo(() => retainedResources.current = retainDeep(retainedResources.current,
        readMachineVitalsResourcesProjectionV1(resources === null ? null : { resources })), [resources]);
    const publishedAttention = publishedResources?.attention ?? null;
    const publishedHost = publishedResources?.host;
    React.useEffect(() => {
        if (target.accountMatches) machineResourceStore.setPublishedHost(key, publishedHost);
    }, [key, publishedHost, target.accountMatches]);
    React.useEffect(() => {
        if (publishedAttention) machineResourceStore.setPublishedAttention(key, publishedAttention);
    }, [key, publishedAttention, state.snapshot?.attention, state.snapshot?.sample?.sampledAt]);
    // Daemon versions reach the resource owner from the store directly; they are not a render input of this row.
    React.useEffect(() => {
        if (!key.expectedAccountId) return;
        const report = () => {
            const machine = selectMachine(storage.getState());
            if (machine) machineResourceStore.daemonStateChanged(key, machine.daemonStateVersion);
        };
        report();
        return storage.subscribe(report, { machines: true, machineListByServerId: true, machineRecordsByServerId: true });
    }, [input.machineId, key, selectMachine]);
    const online = hasMachine ? presence.reachability === 'reachable' : true;
    return React.useMemo<MachineResourceAvailability | null>(() => {
        const observation = readMachineResourceObservation({ ...state, stale }, publication);
        if (!target.accountMatches) return null;
        if (monitoring === 'off') return MONITORING_OFF;
        if (state.status === 'not_reported') return OLDER_HAPPIER;
        if (observation.unsupported) return UNSUPPORTED;
        if (state.status === 'error' && !state.summary) return state.errorCode ? { kind: 'unavailable', errorCode: state.errorCode } : UNAVAILABLE;
        if (state.snapshot?.state === 'reporting' && !state.snapshot.sample) return NEVER_SAMPLED;
        // An unanswered read (including metadata hydration) establishes no support fact.
        if (!state.snapshot && !publication) return null;
        const { readStatus } = observation;
        const freshness = observation.freshness === 'live' && (!viewed || !online) ? 'held' : observation.freshness;
        return { kind: 'reporting', summary: state.summary, freshness,
            ...(readStatus ? { readStatus } : {}),
            attention: publishedAttention ?? state.snapshot?.attention ?? null };
    }, [monitoring, online, publication, publishedAttention, stale, state, target.accountMatches, viewed]);
}

/** A surface's retained summaries are being revalidated by the same demand owner. */
export function useMachineResourceRefreshing(inputs: readonly MachineResourceKey[], view: MachineVitalsView = 'summary'): boolean {
    const identities = useMachineDaemonReadIdentities(inputs);
    const keys = React.useMemo(() => identities.filter(identity => identity.accountMatches)
        .map(identity => ({ ...identity.key, view })), [identities, view]);
    const subscribe = React.useCallback((listener: () => void) => {
        const releases = keys.flatMap(key => [
            machineResourceStore.observe(key, listener),
            machineResourceStore.observeRefreshing(key, listener),
        ]);
        return () => { for (const release of releases) release(); };
    }, [keys]);
    const read = React.useCallback(() => keys.some(key => {
        const state = machineResourceStore.getState(key);
        return state.summary !== null && machineResourceStore.isRefreshing(key);
    }), [keys]);
    return React.useSyncExternalStore(subscribe, read, read);
}
