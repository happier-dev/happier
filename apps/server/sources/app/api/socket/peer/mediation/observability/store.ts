import type {
    PeerMediationObservabilityDeltaV1,
    PeerMediationObservabilityEventV1,
    PeerMediationObservabilityFlowSnapshotV1,
    PeerMediationObservabilityLifecycleStateV1,
    PeerMediationObservabilityScopeV1,
    PeerMediationObservabilitySnapshotV1,
} from "@happier-dev/protocol";

export type PeerMediationObservabilityScope = PeerMediationObservabilityScopeV1;
export type PeerMediationObservabilitySnapshot = PeerMediationObservabilitySnapshotV1;
export type PeerMediationObservabilityDeltaListener = (delta: PeerMediationObservabilityDeltaV1) => void;

export type PeerMediationObservabilityStore = Readonly<{
    publish(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1;
    delta(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilityDeltaV1;
    snapshot(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilitySnapshotV1;
    subscribe(scope: PeerMediationObservabilityScopeV1, listener: PeerMediationObservabilityDeltaListener): () => void;
}>;

const DEFAULT_MAX_EVENTS_PER_FLOW = 512;
const DEFAULT_MAX_EVENTS_PER_MACHINE_AGGREGATE = 2048;
const DEFAULT_RETENTION_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
const MIN_EVENT_PAYLOAD_MAX_BYTES = 1024;

function scopeFromEvent(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityScopeV1 {
    return event.scope;
}

function scopeKey(scope: PeerMediationObservabilityScopeV1): string {
    if (scope.kind === "account") return `account:${scope.accountId}`;
    if (scope.kind === "machine") return `machine:${scope.accountId}:${scope.machineId}`;
    if (scope.kind === "session") return `session:${scope.accountId}:${scope.sessionId}`;
    if (scope.kind === "publicPreview") return `publicPreview:${scope.publicExposureId}`;
    return `pluginSurface:${scope.accountId}:${scope.pluginId}:${scope.surfaceId}`;
}

function lifecycleForKind(kind: PeerMediationObservabilityEventV1["kind"]): PeerMediationObservabilityLifecycleStateV1 {
    if (kind === "flow.ready") return "ready";
    if (kind === "flow.closed" || kind === "websocket.closed" || kind === "http.request.finished") return "closed";
    if (kind === "flow.aborted" || kind === "websocket.aborted" || kind === "http.request.aborted") return "aborted";
    if (kind === "flow.errored" || kind === "websocket.errored") return "errored";
    if (kind === "flow.denied" || kind === "policy.denied") return "denied";
    return "active";
}

function numberFromData(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function buildFlowSnapshots(events: readonly PeerMediationObservabilityEventV1[]): PeerMediationObservabilityFlowSnapshotV1[] {
    const byFlow = new Map<string, PeerMediationObservabilityFlowSnapshotV1>();
    for (const event of events) {
        const existing = byFlow.get(event.flow.flowId);
        const bytesIn = numberFromData(event.data, "bytesIn") ?? numberFromData(event.data, "requestBytes") ?? 0;
        const bytesOut = numberFromData(event.data, "bytesOut") ?? numberFromData(event.data, "responseBytes") ?? 0;
        const next: PeerMediationObservabilityFlowSnapshotV1 = {
            flow: event.flow,
            lifecycleState: lifecycleForKind(event.kind),
            startedAtMs: existing?.startedAtMs ?? event.emittedAtMs,
            lastActivityAtMs: event.emittedAtMs,
            ...(event.kind === "flow.closed"
                || event.kind === "websocket.closed"
                || event.kind === "websocket.aborted"
                || event.kind === "websocket.errored"
                || event.kind === "http.request.finished"
                ? { closedAtMs: event.emittedAtMs }
                : {}),
            bytesIn: (existing?.bytesIn ?? 0) + bytesIn,
            bytesOut: (existing?.bytesOut ?? 0) + bytesOut,
            framesIn: existing?.framesIn ?? 0,
            framesOut: existing?.framesOut ?? 0,
            messagesIn: existing?.messagesIn ?? 0,
            messagesOut: existing?.messagesOut ?? 0,
            activeSubstreams: existing?.activeSubstreams ?? 0,
            ...(typeof event.data.reasonCode === "string" && event.kind === "flow.closed"
                ? { closeReasonCode: event.data.reasonCode }
                : {}),
            ...(typeof event.data.reasonCode === "string" && (event.kind === "flow.aborted" || event.kind === "websocket.aborted")
                ? { abortReasonCode: event.data.reasonCode }
                : {}),
            ...(typeof event.data.reasonCode === "string" && (event.kind === "flow.errored" || event.kind === "websocket.errored")
                ? { errorReasonCode: event.data.reasonCode }
                : {}),
            ...(event.kind.startsWith("http.") ? { http: event.data } : {}),
            ...(event.kind.startsWith("websocket.") ? { websocket: event.data } : {}),
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
    return Buffer.byteLength(JSON.stringify(event), "utf8");
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
        maxEventsPerMachineAggregate: number;
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
    return retained.length > input.maxEventsPerMachineAggregate
        ? retained.slice(-input.maxEventsPerMachineAggregate)
        : retained;
}

export function createPeerMediationObservabilityStore(input: Readonly<{
    maxEventsPerScope?: number;
    maxEventsPerMachineAggregate?: number;
    retentionWindowMs?: number;
    eventPayloadMaxBytes?: number;
    nowMs?: () => number;
}> = {}): PeerMediationObservabilityStore {
    const maxEventsPerFlow = boundedPositiveInt(
        input.maxEventsPerScope,
        DEFAULT_MAX_EVENTS_PER_FLOW,
        DEFAULT_MAX_EVENTS_PER_FLOW,
    );
    const maxEventsPerMachineAggregate = boundedPositiveInt(
        input.maxEventsPerMachineAggregate ?? input.maxEventsPerScope,
        DEFAULT_MAX_EVENTS_PER_MACHINE_AGGREGATE,
        DEFAULT_MAX_EVENTS_PER_MACHINE_AGGREGATE,
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
    const listenersByScope = new Map<string, Set<PeerMediationObservabilityDeltaListener>>();

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
            maxEventsPerMachineAggregate,
        });
        writeEvents(key, retained);
        return retained;
    }

    return {
        publish(event) {
            const scope = scopeFromEvent(event);
            const key = scopeKey(scope);
            const currentTimeMs = nowMs();
            const sequence = (sequenceByScope.get(key) ?? 0) + 1;
            sequenceByScope.set(key, sequence);
            const sequenced = enforceEventPayloadBudget({ ...event, sequence }, eventPayloadMaxBytes);
            const events = pruneRetainedEvents([...pruneScope(key, currentTimeMs), sequenced], {
                nowMs: currentTimeMs,
                retentionWindowMs,
                maxEventsPerFlow,
                maxEventsPerMachineAggregate,
            });
            writeEvents(key, events);
            const retainedPublishedEvent = events.includes(sequenced);
            const listeners = retainedPublishedEvent ? listenersByScope.get(key) : undefined;
            if (listeners && listeners.size > 0) {
                const delta: PeerMediationObservabilityDeltaV1 = {
                    v: 1,
                    scope,
                    sequence,
                    events: [sequenced],
                };
                for (const listener of [...listeners]) listener(delta);
            }
            return sequenced;
        },
        delta(scope) {
            const key = scopeKey(scope);
            const events = pruneScope(key, nowMs());
            return {
                v: 1,
                scope,
                sequence: sequenceByScope.get(key) ?? 0,
                events: [...events],
            };
        },
        snapshot(scope) {
            const key = scopeKey(scope);
            const currentTimeMs = nowMs();
            const events = pruneScope(key, currentTimeMs);
            return {
                v: 1,
                scope,
                sequence: sequenceByScope.get(key) ?? 0,
                capturedAtMs: currentTimeMs,
                flows: buildFlowSnapshots(events),
            };
        },
        subscribe(scope, listener) {
            const key = scopeKey(scope);
            const listeners = listenersByScope.get(key) ?? new Set<PeerMediationObservabilityDeltaListener>();
            listeners.add(listener);
            listenersByScope.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) listenersByScope.delete(key);
            };
        },
    };
}
