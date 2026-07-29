import type {
    PeerMediationObservabilityDeltaV1,
    PeerMediationObservabilityEventV1,
    PeerMediationObservabilityFlowSnapshotV1,
    PeerMediationObservabilityLifecycleStateV1,
    PeerMediationObservabilityScopeV1,
    PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

export type DaemonPeerMediationObservabilitySnapshot = PeerMediationObservabilitySnapshotV1;
export type DaemonPeerMediationObservabilityDeltaListener = (delta: PeerMediationObservabilityDeltaV1) => void;

export type DaemonPeerMediationObservabilityStore = Readonly<{
    publish(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1;
    delta(machineId: string, accountId: string): PeerMediationObservabilityDeltaV1;
    snapshot(machineId: string, accountId: string): PeerMediationObservabilitySnapshotV1;
    subscribe(machineId: string, accountId: string, listener: DaemonPeerMediationObservabilityDeltaListener): () => void;
}>;

const DEFAULT_MAX_EVENTS_PER_FLOW = 512;
const DEFAULT_MAX_EVENTS_PER_MACHINE = 2048;
const DEFAULT_RETENTION_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
const MIN_EVENT_PAYLOAD_MAX_BYTES = 1024;

function machineScope(machineId: string, accountId: string): PeerMediationObservabilityScopeV1 {
    return { kind: 'machine', accountId, machineId };
}

function scopeKey(machineId: string, accountId: string): string {
    return `${accountId}:${machineId}`;
}

function eventScopeKey(event: PeerMediationObservabilityEventV1): Readonly<{
    key: string;
    machineId: string;
    accountId: string;
}> {
    if (event.scope.kind !== 'machine') {
        return { key: scopeKey('unknown', 'unknown'), machineId: 'unknown', accountId: 'unknown' };
    }
    return {
        key: scopeKey(event.scope.machineId, event.scope.accountId),
        machineId: event.scope.machineId,
        accountId: event.scope.accountId,
    };
}

function lifecycleForKind(kind: PeerMediationObservabilityEventV1['kind']): PeerMediationObservabilityLifecycleStateV1 {
    if (kind === 'flow.ready') return 'ready';
    if (kind === 'flow.closed' || kind === 'websocket.closed' || kind === 'http.request.finished') return 'closed';
    if (kind === 'flow.aborted' || kind === 'websocket.aborted' || kind === 'http.request.aborted') return 'aborted';
    if (kind === 'flow.errored' || kind === 'websocket.errored') return 'errored';
    if (kind === 'flow.denied' || kind === 'policy.denied') return 'denied';
    return 'active';
}

function numberFromData(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function buildFlowSnapshots(events: readonly PeerMediationObservabilityEventV1[]): PeerMediationObservabilityFlowSnapshotV1[] {
    const byFlow = new Map<string, PeerMediationObservabilityFlowSnapshotV1>();
    for (const event of events) {
        const existing = byFlow.get(event.flow.flowId);
        const next: PeerMediationObservabilityFlowSnapshotV1 = {
            flow: event.flow,
            lifecycleState: lifecycleForKind(event.kind),
            startedAtMs: existing?.startedAtMs ?? event.emittedAtMs,
            lastActivityAtMs: event.emittedAtMs,
            ...(event.kind === 'flow.closed'
                || event.kind === 'websocket.closed'
                || event.kind === 'websocket.aborted'
                || event.kind === 'websocket.errored'
                || event.kind === 'http.request.finished'
                ? { closedAtMs: event.emittedAtMs }
                : {}),
            bytesIn: (existing?.bytesIn ?? 0) + (numberFromData(event.data, 'bytesIn') ?? 0),
            bytesOut: (existing?.bytesOut ?? 0) + (numberFromData(event.data, 'bytesOut') ?? 0),
            framesIn: existing?.framesIn ?? 0,
            framesOut: existing?.framesOut ?? 0,
            messagesIn: existing?.messagesIn ?? 0,
            messagesOut: existing?.messagesOut ?? 0,
            activeSubstreams: existing?.activeSubstreams ?? 0,
            ...(typeof event.data.reasonCode === 'string' && event.kind === 'flow.closed'
                ? { closeReasonCode: event.data.reasonCode }
                : {}),
            ...(typeof event.data.reasonCode === 'string' && (event.kind === 'flow.aborted' || event.kind === 'websocket.aborted')
                ? { abortReasonCode: event.data.reasonCode }
                : {}),
            ...(typeof event.data.reasonCode === 'string' && (event.kind === 'flow.errored' || event.kind === 'websocket.errored')
                ? { errorReasonCode: event.data.reasonCode }
                : {}),
        };
        byFlow.set(event.flow.flowId, next);
    }
    return [...byFlow.values()];
}

function boundedPositiveInt(value: number | undefined, fallback: number, maximum: number): number {
    if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function eventByteLength(event: PeerMediationObservabilityEventV1): number {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function enforceEventPayloadBudget(
    event: PeerMediationObservabilityEventV1,
    maxBytes: number,
): PeerMediationObservabilityEventV1 {
    const originalPayloadBytes = eventByteLength(event);
    if (originalPayloadBytes <= maxBytes) return event;

    return {
        ...event,
        data: {
            payloadTruncated: true,
            originalPayloadBytes,
            payloadMaxBytes: maxBytes,
        },
        redaction: {
            ...event.redaction,
            truncated: true,
        },
    };
}

function pruneRetainedEvents(
    events: readonly PeerMediationObservabilityEventV1[],
    input: Readonly<{
        nowMs: number;
        retentionWindowMs: number;
        maxEventsPerFlow: number;
        maxEventsPerMachine: number;
    }>,
): PeerMediationObservabilityEventV1[] {
    const minimumEmittedAtMs = Math.max(0, input.nowMs - input.retentionWindowMs);
    const withinWindow = events.filter((event) => event.emittedAtMs >= minimumEmittedAtMs);
    const flowCounts = new Map<string, number>();
    const perFlowRetained: PeerMediationObservabilityEventV1[] = [];

    for (let index = withinWindow.length - 1; index >= 0; index -= 1) {
        const event = withinWindow[index];
        if (!event) continue;
        const count = flowCounts.get(event.flow.flowId) ?? 0;
        if (count >= input.maxEventsPerFlow) continue;
        flowCounts.set(event.flow.flowId, count + 1);
        perFlowRetained.push(event);
    }

    const retained = perFlowRetained.reverse();
    return retained.length > input.maxEventsPerMachine
        ? retained.slice(-input.maxEventsPerMachine)
        : retained;
}

export function createDaemonPeerMediationObservabilityStore(input: Readonly<{
    maxEventsPerMachine?: number;
    maxEventsPerFlow?: number;
    retentionWindowMs?: number;
    eventPayloadMaxBytes?: number;
    nowMs?: () => number;
}> = {}): DaemonPeerMediationObservabilityStore {
    const maxEventsPerMachine = boundedPositiveInt(
        input.maxEventsPerMachine,
        DEFAULT_MAX_EVENTS_PER_MACHINE,
        DEFAULT_MAX_EVENTS_PER_MACHINE,
    );
    const maxEventsPerFlow = boundedPositiveInt(
        input.maxEventsPerFlow,
        DEFAULT_MAX_EVENTS_PER_FLOW,
        DEFAULT_MAX_EVENTS_PER_FLOW,
    );
    const retentionWindowMs = boundedPositiveInt(
        input.retentionWindowMs,
        DEFAULT_RETENTION_WINDOW_MS,
        DEFAULT_RETENTION_WINDOW_MS,
    );
    const eventPayloadMaxBytes = Math.max(
        MIN_EVENT_PAYLOAD_MAX_BYTES,
        boundedPositiveInt(
            input.eventPayloadMaxBytes,
            DEFAULT_EVENT_PAYLOAD_MAX_BYTES,
            DEFAULT_EVENT_PAYLOAD_MAX_BYTES,
        ),
    );
    const nowMs = input.nowMs ?? Date.now;
    const eventsByScope = new Map<string, PeerMediationObservabilityEventV1[]>();
    const sequenceByScope = new Map<string, number>();
    const listenersByScope = new Map<string, Set<DaemonPeerMediationObservabilityDeltaListener>>();

    function writeEvents(key: string, events: PeerMediationObservabilityEventV1[]): void {
        if (events.length === 0) {
            eventsByScope.delete(key);
            return;
        }
        eventsByScope.set(key, events);
    }

    function pruneScope(key: string, currentTimeMs: number): PeerMediationObservabilityEventV1[] {
        const existing = eventsByScope.get(key) ?? [];
        const retained = pruneRetainedEvents(existing, {
            nowMs: currentTimeMs,
            retentionWindowMs,
            maxEventsPerFlow,
            maxEventsPerMachine,
        });
        writeEvents(key, retained);
        return retained;
    }

    return {
        publish(event) {
            const scope = eventScopeKey(event);
            const currentTimeMs = nowMs();
            const sequence = (sequenceByScope.get(scope.key) ?? 0) + 1;
            sequenceByScope.set(scope.key, sequence);
            const sequenced = enforceEventPayloadBudget({ ...event, sequence }, eventPayloadMaxBytes);
            const events = pruneRetainedEvents([...pruneScope(scope.key, currentTimeMs), sequenced], {
                nowMs: currentTimeMs,
                retentionWindowMs,
                maxEventsPerFlow,
                maxEventsPerMachine,
            });
            writeEvents(scope.key, events);
            const retainedPublishedEvent = events.includes(sequenced);
            const listeners = retainedPublishedEvent ? listenersByScope.get(scope.key) : undefined;
            if (listeners && listeners.size > 0) {
                const delta: PeerMediationObservabilityDeltaV1 = {
                    v: 1,
                    scope: machineScope(scope.machineId, scope.accountId),
                    sequence,
                    events: [sequenced],
                };
                for (const listener of [...listeners]) listener(delta);
            }
            return sequenced;
        },
        delta(machineId, accountId) {
            const key = scopeKey(machineId, accountId);
            const events = pruneScope(key, nowMs());
            return {
                v: 1,
                scope: machineScope(machineId, accountId),
                sequence: sequenceByScope.get(key) ?? 0,
                events: [...events],
            };
        },
        snapshot(machineId, accountId) {
            const key = scopeKey(machineId, accountId);
            const currentTimeMs = nowMs();
            const events = pruneScope(key, currentTimeMs);
            return {
                v: 1,
                scope: machineScope(machineId, accountId),
                sequence: sequenceByScope.get(key) ?? 0,
                capturedAtMs: currentTimeMs,
                flows: buildFlowSnapshots(events),
            };
        },
        subscribe(machineId, accountId, listener) {
            const key = scopeKey(machineId, accountId);
            const listeners = listenersByScope.get(key) ?? new Set<DaemonPeerMediationObservabilityDeltaListener>();
            listeners.add(listener);
            listenersByScope.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) listenersByScope.delete(key);
            };
        },
    };
}
