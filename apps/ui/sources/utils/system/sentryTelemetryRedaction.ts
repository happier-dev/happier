import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';

/**
 * The one scrubber for everything the app hands to Sentry (events, transactions, logs, breadcrumbs).
 *
 * - Public-share capabilities are templated everywhere.
 * - URLs lose their query and fragment (pairing secrets, `server=`); a URL whose host is not a
 *   Happier host also loses its host and path, so a self-hosted server address never leaves.
 * - Absolute filesystem paths (POSIX roots, `~/`, Windows drives, UNC shares) are removed from text.
 * - Fields that name a Machine, Session, Account, Server or a filesystem location are blanked.
 *
 * Stack traces and debug metadata are left as they are, apart from public-share templating, so
 * crashes stay symbolicated and grouped.
 */

const REDACTED = '[redacted]';
const REDACTED_PATH = '[redacted-path]';

const HAPPIER_HOST_SUFFIX = 'happier.dev';

const STRUCTURE_PRESERVING_KEYS = new Set(['stacktrace', 'debug_meta']);

const ID_FIELD_PATTERN = /^(?:machine|session|account|server|device|user|project|workspace)[_-]?ids?$/i;
const PATH_FIELD_PATTERN = /(?:^|[a-z_-])(?:path|paths|cwd|dir|directory)$/i;

const URL_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}):\/\/([^\s/?#"'`<>]*)([^\s?#"'`<>]*)(?:\?[^\s#"'`<>]*)?(?:#[^\s"'`<>]*)?/gi;

// A path starts at the beginning of the text or after a separator, never inside a URL or a word.
const PATH_PREFIX = '(^|[\\s"\'`(=,\\[{])';
const POSIX_ROOTS = '(?:Users|home|root|tmp|private|var|Volumes|mnt|opt|srv|media|data|workspaces?)';
const QUOTED_PATH_PATTERN = new RegExp(
    `(["'\`])(?:\\/${POSIX_ROOTS}(?=[\\/"'\`])|~[\\/\\\\]|[A-Za-z]:[\\/\\\\]|\\\\\\\\)[^"'\`\\r\\n]*\\1`,
    'g',
);
const UNQUOTED_PATH_PATTERN = new RegExp(
    `${PATH_PREFIX}(?:\\/${POSIX_ROOTS}(?=[\\/\\s"'\`<>,;)\\]}]|$)|~[\\/\\\\]|[A-Za-z]:[\\/\\\\]|\\\\\\\\)[^\\s"'\`<>,;)\\]}]*`,
    'g',
);

function isHappierHost(hostWithPort: string): boolean {
    const host = hostWithPort.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
    return host === HAPPIER_HOST_SUFFIX || host.endsWith(`.${HAPPIER_HOST_SUFFIX}`);
}

function redactUrls(text: string): string {
    return text.replace(URL_PATTERN, (_match, scheme: string, host: string, path: string) => (
        isHappierHost(host) ? `${scheme}://${host}${path}` : `${scheme}://${REDACTED}`
    ));
}

function redactPaths(text: string): string {
    return text
        .replace(QUOTED_PATH_PATTERN, (_match, quote: string) => `${quote}${REDACTED_PATH}${quote}`)
        .replace(UNQUOTED_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`);
}

function redactText(text: string, preserveStructure: boolean): string {
    const templated = redactPublicShareCapabilityUrl(text);
    return preserveStructure ? templated : redactPaths(redactUrls(templated));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isSensitiveField(key: string, value: unknown): boolean {
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    return ID_FIELD_PATTERN.test(key) || PATH_FIELD_PATTERN.test(key);
}

function redactTelemetryValue(value: unknown, seen: WeakMap<object, unknown>, preserveStructure: boolean): unknown {
    if (typeof value === 'string') return redactText(value, preserveStructure);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof String) return redactText(String(value), preserveStructure);
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
        const redacted: unknown[] = [];
        seen.set(value, redacted);
        for (const item of value) {
            redacted.push(redactTelemetryValue(item, seen, preserveStructure));
        }
        return redacted;
    }

    if (!isPlainObject(value)) return value;

    const redacted: Record<string, unknown> = {};
    seen.set(value, redacted);
    for (const [key, item] of Object.entries(value)) {
        if (!preserveStructure && isSensitiveField(key, item)) {
            redacted[key] = REDACTED;
            continue;
        }
        redacted[key] = redactTelemetryValue(item, seen, preserveStructure || STRUCTURE_PRESERVING_KEYS.has(key));
    }
    return redacted;
}

export function redactSentryTelemetry<T>(value: T): T {
    return redactTelemetryValue(value, new WeakMap(), false) as T;
}
