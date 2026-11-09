import { isDeepStrictEqual } from 'node:util';
import {
    MachineResourceAutomaticActionV1Schema,
    type MachineResourceAutomaticActionV1,
    type MachinePublishedResourceSummaryV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { composeMachineResourceAttentionV1, deriveMachineVitalsAttentionV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAttentionV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { MachineGuardStateV1Schema, type MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';

export interface MachineResourceSummary {
    getSummary(): MachinePublishedResourceSummaryV1 | null;
    refresh(): void;
    reportAutomaticAction(action: MachineResourceAutomaticActionV1): void;
    setGuardState(state: MachineGuardStateV1): void;
    attachPublication(apiMachine: Pick<ApiMachineClient, 'updateDaemonState' | 'onConnectionStateChange'>, isQuiescing: () => boolean): () => void;
    stop(): void;
}

export function createMachineResourceSummary(input: Readonly<{
    sampler: MachineVitalsSampler;
    readNearlyFull: () => { freeFraction: number } | { freeBytes: number } | null;
    nowMs?: () => number;
    onError: (error: unknown) => void;
}>): MachineResourceSummary {
    const nowMs = input.nowMs ?? Date.now;
    let current: MachinePublishedResourceSummaryV1 | null = null;
    let lastAutomaticAction: MachineResourceAutomaticActionV1 | undefined;
    let guard: MachineGuardStateV1 | undefined;
    let failureSince: number | null = null;
    let publishedIdentity: string | null = null;
    const publications = new Set<() => void>();
    const releasePublications = new Set<() => void>();

    const refresh = () => {
        const host = input.sampler.host();
        const state = input.sampler.state();
        if (!host && state.state === 'reporting') return;
        if (state.state === 'reporting') failureSince = null;
        else failureSince ??= nowMs();
        const unavailable = state.state === 'unavailable' && (current === null || current.vitals.state === 'unavailable'
            || state.reason === 'helper_missing' || nowMs() - (failureSince ?? nowMs()) >= 60_000);
        const sample = input.sampler.latest();
        const recent = sample ? input.sampler.samplesSince(sample.sampledAt - 60_000 - sample.intervalMs) : [];
        const reasons = state.state === 'reporting'
            ? deriveMachineVitalsAttentionV1({ recent, previous: current?.attention.reasons.filter(reason => reason.kind !== 'guard_out_of_steps') ?? [], nearlyFull: input.readNearlyFull() })
            : current?.attention.reasons.filter(reason => reason.kind !== 'guard_out_of_steps') ?? [];
        const guardReasons = guard?.episode?.state === 'out_of_steps' ? [{ key: 'guard:out_of_steps', kind: 'guard_out_of_steps' as const,
            level: 'needs_you' as const, since: guard.episode.since, metric: 'memory' as const, nextStep: 'review_processes' as const }] : [];
        const common = { v: 1 as const, attention: composeMachineResourceAttentionV1([reasons, guardReasons]),
            ...(guard ? { guard } : {}),
            ...(lastAutomaticAction ? { lastAutomaticAction } : {}) };
        let next = current;
        if (unavailable && state.state === 'unavailable') next = { ...common,
            vitals: { state: 'unavailable', since: failureSince ?? nowMs(), reason: state.reason === 'helper_missing' ? 'helper_missing' : 'reader_failed' },
            ...(host ? { host } : {}) };
        else if (host) next = { ...common, host, vitals: { state: 'reporting' } };
        if (!next) return;
        // Keep unchanged observations stable, including for in-process readers.
        // A changed reason's facts still advance locally even within the same published transition.
        if (!isDeepStrictEqual(current, next)) current = next;
        // Samples and changing byte counters stay in vitals; only resource transitions are public.
        const identity = JSON.stringify({
            host: next.host,
            vitals: next.vitals,
            attention: { level: next.attention.level, reasons: next.attention.reasons.map(({ key, level }) => ({ key, level })) },
            lastAutomaticAction: next.lastAutomaticAction,
            guard: next.guard,
        });
        if (identity !== publishedIdentity) {
            publishedIdentity = identity;
            for (const publish of publications) publish();
        }
    };
    const unsubscribe = input.sampler.subscribe(refresh);
    refresh();
    return {
        getSummary: () => current,
        refresh,
        reportAutomaticAction: (action) => { lastAutomaticAction = MachineResourceAutomaticActionV1Schema.parse(action); refresh(); },
        setGuardState: (state) => { guard = MachineGuardStateV1Schema.parse(state); refresh(); },
        attachPublication: (apiMachine, isQuiescing) => {
            let online = false;
            let attached = true;
            const publish = () => {
                if (!attached || !online || !current || isQuiescing()) return;
                void apiMachine.updateDaemonState(state => {
                    const next = state ?? { status: 'running' as const };
                    return attached && current && !isQuiescing() ? { ...next, resources: current } : next;
                }).catch(input.onError);
            };
            publications.add(publish);
            const releaseConnection = apiMachine.onConnectionStateChange(state => {
                const wasOnline = online;
                online = state.phase === 'online';
                if (online && !wasOnline) publish();
            });
            const release = () => {
                if (!attached) return;
                attached = false;
                publications.delete(publish);
                releasePublications.delete(release);
                releaseConnection();
            };
            releasePublications.add(release);
            return release;
        },
        stop: () => { unsubscribe(); for (const release of releasePublications) release(); },
    };
}
