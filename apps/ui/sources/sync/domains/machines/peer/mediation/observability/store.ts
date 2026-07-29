import type {
    PeerMediationObservabilityDeltaV1,
    PeerMediationObservabilityEventKindV1,
    PeerMediationObservabilityEventV1,
    PeerMediationObservabilityFlowSnapshotV1,
    PeerMediationObservabilitySnapshotV1,
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
        resubscribeRequired: false,
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
                resubscribeRequired: true,
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
                resubscribeRequired: stale,
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

function lifecycleForEventKind(
    kind: PeerMediationObservabilityEventKindV1,
    previous: PeerMediationObservabilityFlowSnapshotV1['lifecycleState'] | undefined,
): PeerMediationObservabilityFlowSnapshotV1['lifecycleState'] {
    switch (kind) {
        case 'flow.started':
            return 'starting';
        case 'flow.ready':
            return 'ready';
        case 'flow.denied':
        case 'policy.denied':
            return 'denied';
        case 'flow.closed':
        case 'websocket.closed':
            return 'closed';
        case 'flow.aborted':
        case 'http.request.aborted':
        case 'tunnel.substream.aborted':
            return 'aborted';
        case 'flow.errored':
            return 'errored';
        default:
            return previous === 'starting' || previous === 'ready' ? 'active' : previous ?? 'active';
    }
}

function readNumber(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function applyEventToSnapshot(
    previous: PeerMediationObservabilityFlowSnapshotV1 | undefined,
    event: PeerMediationObservabilityEventV1,
): PeerMediationObservabilityFlowSnapshotV1 {
    const data = event.data ?? {};
    const lifecycleState = lifecycleForEventKind(event.kind, previous?.lifecycleState);
    const closedAtMs = (
        lifecycleState === 'closed'
        || lifecycleState === 'aborted'
        || lifecycleState === 'errored'
        || lifecycleState === 'denied'
    )
        ? event.emittedAtMs
        : previous?.closedAtMs;
    const isHttpEvent = event.kind.startsWith('http.request.');
    const isWebSocketEvent = event.kind.startsWith('websocket.');

    return {
        flow: event.flow,
        lifecycleState,
        startedAtMs: previous?.startedAtMs ?? event.emittedAtMs,
        lastActivityAtMs: event.emittedAtMs,
        ...(closedAtMs !== undefined ? { closedAtMs } : {}),
        bytesIn: readNumber(data, 'bytesIn') ?? previous?.bytesIn ?? 0,
        bytesOut: readNumber(data, 'bytesOut') ?? previous?.bytesOut ?? 0,
        framesIn: readNumber(data, 'framesIn') ?? previous?.framesIn ?? 0,
        framesOut: readNumber(data, 'framesOut') ?? previous?.framesOut ?? 0,
        messagesIn: readNumber(data, 'messagesIn') ?? previous?.messagesIn ?? 0,
        messagesOut: readNumber(data, 'messagesOut') ?? previous?.messagesOut ?? 0,
        activeSubstreams: readNumber(data, 'activeSubstreams') ?? previous?.activeSubstreams ?? 0,
        ...(readNumber(data, 'totalSubstreams') ?? previous?.totalSubstreams) !== undefined
            ? { totalSubstreams: readNumber(data, 'totalSubstreams') ?? previous?.totalSubstreams }
            : {},
        ...(readNumber(data, 'movingThroughputBps') ?? previous?.movingThroughputBps) !== undefined
            ? { movingThroughputBps: readNumber(data, 'movingThroughputBps') ?? previous?.movingThroughputBps }
            : {},
        ...(readString(data, 'capProfileId') ?? previous?.capProfileId) !== undefined
            ? { capProfileId: readString(data, 'capProfileId') ?? previous?.capProfileId }
            : {},
        ...(readNumber(data, 'capUsagePercent') ?? previous?.capUsagePercent) !== undefined
            ? { capUsagePercent: readNumber(data, 'capUsagePercent') ?? previous?.capUsagePercent }
            : {},
        ...(readString(data, 'closeReasonCode') ?? (event.kind === 'flow.closed' ? readString(data, 'reasonCode') : undefined) ?? previous?.closeReasonCode) !== undefined
            ? { closeReasonCode: readString(data, 'closeReasonCode') ?? (event.kind === 'flow.closed' ? readString(data, 'reasonCode') : undefined) ?? previous?.closeReasonCode }
            : {},
        ...(readString(data, 'abortReasonCode') ?? (event.kind.includes('aborted') ? readString(data, 'reasonCode') : undefined) ?? previous?.abortReasonCode) !== undefined
            ? { abortReasonCode: readString(data, 'abortReasonCode') ?? (event.kind.includes('aborted') ? readString(data, 'reasonCode') : undefined) ?? previous?.abortReasonCode }
            : {},
        ...(readString(data, 'errorReasonCode') ?? (event.kind === 'flow.errored' ? readString(data, 'reasonCode') : undefined) ?? previous?.errorReasonCode) !== undefined
            ? { errorReasonCode: readString(data, 'errorReasonCode') ?? (event.kind === 'flow.errored' ? readString(data, 'reasonCode') : undefined) ?? previous?.errorReasonCode }
            : {},
        ...(isHttpEvent ? { http: data } : previous?.http ? { http: previous.http } : {}),
        ...(isWebSocketEvent ? { websocket: data } : previous?.websocket ? { websocket: previous.websocket } : {}),
    };
}

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
        resubscribeRequired: true,
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
        const snapshot = applyEventToSnapshot(previousFamily?.snapshot, event);
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
                resubscribeRequired: stale,
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
