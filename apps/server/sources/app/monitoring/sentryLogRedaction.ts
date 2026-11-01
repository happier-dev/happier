import type { Log } from "@sentry/node";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";

const REDACTED_VALUE = "[redacted]";

const SENSITIVE_KEY_PATTERN =
    /^(authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key|x-public-share-messages-access-token)$/i;

function redactValueForKey(key: string): string | null {
    return SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function redactRecursive(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") return redactPublicShareCapabilityUrl(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) {
            out.push(redactRecursive(item, seen));
        }
        return out;
    }

    if (isPlainObject(value)) {
        /** @type {Record<string, unknown>} */
        const out: Record<string, unknown> = {};
        seen.set(value, out);
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
    const redacted = redactRecursive(attributes, new WeakMap());
    return (redacted && typeof redacted === "object" ? (redacted as Log["attributes"]) : attributes);
}

export function redactSentryLog(log: Log): Log {
    return {
        ...log,
        message: redactPublicShareCapabilityUrl(String(log.message)),
        attributes: redactSentryLogAttributes(log.attributes),
    };
}

export function redactSentryEvent<T>(event: T): T {
    return redactRecursive(event, new WeakMap()) as T;
}
