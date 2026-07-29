import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function redactTelemetryValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return redactPublicShareCapabilityUrl(value);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof String) return redactPublicShareCapabilityUrl(String(value));
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
        const redacted: unknown[] = [];
        seen.set(value, redacted);
        for (const item of value) {
            redacted.push(redactTelemetryValue(item, seen));
        }
        return redacted;
    }

    if (!isPlainObject(value)) return value;

    const redacted: Record<string, unknown> = {};
    seen.set(value, redacted);
    for (const [key, item] of Object.entries(value)) {
        redacted[key] = redactTelemetryValue(item, seen);
    }
    return redacted;
}

export function redactSentryPublicShareTelemetry<T>(value: T): T {
    return redactTelemetryValue(value, new WeakMap()) as T;
}
