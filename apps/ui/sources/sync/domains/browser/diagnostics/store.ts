import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { isBrowserDiagnosticLifecycleEvent, type BrowserDiagnosticEventV1, type BrowserDiagnosticFamilyV1, type BrowserDiagnosticFidelityV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import { BROWSER_DIAGNOSTIC_FAMILIES } from './families';
import type {
    BrowserDiagnosticEventDetail,
    BrowserDiagnosticEventField,
    BrowserDiagnosticEventProjection,
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticRequestProjection,
    BrowserDiagnosticResourceEntry,
    BrowserDiagnosticResourceRow,
    BrowserDiagnosticStorageEntry,
    BrowserDiagnosticStorageRow,
    BrowserDiagnosticsUiStore,
    BrowserDiagnosticsViewState,
    BrowserDiagnosticsSnapshotState,
    BrowserViewDiagnosticsProjection,
} from './types';

const FIDELITY_RANK: Readonly<Record<BrowserDiagnosticFidelityV1, number>> = {
    cdp: 6,
    previewProxy: 5,
    injectedPage: 4,
    nativeCallback: 3,
    streamFrame: 2,
    unavailable: 1,
};

function pickHigherFidelity(
    current: BrowserDiagnosticFidelityV1,
    next: BrowserDiagnosticFidelityV1,
): BrowserDiagnosticFidelityV1 {
    return FIDELITY_RANK[next] > FIDELITY_RANK[current] ? next : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnosticUrlText(value: unknown): string | null {
    if (typeof value === 'string') return value || null;
    if (!isRecord(value)) return null;
    const origin = typeof value.origin === 'string' ? value.origin : '';
    const path = typeof value.path === 'string' ? value.path : '';
    const keys = Array.isArray(value.queryKeys) ? value.queryKeys.filter((key): key is string => typeof key === 'string') : [];
    return `${origin}${path}${keys.length ? `?${keys.map(key => encodeURIComponent(key)).join('&')}` : ''}` || null;
}

const PERFORMANCE_VITALS_NUMERIC_KEYS: readonly string[] = [
    'lcpMs',
    'clsScore',
    'inpMs',
    'fcpMs',
    'longTaskCount',
    'longTaskTotalMs',
    'navResponseEndMs',
    'navDomContentLoadedMs',
    'navLoadEventEndMs',
];

const PAGE_CAPABILITY_KEYS: readonly string[] = [
    'serviceWorker',
    'webgl',
    'webrtc',
    'clipboard',
    'webShare',
    'indexedDbApi',
    'notifications',
    'geolocation',
    'mediaDevices',
    'webAuthn',
    'storage',
    'pushManager',
    'webgpu',
];

const WEBSOCKET_SUMMARY_NUMERIC_KEYS: readonly string[] = [
    'framesSent',
    'framesReceived',
    'bytesSent',
    'bytesReceived',
    'messageCount',
];

function summarizeMetadataMetrics(
    data: Record<string, unknown>,
    keys: readonly string[],
): string | undefined {
    const parts = keys.flatMap((key) => {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value)) return [`${key}: ${value}`];
        if (typeof value === 'boolean') return [`${key}: ${value ? 'yes' : 'no'}`];
        if (typeof value === 'string' && value.length > 0) return [`${key}: ${value}`];
        return [];
    });
    return parts.length > 0 ? parts.join('; ') : undefined;
}

function summarizeDiagnosticEvent(event: BrowserDiagnosticEventV1): string | undefined {
    const data = event.data;
    if (event.kind === 'console.entry' && typeof data.text === 'string') return data.text;
    if (event.kind === 'pageError.thrown' && typeof data.message === 'string') return data.message;
    const textPreview = data.textPreview;
    if (event.trusted && typeof textPreview === 'string' && textPreview.trim().length > 0) {
        return textPreview;
    }

    if (event.kind === 'performance.vitals') {
        return summarizeMetadataMetrics(data, PERFORMANCE_VITALS_NUMERIC_KEYS);
    }

    if (event.kind === 'pageInfo.capabilities') {
        return summarizeMetadataMetrics(data, PAGE_CAPABILITY_KEYS);
    }

    if (event.kind === 'network.websocketSummary' || event.kind === 'network.eventSourceSummary') {
        return summarizeMetadataMetrics(data, ['state', ...WEBSOCKET_SUMMARY_NUMERIC_KEYS]);
    }

    if (event.kind === 'network.websocketClosed') {
        return summarizeMetadataMetrics(data, ['code']);
    }

    if (event.kind === 'network.eventSourceClosed') {
        const state = data.state;
        return typeof state === 'string' ? `state: ${state}` : undefined;
    }

    if (event.kind === 'storage.keyInventory') {
        const storageType = typeof data.storageType === 'string' ? data.storageType : undefined;
        const keyCount = typeof data.keyCount === 'number' ? data.keyCount : undefined;
        if (storageType && typeof keyCount === 'number') {
            return `${storageType}: ${keyCount} key${keyCount === 1 ? '' : 's'}`;
        }
        return storageType;
    }

    if (event.kind === 'pageInfo.domSnapshot') {
        return summarizeMetadataMetrics(data, ['elementCount', 'nodeCount', 'maxDepth']);
    }

    if (event.kind === 'network.sendBeacon') {
        const beaconUrl = typeof data.url === 'string' && data.url.trim().length > 0
            ? data.url
            : undefined;
        const bytesQueued = typeof data.bytesQueued === 'number' ? data.bytesQueued : undefined;
        if (beaconUrl && typeof bytesQueued === 'number') {
            return `${beaconUrl} (${bytesQueued}B)`;
        }
        return beaconUrl;
    }

    const url = diagnosticUrlText(data.url);
    if (url?.trim()) return url;

    const method = data.method;
    const path = data.path;
    if (typeof method === 'string' && typeof path === 'string') {
        return `${method} ${path}`;
    }

    const errorCode = data.errorCode;
    if (event.trusted && typeof errorCode === 'string' && errorCode.trim().length > 0) {
        return errorCode;
    }

    return undefined;
}

// Ordered scalar field keys surfaced per event kind. The ingress owner has already sanitized `event.data`
// (untrusted/injected events keep only allowlisted metadata; the egress classifier is the SSOT), so
// every key listed here is safe to render to the LOCAL owner. Order is presentation order in the
// family panels. `storage.keyInventory.keys` and `resources.snapshot.entries` are list payloads
// handled separately below; they are intentionally NOT in these scalar orders.
const DETAIL_FIELD_ORDER: Partial<Record<BrowserDiagnosticEventV1['kind'], readonly string[]>> = {
    // `text` is the owner-only length-capped console rendering: present only when the LOCAL owner's
    // value-capture policy admitted it. It renders last so
    // the metadata (level/argCount) reads first.
    'console.entry': ['level', 'argCount', 'textAvailable', 'text'],
    'pageError.thrown': ['textAvailable', 'messageAvailable', 'stackAvailable', 'message', 'stack'],
    'network.requestStarted': ['method', 'url', 'resourceType', 'requestHeaders', 'requestId'],
    'network.response': [
        'method',
        'url',
        'path',
        'status',
        'statusCode',
        'durationMs',
        'requestBytes',
        'responseBytes',
        'requestHeaders',
        'responseHeaders',
        'requestBodyText',
        'responseBodyText',
        'requestBodyTruncated',
        'responseBodyTruncated',
        'requestId',
        'resourceType', 'mimeType', 'transportProtocol', 'fromDiskCache', 'fromServiceWorker', 'securityState', 'errorText',
    ],
    'network.finished': ['method', 'url', 'status', 'statusCode', 'durationMs', 'responseBytes', 'mimeType',
        'requestHeaders', 'responseHeaders', 'resourceType', 'transportProtocol', 'fromDiskCache', 'fromServiceWorker', 'securityState', 'requestId'],
    'network.failed': ['method', 'url', 'durationMs', 'errorText', 'canceled', 'blockedReason', 'requestAvailable', 'errorAvailable', 'requestId'],
    'network.redirect': ['method', 'url', 'status', 'statusCode'],
    'network.websocketOpened': ['socketId', 'url', 'hasProtocol', 'protocolCount'],
    'network.websocketSummary': ['socketId', 'state', ...WEBSOCKET_SUMMARY_NUMERIC_KEYS],
    'network.websocketClosed': ['socketId', 'code', 'wasClean'],
    'network.eventSourceOpened': ['sourceId', 'url'],
    'network.eventSourceSummary': ['sourceId', 'state', 'messageCount', 'bytesReceived'],
    'network.eventSourceClosed': ['sourceId', 'state'],
    'network.sendBeacon': ['url', 'bytesQueued', 'accepted', 'requestId'],
    'elements.snapshot': ['nodeCount', 'elementCount', 'maxDepth'],
    'elements.pickerState': [
        'state',
        'selectorPath',
        'backendNodeRef',
        'rectAvailable',
        'accessibleNameAvailable',
        'pickerRequestId',
    ],
    'storage.availability': ['storageType'],
    'storage.keyInventory': ['storageType', 'keyCount', 'keysTruncated'],
    'pageInfo.snapshot': ['url', 'title', 'titleAvailable', 'readyState'],
    'pageInfo.capabilities': PAGE_CAPABILITY_KEYS,
    'pageInfo.domSnapshot': ['elementCount', 'nodeCount', 'maxDepth', 'readyState'],
    'performance.vitals': PERFORMANCE_VITALS_NUMERIC_KEYS,
    'eval.requested': ['tier', 'expressionPreview', 'expressionTruncated', 'objectGroupId', 'evalRequestId'],
    'eval.completed': ['tier', 'resultType', 'resultDescriptionAvailable', 'resultPreviewTruncated', 'evalRequestId'],
    'eval.failed': ['tier', 'errorAvailable', 'evalRequestId'],
    'eval.timedOut': ['tier', 'timeoutMs', 'evalRequestId'],
};

function extractDetailFields(
    data: Record<string, unknown>,
    keys: readonly string[],
): readonly BrowserDiagnosticEventField[] {
    const fields: BrowserDiagnosticEventField[] = [];
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string') {
            if (value.length > 0) fields.push({ key, value });
        } else if (typeof value === 'number') {
            if (Number.isFinite(value)) fields.push({ key, value });
        } else if (typeof value === 'boolean') {
            fields.push({ key, value });
        } else if ((key === 'requestHeaders' || key === 'responseHeaders') && isRecord(value)) {
            const headers = Object.entries(value)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .map(([name, headerValue]) => `${name}: ${headerValue}`).join('\n');
            if (headers) fields.push({ key, value: headers });
        }
    }
    return fields;
}

function extractDetailEntries(value: unknown): readonly BrowserDiagnosticResourceEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entries: BrowserDiagnosticResourceEntry[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        const entry: { name?: string; initiatorType?: string; durationMs?: number } = {};
        if (typeof candidate.name === 'string' && candidate.name.length > 0) entry.name = candidate.name;
        if (typeof candidate.initiatorType === 'string' && candidate.initiatorType.length > 0) {
            entry.initiatorType = candidate.initiatorType;
        }
        if (typeof candidate.durationMs === 'number' && Number.isFinite(candidate.durationMs)) {
            entry.durationMs = candidate.durationMs;
        }
        if (entry.name || entry.initiatorType || typeof entry.durationMs === 'number') entries.push(entry);
    }
    return entries.length > 0 ? entries : undefined;
}

function extractStorageEntries(value: unknown): readonly BrowserDiagnosticStorageEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entries: BrowserDiagnosticStorageEntry[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        const key = typeof candidate.key === 'string' ? candidate.key : '';
        const entryValue = typeof candidate.value === 'string' ? candidate.value : '';
        if (!key || !entryValue) continue;
        entries.push({
            key,
            value: entryValue,
            ...(candidate.valueTruncated === true ? { valueTruncated: true } : { valueTruncated: false }),
        });
    }
    return entries.length > 0 ? entries : undefined;
}

function projectEventDetail(event: BrowserDiagnosticEventV1): BrowserDiagnosticEventDetail | undefined {
    const data = event.family === 'network' && event.data.headers && !event.data.responseHeaders && event.kind === 'network.response'
        ? { ...event.data, responseHeaders: event.data.headers }
        : event.family === 'network' && event.data.headers && !event.data.requestHeaders && event.kind === 'network.requestStarted'
            ? { ...event.data, requestHeaders: event.data.headers } : event.data;
    const fields = extractDetailFields(data, DETAIL_FIELD_ORDER[event.kind] ?? []);

    let keys: readonly string[] | undefined;
    if (event.kind === 'storage.keyInventory' && Array.isArray(data.keys)) {
        const stringKeys = data.keys.filter((key): key is string => typeof key === 'string');
        if (stringKeys.length > 0) keys = stringKeys;
    }

    const entries = event.kind === 'resources.snapshot' ? extractDetailEntries(data.entries) : undefined;
    const storageEntries = event.kind === 'storage.keyInventory' ? extractStorageEntries(data.entries) : undefined;

    if (fields.length === 0 && !keys && !entries && !storageEntries) return undefined;
    return {
        fields,
        ...(keys ? { keys } : {}),
        ...(entries ? { entries } : {}),
        ...(storageEntries ? { storageEntries } : {}),
    };
}

function projectEvent(event: BrowserDiagnosticEventV1): BrowserDiagnosticEventProjection {
    const summary = summarizeDiagnosticEvent(event);
    const detail = projectEventDetail(event);
    return {
        eventId: event.eventId,
        family: event.family,
        kind: event.kind,
        fidelity: event.fidelity,
        trusted: event.trusted,
        capturedAtMs: event.capturedAtMs,
        redaction: event.redaction,
        data: event.data,
        ...(summary ? { summary } : {}),
        ...(detail ? { detail } : {}),
    };
}

function projectFamily(
    family: BrowserDiagnosticFamilyV1,
    events: readonly BrowserDiagnosticEventV1[],
): BrowserDiagnosticFamilyProjection {
    const familyEvents = events.filter((event) => event.family === family);
    if (familyEvents.length === 0) {
        return {
            family,
            status: 'unavailable',
            fidelity: 'unavailable',
            trusted: false,
            reasonCode: 'unsupported_fidelity',
        };
    }

    const latestFamilyEvent = familyEvents[familyEvents.length - 1];
    if (latestFamilyEvent?.kind === 'diagnostics.unavailable') {
        return {
            family,
            status: 'unavailable',
            fidelity: latestFamilyEvent.fidelity,
            trusted: latestFamilyEvent.trusted,
            ...(latestFamilyEvent.unavailableReason ? { reasonCode: latestFamilyEvent.unavailableReason } : {}),
        };
    }

    return {
        family,
        status: latestFamilyEvent?.kind === 'collector.degraded' ? 'stale' : 'available',
        ...(latestFamilyEvent?.kind === 'collector.degraded' && typeof latestFamilyEvent.data.reasonCode === 'string'
            ? { reasonCode: latestFamilyEvent.data.reasonCode } : {}),
        fidelity: familyEvents.reduce<BrowserDiagnosticFidelityV1>(
            (fidelity, event) => pickHigherFidelity(fidelity, event.fidelity),
            'unavailable',
        ),
        trusted: familyEvents.every((event) => event.trusted),
    };
}

function sortEvents(events: readonly BrowserDiagnosticEventV1[]): readonly BrowserDiagnosticEventV1[] {
    return [...events]
        .sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.eventId.localeCompare(b.eventId));
}

function acceptedDiagnosticValuesEqual(left: unknown, right: unknown): boolean {
    const pending = [{ left, right }];
    const compared = new WeakMap<object, object>();
    while (pending.length > 0) {
        const pair = pending.pop()!;
        if (Object.is(pair.left, pair.right)) continue;
        if (pair.left === null || pair.right === null || typeof pair.left !== 'object' || typeof pair.right !== 'object') {
            return false;
        }
        if (Array.isArray(pair.left) !== Array.isArray(pair.right)) return false;
        const leftPrototype = Object.getPrototypeOf(pair.left);
        const rightPrototype = Object.getPrototypeOf(pair.right);
        // Unknown trusted data need not be JSON. Non-record instances compare by identity;
        // primitives (including bigint) and plain data never require serialization.
        if ((leftPrototype !== Object.prototype && leftPrototype !== null && leftPrototype !== Array.prototype)
            || (rightPrototype !== Object.prototype && rightPrototype !== null && rightPrototype !== Array.prototype)) return false;
        if (compared.has(pair.left)) {
            if (compared.get(pair.left) !== pair.right) return false;
            continue;
        }
        compared.set(pair.left, pair.right);
        const leftProperties = Object.getOwnPropertyDescriptors(pair.left);
        const rightProperties = Object.getOwnPropertyDescriptors(pair.right);
        const keys = Reflect.ownKeys(leftProperties);
        if (keys.length !== Reflect.ownKeys(rightProperties).length) return false;
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(rightProperties, key)) return false;
            const previous = Reflect.get(leftProperties, key) as PropertyDescriptor;
            const next = Reflect.get(rightProperties, key) as PropertyDescriptor | undefined;
            if (!next || ('value' in previous) !== ('value' in next)) return false;
            if ('value' in previous) {
                pending.push({ left: previous.value, right: next.value });
            } else if (previous.get !== next.get || previous.set !== next.set) {
                return false;
            }
        }
    }
    return true;
}

function appendEvent(
    view: BrowserDiagnosticsViewState | undefined,
    event: BrowserDiagnosticEventV1,
): BrowserDiagnosticsViewState {
    const previousEvents = view && event.navigationGeneration === view.navigationGeneration
        ? view.events
        : [];
    const previousEvent = previousEvents.find((candidate) => candidate.eventId === event.eventId);
    // Compare admitted values, not the producer's raw envelope.
    if (view && previousEvent && acceptedDiagnosticValuesEqual(previousEvent, event)) {
        return view;
    }
    const dedupedEvents = previousEvents.filter((previousEvent) => previousEvent.eventId !== event.eventId);
    return {
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
        navigationGeneration: event.navigationGeneration,
        events: sortEvents([...dedupedEvents, event]),
        updatedAtMs: Math.max(view?.updatedAtMs ?? 0, event.capturedAtMs),
        ...(view?.navigationGeneration === event.navigationGeneration && view.snapshotState ? { snapshotState: view.snapshotState } : {}),
    };
}

export function createBrowserDiagnosticsUiStore(): BrowserDiagnosticsUiStore {
    return {
        viewsByKey: {},
    };
}

export function applyBrowserDiagnosticsSnapshotState(state: BrowserDiagnosticsUiStore, snapshotState: BrowserDiagnosticsSnapshotState): BrowserDiagnosticsUiStore {
    const key = browserViewKey(snapshotState);
    const view = state.viewsByKey[key];
    if (view && view.navigationGeneration > snapshotState.navigationGeneration) return state;
    if (view?.snapshotState && acceptedDiagnosticValuesEqual(view.snapshotState, snapshotState)) return state;
    const current = view?.navigationGeneration === snapshotState.navigationGeneration ? view : undefined;
    return { viewsByKey: { ...state.viewsByKey, [key]: {
        browserSessionId: snapshotState.browserSessionId, viewId: snapshotState.viewId,
        navigationGeneration: snapshotState.navigationGeneration, events: current?.events ?? [],
        updatedAtMs: current?.updatedAtMs ?? 0, snapshotState,
    } } };
}

export function applyBrowserDiagnosticEvents(
    state: BrowserDiagnosticsUiStore,
    input: Readonly<{
        events: readonly BrowserDiagnosticEventV1[];
    }>,
): BrowserDiagnosticsUiStore {
    let viewsByKey = state.viewsByKey;
    for (const event of input.events) {

        const key = browserViewKey(event);
        const existing = viewsByKey[key];
        if (existing && event.navigationGeneration < existing.navigationGeneration) {
            continue;
        }

        const nextView = appendEvent(existing, event);
        if (nextView === existing) continue;
        viewsByKey = {
            ...viewsByKey,
            [key]: nextView,
        };
    }

    return viewsByKey === state.viewsByKey ? state : { viewsByKey };
}

/**
 * Diagnostics describe the view's current document. When the view moves to a newer navigation
 * generation, the older document's events leave the view (a page without a collector would never
 * replace them) and its late stragglers stay rejected by the generation check in
 * {@link applyBrowserDiagnosticEvents}.
 */
export function advanceBrowserDiagnosticsGeneration(
    state: BrowserDiagnosticsUiStore,
    input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>,
): BrowserDiagnosticsUiStore {
    const key = browserViewKey(input);
    const existing = state.viewsByKey[key];
    if (!existing || existing.navigationGeneration >= input.navigationGeneration) return state;
    return {
        viewsByKey: {
            ...state.viewsByKey,
            [key]: { browserSessionId: existing.browserSessionId, viewId: existing.viewId,
                updatedAtMs: existing.updatedAtMs, navigationGeneration: input.navigationGeneration, events: [] },
        },
    };
}

export function selectBrowserDiagnosticsEventCount(
    state: BrowserDiagnosticsUiStore,
    input: Readonly<{ browserSessionId: string; viewId: string }>,
): number {
    return state.viewsByKey[browserViewKey(input)]?.events.filter(event => !isBrowserDiagnosticLifecycleEvent(event)).length ?? 0;
}

export function selectBrowserDiagnosticsForView(
    state: BrowserDiagnosticsUiStore,
    input: Readonly<{
        browserSessionId: string;
        viewId: string;
    }>,
): BrowserViewDiagnosticsProjection {
    const view = state.viewsByKey[browserViewKey(input)];
    if (!view) {
        return {
            status: 'unavailable',
            sourceKind: 'browserDiagnostics',
            browserSessionId: input.browserSessionId,
            viewId: input.viewId,
            fidelity: 'unavailable',
            trusted: false,
            eventCount: 0,
            families: BROWSER_DIAGNOSTIC_FAMILIES.map((family) => projectFamily(family, [])),
            events: [],
        };
    }

    const events = view.events.filter(event => !isBrowserDiagnosticLifecycleEvent(event));
    const disconnected = view.snapshotState?.connection === 'disconnected';
    const hasIndependentContent = events.some(event => event.fidelity !== 'cdp');
    return {
        status: disconnected && !hasIndependentContent ? events.length > 0 ? 'stale' : 'unavailable' : 'available',
        sourceKind: 'browserDiagnostics',
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        navigationGeneration: view.navigationGeneration,
        fidelity: view.events.reduce<BrowserDiagnosticFidelityV1>(
            (fidelity, event) => pickHigherFidelity(fidelity, event.fidelity),
            'unavailable',
        ),
        trusted: view.events.every((event) => event.trusted),
        eventCount: events.length,
        families: BROWSER_DIAGNOSTIC_FAMILIES.map((family) => {
            const projection = projectFamily(family, view.events);
            const hasIndependentSource = view.events.some(event => event.family === family && event.fidelity !== 'cdp' && event.fidelity !== 'unavailable');
            return disconnected && !hasIndependentSource && projection.status !== 'unavailable'
                ? { ...projection, status: 'stale', reasonCode: view.snapshotState?.reasonCode } : projection;
        }),
        events: events.map(projectEvent),
        ...(view.snapshotState ? { connection: view.snapshotState.connection, reasonCode: view.snapshotState.reasonCode,
            evictedEventCount: view.snapshotState.evictedEventCount ?? 0,
            omittedEventCount: view.snapshotState.omittedEventCount ?? 0 } : {}),
    };
}

export type BrowserDiagnosticEventFilters = Readonly<{
    family?: BrowserDiagnosticFamilyV1;
    search?: string;
    levels?: readonly string[];
    statuses?: readonly number[];
    resourceTypes?: readonly string[];
}>;

export type BrowserDiagnosticRowFilters = Readonly<{ search?: string }>;
export type BrowserDiagnosticRequestFilters = BrowserDiagnosticRowFilters & Readonly<{ failedOnly?: boolean }>;

function diagnosticSearchMatcher(search: string | undefined) {
    const query = search?.trim().toLocaleLowerCase();
    return (values: readonly (string | number | null | undefined)[]) =>
        !query || values.some(value => String(value ?? '').toLocaleLowerCase().includes(query));
}

/** User-invoked filtering of the admitted view; it never acquires values or retains another history. */
export function selectBrowserDiagnosticEvents(
    projection: BrowserViewDiagnosticsProjection,
    filters: BrowserDiagnosticEventFilters = {},
): readonly BrowserDiagnosticEventProjection[] {
    const matchesSearch = diagnosticSearchMatcher(filters.search);
    return projection.events.filter(event => {
        const data = event.data ?? {};
        if (filters.family && event.family !== filters.family) return false;
        if (filters.levels?.length && !filters.levels.includes(String(data.level ?? ''))) return false;
        if (filters.statuses?.length && !filters.statuses.includes(Number(data.statusCode ?? data.status))) return false;
        if (filters.resourceTypes?.length && !filters.resourceTypes.includes(String(data.resourceType ?? ''))) return false;
        return matchesSearch([event.summary, ...(event.detail?.fields.map(field => String(field.value)) ?? [])]);
    });
}

function diagnosticString(event: BrowserDiagnosticEventProjection, key: string): string | null {
    const value = event.data?.[key] ?? event.detail?.fields.find(field => field.key === key)?.value;
    return typeof value === 'string' ? value : null;
}

function diagnosticNumber(event: BrowserDiagnosticEventProjection, key: string): number | null {
    const value = event.data?.[key] ?? event.detail?.fields.find(field => field.key === key)?.value;
    return typeof value === 'number' ? value : null;
}

function latestDiagnosticValue<T>(events: readonly BrowserDiagnosticEventProjection[], read: (event: BrowserDiagnosticEventProjection) => T | null): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const value = read(events[index]!);
        if (value !== null) return value;
    }
    return null;
}

/** Reads the store's chronological projection, pairing before filtering so detail keeps all lifecycle metadata. */
export function selectBrowserDiagnosticRequests(
    projection: Pick<BrowserViewDiagnosticsProjection, 'events'>,
    filters: BrowserDiagnosticRequestFilters = {},
): readonly BrowserDiagnosticRequestProjection[] {
    const matchesSearch = diagnosticSearchMatcher(filters.search);
    const groups = new Map<string, BrowserDiagnosticEventProjection[]>();
    for (const event of projection.events) {
        if (event.family !== 'network') continue;
        const requestId = diagnosticString(event, 'requestId');
        const socketId = diagnosticString(event, 'socketId');
        const sourceId = diagnosticString(event, 'sourceId');
        const key = requestId !== null ? `request:${requestId}` : socketId !== null ? `socket:${socketId}`
            : sourceId !== null ? `source:${sourceId}` : `event:${event.eventId}`;
        const group = groups.get(key);
        if (group) group.push(event);
        else groups.set(key, [event]);
    }
    const requests = [...groups.entries()].map(([key, events]): BrowserDiagnosticRequestProjection => {
        const last = <T>(read: (event: BrowserDiagnosticEventProjection) => T | null) => latestDiagnosticValue(events, read);
        const phase = (kind: BrowserDiagnosticEventV1['kind']) => last(event => event.kind === kind ? event : null) ?? undefined;
        const status = last(event => diagnosticNumber(event, 'statusCode') ?? diagnosticNumber(event, 'status'));
        const failure = phase('network.failed');
        const kind = events[0]!.kind;
        return {
            key, requestId: last(event => diagnosticString(event, 'requestId')),
            kind: kind.startsWith('network.websocket') || kind.startsWith('network.eventSource') ? 'socket'
                : kind === 'network.sendBeacon' ? 'beacon' : 'http',
            events, start: phase('network.requestStarted'), response: phase('network.response'),
            finished: phase('network.finished'), failure,
            method: last(event => diagnosticString(event, 'method')),
            url: last(event => diagnosticUrlText(event.data?.url) ?? diagnosticString(event, 'url') ?? diagnosticString(event, 'path')),
            status, failed: failure !== undefined, isFailure: failure !== undefined || (status !== null && status >= 400),
            errorText: last(event => diagnosticString(event, 'errorText')),
            durationMs: last(event => diagnosticNumber(event, 'durationMs')),
            sizeBytes: last(event => diagnosticNumber(event, 'responseBytes') ?? diagnosticNumber(event, 'encodedDataLength') ?? diagnosticNumber(event, 'bytesQueued')),
            type: last(event => diagnosticString(event, 'resourceType')),
            state: last(event => diagnosticString(event, 'state')),
        };
    });
    return requests.filter(row => (!filters.failedOnly || row.isFailure)
        && matchesSearch([row.method, row.url, row.status, row.type, row.state, row.errorText]));
}

export function selectBrowserDiagnosticRequest(
    projection: Pick<BrowserViewDiagnosticsProjection, 'events'>,
    requestId: string,
): BrowserDiagnosticRequestProjection | undefined {
    return selectBrowserDiagnosticRequests(projection).find(request => request.requestId === requestId);
}

/** Latest inventory per storage area; filtering never combines old inventories with current values. */
export function selectBrowserDiagnosticStorageRows(
    projection: Pick<BrowserViewDiagnosticsProjection, 'events'>,
    filters: BrowserDiagnosticRowFilters = {},
): readonly BrowserDiagnosticStorageRow[] {
    const matchesSearch = diagnosticSearchMatcher(filters.search);
    const latest = new Map<string, BrowserDiagnosticEventProjection>();
    for (const event of projection.events) {
        if (event.kind === 'storage.keyInventory') latest.set(diagnosticString(event, 'storageType') ?? 'storage', event);
    }
    return [...latest.entries()].flatMap(([storageType, event]) => {
        const values = new Map((event.detail?.storageEntries ?? []).map(entry => [entry.key, entry]));
        const names = event.detail?.keys ?? [...values.keys()];
        return names.map((name, index): BrowserDiagnosticStorageRow => ({
            key: `${storageType}-${index}`, storageType, name, value: values.get(name)?.value ?? null,
            valueTruncated: values.get(name)?.valueTruncated === true,
            keyCount: diagnosticNumber(event, 'keyCount') ?? names.length,
            keysTruncated: event.data?.keysTruncated === true,
        }));
    }).filter(row => matchesSearch([row.name, row.value, row.storageType]));
}

export function selectBrowserDiagnosticResourceRows(
    projection: Pick<BrowserViewDiagnosticsProjection, 'events'>,
    filters: BrowserDiagnosticRowFilters = {},
): readonly BrowserDiagnosticResourceRow[] {
    const matchesSearch = diagnosticSearchMatcher(filters.search);
    const latest = latestDiagnosticValue(projection.events, event => event.kind === 'resources.snapshot' ? event : null);
    return (latest?.detail?.entries ?? []).map((entry, index) => ({ key: `${latest?.eventId}-${index}`, entry }))
        .filter(row => matchesSearch([row.entry.name, row.entry.initiatorType]));
}

/** Copy/export exactly the supplied destination event projections and their redaction flags. */
export function serializeBrowserDiagnosticEvents(events: readonly BrowserDiagnosticEventProjection[]): string {
    return JSON.stringify(events, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2);
}
