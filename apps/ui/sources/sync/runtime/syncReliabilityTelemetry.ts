import {
    appendSyncReliabilityEvent,
    loadSyncReliabilityEvents,
    type PersistedSyncReliabilityEvent,
    type SyncReliabilityEventFieldValue,
} from '@/sync/domains/state/persistence';

type SyncReliabilityEventStorage = Readonly<{
    appendEvent: (event: PersistedSyncReliabilityEvent) => void;
    loadEvents: () => readonly PersistedSyncReliabilityEvent[];
}>;

export type SyncReliabilityEventFields = Readonly<Record<string, SyncReliabilityEventFieldValue>>;

type SyncReliabilityTelemetryOptions = Readonly<{
    now?: () => number;
    randomId?: () => string;
    storage?: SyncReliabilityEventStorage;
    maxMemoryEvents?: number;
}>;

type SyncReliabilityTelemetrySnapshot = Readonly<{
    events: readonly PersistedSyncReliabilityEvent[];
    persistedEvents: readonly PersistedSyncReliabilityEvent[];
}>;

export type SyncReliabilityTelemetry = Readonly<{
    record: (name: string, fields?: SyncReliabilityEventFields) => void;
    recordCritical: (name: string, fields?: SyncReliabilityEventFields) => void;
    reset: () => void;
    snapshot: () => SyncReliabilityTelemetrySnapshot;
}>;

function createDefaultStorage(): SyncReliabilityEventStorage {
    return {
        appendEvent: (event) => appendSyncReliabilityEvent(event),
        loadEvents: () => loadSyncReliabilityEvents(),
    };
}

function normalizeMaxMemoryEvents(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.trunc(value))
        : 100;
}

function createEvent(params: Readonly<{
    name: string;
    fields?: Readonly<Record<string, SyncReliabilityEventFieldValue>>;
    now: () => number;
    randomId: () => string;
}>): PersistedSyncReliabilityEvent {
    return {
        id: params.randomId(),
        name: params.name,
        atMs: Math.max(0, Math.trunc(params.now())),
        fields: { ...(params.fields ?? {}) },
    };
}

export function createSyncReliabilityTelemetry(
    options: SyncReliabilityTelemetryOptions = {},
): SyncReliabilityTelemetry {
    const now = options.now ?? Date.now;
    const randomId = options.randomId ?? (() => Math.random().toString(36).slice(2));
    const storage = options.storage ?? createDefaultStorage();
    const maxMemoryEvents = normalizeMaxMemoryEvents(options.maxMemoryEvents);
    let events: PersistedSyncReliabilityEvent[] = [];

    function remember(event: PersistedSyncReliabilityEvent): void {
        events = [...events, event].slice(-maxMemoryEvents);
    }

    return {
        record: (name, fields) => {
            remember(createEvent({ name, fields, now, randomId }));
        },
        recordCritical: (name, fields) => {
            const event = createEvent({ name, fields, now, randomId });
            remember(event);
            storage.appendEvent(event);
        },
        reset: () => {
            events = [];
        },
        snapshot: () => ({
            events,
            persistedEvents: storage.loadEvents(),
        }),
    };
}

export const syncReliabilityTelemetry = createSyncReliabilityTelemetry();

export function installSyncReliabilityTelemetryGlobal(telemetry: SyncReliabilityTelemetry = syncReliabilityTelemetry): void {
    (globalThis as typeof globalThis & {
        __HAPPIER_SYNC_RELIABILITY__?: { snapshot: () => SyncReliabilityTelemetrySnapshot; reset: () => void };
    }).__HAPPIER_SYNC_RELIABILITY__ = {
        snapshot: () => telemetry.snapshot(),
        reset: () => telemetry.reset(),
    };
}
