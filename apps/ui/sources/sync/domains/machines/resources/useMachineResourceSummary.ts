import * as React from 'react';
import type { MachineResourceAttentionV1, MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachineDaemonReadIdentities, useMachineDaemonRevisionObserver } from '../useMachineDaemonReadTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { EMPTY_MACHINE_RESOURCE_STATE, isMachineResourceStateStale, machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';
import { readMachineResourceObservation, type MachineResourceObservation, type MachineVitalsPublication } from './machineResourceAvailability';
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
    const monitoring = React.useMemo(() => readMachineMonitoringMode(metadata), [metadata]);
    const viewed = target.enabled;
    const key = React.useMemo(() => ({ ...target.key, view: 'summary' as const }), [target.key]);
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, target.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const stale = isMachineResourceStateStale(state, Date.now());
    // Retain the published answer over resource arrivals that do not change its availability,
    // attention or host facts. Failure timestamps matter only against the live reporting sample.
    const selectPublication = React.useMemo(() => {
        let lastResources: unknown;
        let last: (Pick<NonNullable<ReturnType<typeof readMachineVitalsResourcesProjectionV1>>, 'host' | 'attention'>
            & Readonly<{ available: boolean; observation: MachineResourceObservation }>) | undefined;
        return (storageState: Parameters<typeof resolveServerScopedMachine>[0]) => {
            const daemonState: unknown = selectMachine(storageState)?.daemonState;
            const resources = isRecord(daemonState) ? daemonState.resources ?? null : null;
            if (last && lastResources === resources) return last;
            lastResources = resources;
            const vitals = isRecord(resources) ? resources.vitals : null;
            const publication: MachineVitalsPublication | null = isRecord(vitals)
                && (vitals.state === 'reporting' || vitals.state === 'unavailable') ? {
                    state: vitals.state,
                    reason: typeof vitals.reason === 'string' ? vitals.reason : null,
                    since: typeof vitals.since === 'number' ? vitals.since : null,
                } : null;
            const parsed = readMachineVitalsResourcesProjectionV1(resources === null ? null : { resources });
            last = retainDeep(last, {
                available: publication !== null,
                observation: readMachineResourceObservation({ ...state, stale }, publication),
                host: parsed?.host,
                attention: parsed?.attention,
            });
            return last;
        };
    }, [selectMachine, stale, state]);
    const { available, attention: publishedAttention, host: publishedHost, observation } = storage(selectPublication);
    React.useEffect(() => {
        if (target.accountMatches) machineResourceStore.setPublishedHost(key, publishedHost);
    }, [key, publishedHost, target.accountMatches]);
    React.useEffect(() => {
        if (publishedAttention) machineResourceStore.setPublishedAttention(key, publishedAttention);
    }, [key, publishedAttention, state.snapshot?.attention, state.snapshot?.sample?.sampledAt]);
    useMachineDaemonRevisionObserver(key, React.useCallback(version => {
        machineResourceStore.daemonStateChanged(key, version);
    }, [key]));
    const online = hasMachine ? presence.reachability === 'reachable' : true;
    return React.useMemo<MachineResourceAvailability | null>(() => {
        if (!target.accountMatches) return null;
        if (monitoring === 'off') return MONITORING_OFF;
        if (state.status === 'not_reported') return OLDER_HAPPIER;
        if (observation.unsupported) return UNSUPPORTED;
        if (state.status === 'error' && !state.summary) return state.errorCode ? { kind: 'unavailable', errorCode: state.errorCode } : UNAVAILABLE;
        if (state.snapshot?.state === 'reporting' && !state.snapshot.sample) return NEVER_SAMPLED;
        // An unanswered read (including metadata hydration) establishes no support fact.
        if (!state.snapshot && !available) return null;
        const { readStatus } = observation;
        const freshness = observation.freshness === 'live' && (!viewed || !online) ? 'held' : observation.freshness;
        return { kind: 'reporting', summary: state.summary, freshness,
            ...(readStatus ? { readStatus } : {}),
            attention: publishedAttention ?? state.snapshot?.attention ?? null };
    }, [available, monitoring, observation, online, publishedAttention, state, target.accountMatches, viewed]);
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
