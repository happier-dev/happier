import type { Log } from "@sentry/core";

const REDACTED_VALUE = "[redacted]";

const SENSITIVE_KEY_PATTERN = /^(authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key)$/i;

function redactValueForKey(key: string): string | null {
    return SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function redactRecursive(value: unknown, seen: WeakSet<object>): unknown {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);

    if (Array.isArray(value)) {
        return value.map((v) => redactRecursive(v, seen));
    }

    if (isPlainObject(value)) {
        /** @type {Record<string, unknown>} */
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) {
            const redacted = redactValueForKey(key);
            out[key] = redacted ?? redactRecursive(v, seen);
        }
        return out;
    }

    return value;
}

export function redactSentryLogAttributes(attributes: Log["attributes"] | undefined): Log["attributes"] | undefined {
    if (!attributes) return attributes;
    const redacted = redactRecursive(attributes, new WeakSet());
    return (redacted && typeof redacted === "object" ? (redacted as Log["attributes"]) : attributes);
}
