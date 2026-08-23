import {
    applyPeerMediationObservabilityEventToFlowSnapshot,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityFlowSnapshotV1,
    type PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

import {
    peerMediationObservabilityFlowKey,
    peerMediationObservabilityMachineKey,
    peerMediationObservabilityScopesEqual,
    peerMediationObservabilityScopeKey,
} from './keys';
import type {
    PeerMediationObservabilityFlowEntry,
    PeerMediationObservabilityScopeState,
    PeerMediationObservabilitySource,
    PeerMediationObservabilitySourceFamily,
    PeerMediationObservabilityUiStore,
} from './types';

export function createPeerMediationObservabilityUiStore(): PeerMediationObservabilityUiStore {
    return {
        scopesByKey: {},
    };
}

function createEmptyScopeState(
    scope: PeerMediationObservabilitySnapshotV1['scope'],
): PeerMediationObservabilityScopeState {
    const scopeKey = peerMediationObservabilityScopeKey(scope);
    return {
        scope,
        scopeKey,
        status: 'idle',
        stale: false,
        unavailableReasonCode: null,
        lastAppliedSequenceBySource: {},
        staleSourceBySource: {},
        flowsByKey: {},
    };
}

function createScopeState(snapshot: PeerMediationObservabilitySnapshotV1): PeerMediationObservabilityScopeState {
    return createEmptyScopeState(snapshot.scope);
}

export function applyPeerMediationObservabilityUnavailable(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilitySnapshotV1['scope'];
        reasonCode: string;
    }>,
): PeerMediationObservabilityUiStore {
    const scopeKey = peerMediationObservabilityScopeKey(input.scope);
    return {
        scopesByKey: {
            ...state.scopesByKey,
            [scopeKey]: {
                ...createEmptyScopeState(input.scope),
                status: 'unavailable',
                unavailableReasonCode: input.reasonCode,
            },
        },
    };
}

function markSourceStale(
    state: PeerMediationObservabilityUiStore,
    scopeState: PeerMediationObservabilityScopeState,
    source: PeerMediationObservabilitySource,
): PeerMediationObservabilityUiStore {
    return {
        scopesByKey: {
            ...state.scopesByKey,
            [scopeState.scopeKey]: {
                ...scopeState,
                status: 'stale',
                stale: true,
                staleSourceBySource: {
                    ...scopeState.staleSourceBySource,
                    [source]: true,
                },
            },
        },
    };
}

function upsertSourceFamily(input: Readonly<{
    entry: PeerMediationObservabilityFlowEntry | undefined;
    source: PeerMediationObservabilitySource;
    scope: PeerMediationObservabilitySnapshotV1['scope'];
    sequence: number;
    lastUpdatedAtMs: number;
    snapshot: PeerMediationObservabilityFlowSnapshotV1;
    events?: readonly PeerMediationObservabilityEventV1[];
}>): PeerMediationObservabilityFlowEntry {
    const key = peerMediationObservabilityFlowKey(input.scope, input.snapshot.flow);
    const sourceFamily: PeerMediationObservabilitySourceFamily = {
        sequence: input.sequence,
        lastUpdatedAtMs: input.lastUpdatedAtMs,
        snapshot: input.snapshot,
        events: input.events ?? input.entry?.sources[input.source]?.events ?? [],
    };
    return {
        key,
        machineKey: peerMediationObservabilityMachineKey(input.scope),
        flowId: input.snapshot.flow.flowId,
        flowKind: input.snapshot.flow.flowKind,
        sources: {
            ...input.entry?.sources,
            [input.source]: sourceFamily,
        },
    };
}

export function applyPeerMediationObservabilitySnapshot(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        source: PeerMediationObservabilitySource;
        snapshot: PeerMediationObservabilitySnapshotV1;
    }>,
): PeerMediationObservabilityUiStore {
    const scopeKey = peerMediationObservabilityScopeKey(input.snapshot.scope);
    const previousScope = state.scopesByKey[scopeKey] ?? createScopeState(input.snapshot);
    const lastApplied = previousScope.lastAppliedSequenceBySource[input.source];
    if (lastApplied !== undefined && input.snapshot.sequence < lastApplied) {
        return state;
    }
    const nextFlowsByKey: Record<string, PeerMediationObservabilityFlowEntry> = {};

    for (const [key, entry] of Object.entries(previousScope.flowsByKey)) {
        const nextSources = { ...entry.sources };
        delete nextSources[input.source];
        if (nextSources.server || nextSources.daemon) {
            nextFlowsByKey[key] = {
                ...entry,
                sources: nextSources,
            };
        }
    }

    for (const flow of input.snapshot.flows) {
        const key = peerMediationObservabilityFlowKey(input.snapshot.scope, flow.flow);
        nextFlowsByKey[key] = upsertSourceFamily({
            entry: nextFlowsByKey[key],
            source: input.source,
            scope: input.snapshot.scope,
            sequence: input.snapshot.sequence,
            lastUpdatedAtMs: input.snapshot.capturedAtMs,
            snapshot: flow,
        });
    }

    const staleSourceBySource = {
        ...previousScope.staleSourceBySource,
        [input.source]: false,
    };
    const stale = Object.values(staleSourceBySource).some(Boolean);

    return {
        scopesByKey: {
            ...state.scopesByKey,
            [scopeKey]: {
                ...previousScope,
                scope: input.snapshot.scope,
                scopeKey,
                status: stale ? 'stale' : 'ready',
                stale,
                unavailableReasonCode: null,
                lastAppliedSequenceBySource: {
                    ...previousScope.lastAppliedSequenceBySource,
                    [input.source]: input.snapshot.sequence,
                },
                staleSourceBySource,
                flowsByKey: nextFlowsByKey,
            },
        },
    };
}

/**
 * The event -> flow-snapshot fold is owned by protocol
 * (`applyPeerMediationObservabilityEventToFlowSnapshot`). It used to be re-implemented here with a
 * different lifecycle mapping and different byte accumulation than the daemon and server producers,
 * and because the delta wire shape carries no snapshots the UI must re-fold every delta — so the
 * disagreement was directly observable: a flow rendered the producer's answer after subscribe and
 * the consumer's answer on the next delta (DEC-8).
 */

export function applyPeerMediationObservabilityDelta(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        source: PeerMediationObservabilitySource;
        delta: PeerMediationObservabilityDeltaV1;
    }>,
): PeerMediationObservabilityUiStore {
    const scopeKey = peerMediationObservabilityScopeKey(input.delta.scope);
    const previousScope = state.scopesByKey[scopeKey] ?? {
        ...createScopeState({
            v: 1,
            scope: input.delta.scope,
            sequence: 0,
            capturedAtMs: 0,
            flows: [],
        }),
        status: 'stale' as const,
        stale: true,
    };
    const lastApplied = previousScope.lastAppliedSequenceBySource[input.source];
    if (lastApplied === undefined || input.delta.sequence !== lastApplied + 1) {
        return markSourceStale(state, previousScope, input.source);
    }
    if (input.delta.events.some((event) => !peerMediationObservabilityScopesEqual(input.delta.scope, event.scope))) {
        return markSourceStale(state, previousScope, input.source);
    }

    const nextFlowsByKey: Record<string, PeerMediationObservabilityFlowEntry> = {
        ...previousScope.flowsByKey,
    };

    for (const event of input.delta.events) {
        const key = peerMediationObservabilityFlowKey(input.delta.scope, event.flow);
        const previousEntry = nextFlowsByKey[key];
        const previousFamily = previousEntry?.sources[input.source];
        const snapshot = applyPeerMediationObservabilityEventToFlowSnapshot(previousFamily?.snapshot, event);
        nextFlowsByKey[key] = upsertSourceFamily({
            entry: previousEntry,
            source: input.source,
            scope: input.delta.scope,
            sequence: input.delta.sequence,
            lastUpdatedAtMs: event.emittedAtMs,
            snapshot,
            events: [...(previousFamily?.events ?? []), event],
        });
    }

    const staleSourceBySource = {
        ...previousScope.staleSourceBySource,
        [input.source]: false,
    };
    const stale = Object.values(staleSourceBySource).some(Boolean);

    return {
        scopesByKey: {
            ...state.scopesByKey,
            [scopeKey]: {
                ...previousScope,
                status: stale ? 'stale' : 'ready',
                stale,
                unavailableReasonCode: null,
                lastAppliedSequenceBySource: {
                    ...previousScope.lastAppliedSequenceBySource,
                    [input.source]: input.delta.sequence,
                },
                staleSourceBySource,
                flowsByKey: nextFlowsByKey,
            },
        },
    };
}
