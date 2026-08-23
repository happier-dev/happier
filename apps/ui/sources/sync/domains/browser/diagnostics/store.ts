import {
    browserViewKey,
    BrowserDiagnosticEventV1Schema,
    INJECTED_CONSOLE_TEXT_MAX_LENGTH,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticFamilyV1,
    type BrowserDiagnosticFidelityV1,
} from '@happier-dev/protocol';

import { BROWSER_DIAGNOSTIC_FAMILIES } from './families';
import type {
    BrowserDiagnosticEventDetail,
    BrowserDiagnosticEventField,
    BrowserDiagnosticEventProjection,
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticResourceEntry,
    BrowserDiagnosticStorageEntry,
    BrowserDiagnosticsUiStore,
    BrowserDiagnosticsViewState,
    BrowserViewDiagnosticsProjection,
} from './types';

const MAX_BROWSER_DIAGNOSTIC_EVENTS_PER_VIEW = 1_000;

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

function stripSummaryUrlValues(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)/);

    try {
        if (schemeMatch) {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
                return parsed.protocol;
            }
            return `${parsed.origin}${parsed.pathname}`;
        }
        if (trimmed.startsWith('/')) {
            return new URL(trimmed, 'https://happier.invalid').pathname;
        }
    } catch {
        // Fall back to delimiter stripping below.
        if (schemeMatch) return schemeMatch[1];
    }

    const stripped = trimmed.split(/[?#]/, 1)[0]?.trim();
    return stripped || undefined;
}

const SAFE_RESOURCE_INITIATOR_TYPES = new Set([
    'audio',
    'beacon',
    'body',
    'css',
    'early-hint',
    'embed',
    'fetch',
    'frame',
    'iframe',
    'image',
    'img',
    'input',
    'link',
    'navigation',
    'object',
    'other',
    'ping',
    'script',
    'track',
    'video',
    'xmlhttprequest',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeUntrustedResourceEntries(value: unknown): readonly Record<string, unknown>[] | undefined {
    if (!Array.isArray(value)) return undefined;

    const entries = value.slice(-50).flatMap((entry) => {
        if (!isRecord(entry)) return [];

        const sanitized: Record<string, unknown> = {};
        const name = entry.name;
        if (typeof name === 'string') {
            const strippedName = stripSummaryUrlValues(name);
            if (strippedName) sanitized.name = strippedName;
        }

        const initiatorType = entry.initiatorType;
        if (typeof initiatorType === 'string' && SAFE_RESOURCE_INITIATOR_TYPES.has(initiatorType)) {
            sanitized.initiatorType = initiatorType;
        }

        const durationMs = entry.durationMs;
        if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
            sanitized.durationMs = durationMs;
        }

        return Object.keys(sanitized).length > 0 ? [sanitized] : [];
    });

    return entries.length > 0 ? entries : undefined;
}

function sanitizeUntrustedDiagnosticData(
    event: BrowserDiagnosticEventV1,
    options?: NormalizeDiagnosticEventOptions,
): Record<string, unknown> {
    const data = event.data;
    const sanitized: Record<string, unknown> = {};
    const url = data.url;
    if (typeof url === 'string') {
        const stripped = stripSummaryUrlValues(url);
        if (stripped) sanitized.url = stripped;
    }

    const method = data.method;
    if (typeof method === 'string') sanitized.method = method;

    const path = data.path;
    if (typeof path === 'string') {
        const stripped = stripSummaryUrlValues(path);
        if (stripped) sanitized.path = stripped;
    }

    const status = data.status ?? data.statusCode;
    if (typeof status === 'number') sanitized.statusCode = status;

    const durationMs = data.durationMs;
    if (typeof durationMs === 'number') sanitized.durationMs = durationMs;

    const requestBytes = data.requestBytes;
    if (typeof requestBytes === 'number') sanitized.requestBytes = requestBytes;

    const responseBytes = data.responseBytes;
    if (typeof responseBytes === 'number') sanitized.responseBytes = responseBytes;

    const requestAvailable = data.requestAvailable;
    if (typeof requestAvailable === 'boolean') sanitized.requestAvailable = requestAvailable;

    const errorAvailable = data.errorAvailable;
    if (typeof errorAvailable === 'boolean') sanitized.errorAvailable = errorAvailable;

    const textAvailable = data.textAvailable;
    if (typeof textAvailable === 'boolean') sanitized.textAvailable = textAvailable;

    const argCount = data.argCount;
    if (typeof argCount === 'number') sanitized.argCount = argCount;

    const level = data.level;
    if (typeof level === 'string') sanitized.level = level;

    // DEV-2: preserve the length-capped owner-only console `text` ONLY for console entries when the
    // LOCAL owner's value-capture policy is enabled. This defense-in-depth re-sanitizer otherwise
    // strips it (fail-closed). The egress classifier owns the agent/remote destination gate.
    if (
        options?.consoleValueCapture === true
        && event.kind === 'console.entry'
        && typeof data.text === 'string'
        && data.text.length > 0
    ) {
        sanitized.text = data.text.length > INJECTED_CONSOLE_TEXT_MAX_LENGTH
            ? data.text.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH)
            : data.text;
    }

    if (options?.valueCapture === true && event.kind === 'network.response') {
        for (const key of ['requestHeaders', 'responseHeaders'] as const) {
            const value = data[key];
            if (isRecord(value)) {
                const headers = Object.entries(value)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                    .map(([name, headerValue]) => `${name}: ${headerValue}`)
                    .join('\n');
                if (headers.length > 0) sanitized[key] = headers.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH);
            }
        }
        for (const key of ['requestBodyText', 'responseBodyText'] as const) {
            const value = data[key];
            if (typeof value === 'string' && value.length > 0) {
                sanitized[key] = value.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH);
            }
        }
        for (const key of ['requestBodyTruncated', 'responseBodyTruncated'] as const) {
            const value = data[key];
            if (typeof value === 'boolean') sanitized[key] = value;
        }
    }

    if (options?.valueCapture === true && event.kind === 'storage.keyInventory' && Array.isArray(data.entries)) {
        const entries = data.entries.slice(0, MAX_DETAIL_KEYS).flatMap((entry): BrowserDiagnosticStorageEntry[] => {
            if (!isRecord(entry)) return [];
            const key = typeof entry.key === 'string' ? entry.key.slice(0, 256) : '';
            const value = typeof entry.value === 'string' ? entry.value.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH) : '';
            if (!key || !value) return [];
            return [{
                key,
                value,
                ...(entry.valueTruncated === true ? { valueTruncated: true } : { valueTruncated: false }),
            }];
        });
        if (entries.length > 0) sanitized.entries = entries;
    }

    if (event.kind === 'resources.snapshot') {
        const entries = sanitizeUntrustedResourceEntries(data.entries);
        if (entries) sanitized.entries = entries;
    }

    return sanitized;
}

function sanitizeUntrustedEvalDiagnosticData(event: BrowserDiagnosticEventV1): Record<string, unknown> | null {
    const data = event.data;
    if (event.fidelity !== 'injectedPage') return null;

    if (event.kind === 'eval.requested') {
        const expressionPreview = typeof data.expressionPreview === 'string'
            ? data.expressionPreview.slice(0, 4096)
            : undefined;
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(expressionPreview ? { expressionPreview } : {}),
            expressionTruncated: data.expressionTruncated === true,
            ...(typeof data.timeoutMs === 'number' ? { timeoutMs: data.timeoutMs } : {}),
            ...(typeof data.objectGroupId === 'string' ? { objectGroupId: data.objectGroupId } : {}),
        };
    }

    if (event.kind === 'eval.completed') {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(typeof data.resultType === 'string' ? { resultType: data.resultType } : {}),
            resultDescriptionAvailable: data.resultDescriptionAvailable === true,
            resultPreviewTruncated: data.resultPreviewTruncated === true,
        };
    }

    if (event.kind === 'eval.failed') {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            errorAvailable: data.errorAvailable === true,
        };
    }

    if (event.kind === 'eval.timedOut') {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(typeof data.timeoutMs === 'number' ? { timeoutMs: data.timeoutMs } : {}),
        };
    }

    return null;
}

function pickNumber(data: Record<string, unknown>, key: string): Record<string, number> {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function pickBoolean(data: Record<string, unknown>, key: string): Record<string, boolean> {
    const value = data[key];
    return typeof value === 'boolean' ? { [key]: value } : {};
}

function pickString(data: Record<string, unknown>, key: string, maxLength: number): Record<string, string> {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? { [key]: value.slice(0, maxLength) } : {};
}

function pickEnumString<T extends string>(
    data: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
): Record<string, T> {
    const value = data[key];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? { [key]: value as T }
        : {};
}

function pickStringArray(
    data: Record<string, unknown>,
    key: string,
    maxItems: number,
    maxItemLength: number,
): Record<string, string[]> {
    const value = data[key];
    if (!Array.isArray(value)) return {};
    const strings = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, maxItems)
        .map((item) => item.slice(0, maxItemLength));
    return { [key]: strings };
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

function sanitizeUntrustedStreamingDiagnosticData(
    event: BrowserDiagnosticEventV1,
    options?: NormalizeDiagnosticEventOptions,
): Record<string, unknown> | null {
    if (event.fidelity !== 'injectedPage') return null;
    const data = event.data;

    switch (event.kind) {
        case 'network.websocketOpened':
            // The raw WS subprotocol value is a credential-egress vector and is dropped at capture
            // (egress classifier marks `protocol` as always-strip). Defense-in-depth re-sanitizer
            // surfaces presence/count only — never the value.
            return {
                ...pickString(data, 'socketId', 256),
                ...(typeof data.url === 'string' ? (() => {
                    const stripped = stripSummaryUrlValues(data.url);
                    return stripped ? { url: stripped } : {};
                })() : {}),
                ...pickBoolean(data, 'hasProtocol'),
                ...pickNumber(data, 'protocolCount'),
            };
        case 'network.websocketSummary':
            return {
                ...pickString(data, 'socketId', 256),
                ...pickString(data, 'state', 32),
                ...WEBSOCKET_SUMMARY_NUMERIC_KEYS.reduce<Record<string, number>>(
                    (acc, key) => ({ ...acc, ...pickNumber(data, key) }),
                    {},
                ),
            };
        case 'network.websocketClosed':
            return {
                ...pickString(data, 'socketId', 256),
                ...pickNumber(data, 'code'),
                ...pickBoolean(data, 'wasClean'),
            };
        case 'network.eventSourceOpened':
            return {
                ...pickString(data, 'sourceId', 256),
                ...(typeof data.url === 'string' ? (() => {
                    const stripped = stripSummaryUrlValues(data.url);
                    return stripped ? { url: stripped } : {};
                })() : {}),
            };
        case 'network.eventSourceSummary':
            return {
                ...pickString(data, 'sourceId', 256),
                ...pickString(data, 'state', 32),
                ...pickNumber(data, 'messageCount'),
                ...pickNumber(data, 'bytesReceived'),
            };
        case 'network.eventSourceClosed':
            return {
                ...pickString(data, 'sourceId', 256),
                ...pickString(data, 'state', 32),
            };
        case 'performance.vitals':
            return PERFORMANCE_VITALS_NUMERIC_KEYS.reduce<Record<string, number>>(
                (acc, key) => ({ ...acc, ...pickNumber(data, key) }),
                {},
            );
        case 'pageInfo.capabilities':
            return PAGE_CAPABILITY_KEYS.reduce<Record<string, boolean>>(
                (acc, key) => ({ ...acc, ...pickBoolean(data, key) }),
                {},
            );
        case 'network.sendBeacon':
            // Metadata only: the sanitized destination URL plus queued-byte count and acceptance flag.
            return {
                ...pickString(data, 'requestId', 256),
                ...(typeof data.url === 'string' ? (() => {
                    const stripped = stripSummaryUrlValues(data.url);
                    return stripped ? { url: stripped } : {};
                })() : {}),
                ...pickNumber(data, 'bytesQueued'),
                ...pickBoolean(data, 'accepted'),
            };
        case 'storage.keyInventory':
            return {
                ...pickEnumString(data, 'storageType', ['localStorage', 'sessionStorage'] as const),
                ...pickNumber(data, 'keyCount'),
                ...pickBoolean(data, 'keysTruncated'),
                ...pickStringArray(data, 'keys', 200, 256),
                ...(options?.valueCapture === true && Array.isArray(data.entries) ? {
                    entries: data.entries.slice(0, MAX_DETAIL_KEYS).flatMap((entry): BrowserDiagnosticStorageEntry[] => {
                        if (!isRecord(entry)) return [];
                        const key = typeof entry.key === 'string' ? entry.key.slice(0, 256) : '';
                        const value = typeof entry.value === 'string' ? entry.value.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH) : '';
                        if (!key || !value) return [];
                        return [{
                            key,
                            value,
                            valueTruncated: entry.valueTruncated === true,
                        }];
                    }),
                } : {}),
            };
        case 'pageInfo.domSnapshot':
            // Structural counts only — never page text, attribute values, or serialized markup.
            return {
                ...pickNumber(data, 'nodeCount'),
                ...pickNumber(data, 'elementCount'),
                ...pickNumber(data, 'maxDepth'),
                ...pickString(data, 'readyState', 32),
            };
        default:
            return null;
    }
}

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
            ? stripSummaryUrlValues(data.url)
            : undefined;
        const bytesQueued = typeof data.bytesQueued === 'number' ? data.bytesQueued : undefined;
        if (beaconUrl && typeof bytesQueued === 'number') {
            return `${beaconUrl} (${bytesQueued}B)`;
        }
        return beaconUrl;
    }

    const url = data.url;
    if (typeof url === 'string' && url.trim().length > 0) {
        return stripSummaryUrlValues(url);
    }

    const method = data.method;
    const path = data.path;
    if (typeof method === 'string' && typeof path === 'string') {
        const sanitizedPath = stripSummaryUrlValues(path);
        return sanitizedPath ? `${method} ${sanitizedPath}` : undefined;
    }

    const errorCode = data.errorCode;
    if (event.trusted && typeof errorCode === 'string' && errorCode.trim().length > 0) {
        return errorCode;
    }

    return undefined;
}

// Ordered scalar field keys surfaced per event kind. The store has already sanitized `event.data`
// (untrusted/injected events keep only allowlisted metadata; the egress classifier is the SSOT), so
// every key listed here is safe to render to the LOCAL owner. Order is presentation order in the
// family panels. `storage.keyInventory.keys` and `resources.snapshot.entries` are list payloads
// handled separately below; they are intentionally NOT in these scalar orders.
const DETAIL_FIELD_ORDER: Partial<Record<BrowserDiagnosticEventV1['kind'], readonly string[]>> = {
    // `text` is the owner-only length-capped console rendering: present only when the LOCAL owner's
    // value-capture policy preserved it (see `sanitizeUntrustedDiagnosticData`). It renders last so
    // the metadata (level/argCount) reads first.
    'console.entry': ['level', 'argCount', 'textAvailable', 'text'],
    'pageError.thrown': ['textAvailable'],
    'network.requestStarted': ['method', 'url', 'requestId'],
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
    ],
    'network.finished': ['requestId', 'statusCode'],
    'network.failed': ['requestAvailable', 'errorAvailable'],
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
    'pageInfo.snapshot': ['url', 'titleAvailable', 'readyState'],
    'pageInfo.capabilities': PAGE_CAPABILITY_KEYS,
    'pageInfo.domSnapshot': ['elementCount', 'nodeCount', 'maxDepth', 'readyState'],
    'performance.vitals': PERFORMANCE_VITALS_NUMERIC_KEYS,
    'eval.requested': ['tier', 'expressionPreview', 'expressionTruncated', 'timeoutMs', 'objectGroupId', 'evalRequestId'],
    'eval.completed': ['tier', 'resultType', 'resultDescriptionAvailable', 'resultPreviewTruncated', 'evalRequestId'],
    'eval.failed': ['tier', 'errorAvailable', 'evalRequestId'],
    'eval.timedOut': ['tier', 'timeoutMs', 'evalRequestId'],
};

const MAX_DETAIL_KEYS = 200;
const MAX_DETAIL_ENTRIES = 200;

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
        }
    }
    return fields;
}

function extractDetailEntries(value: unknown): readonly BrowserDiagnosticResourceEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entries: BrowserDiagnosticResourceEntry[] = [];
    for (const candidate of value.slice(0, MAX_DETAIL_ENTRIES)) {
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
    for (const candidate of value.slice(0, MAX_DETAIL_KEYS)) {
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
    const data = event.data;
    const fields = extractDetailFields(data, DETAIL_FIELD_ORDER[event.kind] ?? []);

    let keys: readonly string[] | undefined;
    if (event.kind === 'storage.keyInventory' && Array.isArray(data.keys)) {
        const stringKeys = data.keys.filter((key): key is string => typeof key === 'string').slice(0, MAX_DETAIL_KEYS);
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
        status: familyEvents.some((event) => event.kind === 'collector.degraded') ? 'stale' : 'available',
        fidelity: familyEvents.reduce<BrowserDiagnosticFidelityV1>(
            (fidelity, event) => pickHigherFidelity(fidelity, event.fidelity),
            'unavailable',
        ),
        trusted: familyEvents.every((event) => event.trusted),
    };
}

/**
 * Host re-sanitizer policy for the LOCAL owner's diagnostics store. `consoleValueCapture` mirrors the
 * producer/owner value-capture policy: when set, the store keeps the length-capped owner console
 * `text` (rendered to the local owner via the console panel) instead of collapsing it to metadata.
 */
type NormalizeDiagnosticEventOptions = Readonly<{
    consoleValueCapture?: boolean;
    valueCapture?: boolean;
}>;

function normalizeEvent(
    input: Record<string, unknown>,
    options?: NormalizeDiagnosticEventOptions,
): BrowserDiagnosticEventV1 | null {
    const parsed = BrowserDiagnosticEventV1Schema.safeParse(input);
    if (!parsed.success) return null;
    if (parsed.data.trusted) return parsed.data;
    const evalData = sanitizeUntrustedEvalDiagnosticData(parsed.data);
    const streamingData = evalData ?? sanitizeUntrustedStreamingDiagnosticData(parsed.data, options);
    return {
        ...parsed.data,
        data: streamingData ?? sanitizeUntrustedDiagnosticData(parsed.data, options),
    };
}

function sortEvents(events: readonly BrowserDiagnosticEventV1[]): readonly BrowserDiagnosticEventV1[] {
    return [...events]
        .sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.eventId.localeCompare(b.eventId))
        .slice(-MAX_BROWSER_DIAGNOSTIC_EVENTS_PER_VIEW);
}

function appendEvent(
    view: BrowserDiagnosticsViewState | undefined,
    event: BrowserDiagnosticEventV1,
): BrowserDiagnosticsViewState {
    const previousEvents = view && event.navigationGeneration === view.navigationGeneration
        ? view.events
        : [];
    const dedupedEvents = previousEvents.filter((previousEvent) => previousEvent.eventId !== event.eventId);
    return {
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
        navigationGeneration: event.navigationGeneration,
        events: sortEvents([...dedupedEvents, event]),
        updatedAtMs: Math.max(view?.updatedAtMs ?? 0, event.capturedAtMs),
    };
}

export function createBrowserDiagnosticsUiStore(): BrowserDiagnosticsUiStore {
    return {
        viewsByKey: {},
    };
}

export function applyBrowserDiagnosticEvents(
    state: BrowserDiagnosticsUiStore,
    input: Readonly<{
        events: readonly Record<string, unknown>[];
        /**
         * DEV-2: the LOCAL owner's `browser.diagnostics` value-capture policy. When set, console
         * entries retain their length-capped owner `text` so the console panel renders it; default
         * (fail-closed) strips it. Agent/remote egress is governed by the egress classifier SSOT.
         */
        consoleValueCapture?: boolean;
        valueCapture?: boolean;
    }>,
): BrowserDiagnosticsUiStore {
    let viewsByKey = state.viewsByKey;
    const normalizeOptions: NormalizeDiagnosticEventOptions = {
        consoleValueCapture: input.consoleValueCapture === true,
        valueCapture: input.valueCapture === true,
    };

    for (const rawEvent of input.events) {
        const event = normalizeEvent(rawEvent, normalizeOptions);
        if (!event) continue;

        const key = browserViewKey(event);
        const existing = viewsByKey[key];
        if (existing && event.navigationGeneration < existing.navigationGeneration) {
            continue;
        }

        const nextView = appendEvent(existing, event);
        viewsByKey = {
            ...viewsByKey,
            [key]: nextView,
        };
    }

    return viewsByKey === state.viewsByKey ? state : { viewsByKey };
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

    return {
        status: 'available',
        sourceKind: 'browserDiagnostics',
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        navigationGeneration: view.navigationGeneration,
        fidelity: view.events.reduce<BrowserDiagnosticFidelityV1>(
            (fidelity, event) => pickHigherFidelity(fidelity, event.fidelity),
            'unavailable',
        ),
        trusted: view.events.every((event) => event.trusted),
        eventCount: view.events.length,
        families: BROWSER_DIAGNOSTIC_FAMILIES.map((family) => projectFamily(family, view.events)),
        events: view.events.map(projectEvent),
    };
}
