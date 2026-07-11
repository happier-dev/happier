import {
    isUnsafeTelemetryDataKey,
    normalizeTelemetryDataKey,
} from '@happier-dev/protocol';

const REDACTED_DEBUG_VALUE = '[redacted]';
const CIRCULAR_DEBUG_VALUE = '[circular]';

const SESSION_DEBUG_SENSITIVE_KEYS = new Set([
    'access-key',
    'credential',
    'credentials',
    'data-encryption-key',
    'direct-secret-key',
    'encrypted-data-key',
    'encrypted-data-key-envelope',
    'encrypted-data-key-envelope-base64',
    'private-key',
    'secret',
    'secret-key',
    'signing-key',
]);

const SESSION_DEBUG_SENSITIVE_COMPACT_KEYS = new Set(
    Array.from(SESSION_DEBUG_SENSITIVE_KEYS, (key) => key.replaceAll('-', '')),
);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveSessionDebugKey(key: string): boolean {
    if (isUnsafeTelemetryDataKey(key)) return true;

    const normalized = normalizeTelemetryDataKey(key);
    const compact = normalized.replaceAll('-', '');
    if (
        SESSION_DEBUG_SENSITIVE_KEYS.has(normalized)
        || SESSION_DEBUG_SENSITIVE_COMPACT_KEYS.has(compact)
    ) {
        return true;
    }

    return normalized.endsWith('-secret')
        || compact.endsWith('secret')
        || normalized.endsWith('-private-key')
        || compact.endsWith('privatekey')
        || normalized.endsWith('-secret-key')
        || compact.endsWith('secretkey')
        || normalized.endsWith('-data-key')
        || compact.endsWith('datakey')
        || normalized.endsWith('-encryption-key')
        || compact.endsWith('encryptionkey');
}

function redactSessionDebugValueInner(value: unknown, seen: WeakSet<object>): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactSessionDebugValueInner(item, seen));
    }

    if (!isRecord(value)) {
        return value;
    }

    if (seen.has(value)) {
        return CIRCULAR_DEBUG_VALUE;
    }

    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
        output[key] = isSensitiveSessionDebugKey(key)
            ? REDACTED_DEBUG_VALUE
            : redactSessionDebugValueInner(nested, seen);
    }
    seen.delete(value);
    return output;
}

export function redactSessionDebugValue(value: unknown): unknown {
    return redactSessionDebugValueInner(value, new WeakSet<object>());
}

export function stringifySessionDebugJson(value: unknown): string {
    return JSON.stringify(redactSessionDebugValue(value), null, 2) ?? 'null';
}
