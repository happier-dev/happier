import type { FeatureId } from '../features/featureIds.js';

/**
 * One declaration of a server configuration key (plan `2026-09-26-home-owner-console` §3.14).
 *
 * An entry is keyed by its environment variable name and states, once, how the value is typed,
 * defaulted and bounded, whether it is secret, whether a change applies live or needs a restart,
 * which console section shows it, and who may set it:
 *
 * - `home`: an owner may persist it from the console; an explicitly set deployment env value
 *   still wins (and is shown as fixed). A `restart` entry takes effect at the next start.
 * - `bootstrap`: read-only in the console for one of three technical constraints (r4,
 *   `readOnlyReason`): read before the database opens (or by the Home settings overlay itself),
 *   per-process/replica identity, or an invariant that forbids Home editing (I1, I9). Only env
 *   can set it.
 * - `internal`: a runtime or build fact supplied by its producer, not an operator setting.
 *   Never rendered or writable; declared so the coverage check and the docs know it.
 */
export type ServerConfigValueType =
    | 'boolean'
    | 'int'
    | 'float'
    | 'string'
    | 'enum'
    | 'url'
    | 'email'
    | 'list'
    | 'json';

export type ServerConfigSection = 'reach' | 'email' | 'policies' | 'features' | 'data' | 'runtime' | 'server';
export type ServerConfigEditable = 'home' | 'bootstrap' | 'internal';
/** Why a `bootstrap` entry is read-only (plan §3.14, r4). */
export type ServerConfigReadOnlyReason = 'before_database' | 'per_process_identity' | 'invariant';
export type ServerConfigApply = 'live' | 'restart';
export type ServerConfigSensitivity = 'plain' | 'secret';

export type ServerConfigBounds = Readonly<{
    min?: number;
    max?: number;
    maxUtf8Bytes?: number;
    noControlChars?: true;
    values?: readonly string[];
    scheme?: 'https';
}>;

export type ServerConfigValue = boolean | number | string | readonly string[] | ServerConfigJsonValue;
export type ServerConfigJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ServerConfigJsonValue[]
    | { readonly [key: string]: ServerConfigJsonValue };

export type ServerConfigEntryInput = Readonly<{
    type: ServerConfigValueType;
    default?: ServerConfigValue;
    bounds?: ServerConfigBounds;
    sensitivity: ServerConfigSensitivity;
    apply: ServerConfigApply;
    editable: ServerConfigEditable;
    section: ServerConfigSection;
    /** Sub-grouping of rows within a section (for example `database` or `monitoring` in `server`). */
    group?: string;
    /** Presentation applicability; configured values remain visible regardless of this condition. */
    appliesWhen?: Readonly<{ key: string; values: readonly string[] }>;
    family?: string;
    featureId?: FeatureId;
    /** Older names read (in order) when the key itself is unset; never written. */
    aliases?: readonly string[];
    /** Legacy enum spellings; the codec still checks the result against bounds.values. Never projected. */
    normalizeEnumValue?: (raw: string) => string | null;
    /** Domain-owned string admission/canonicalization, shared by env reads and Home writes. Never projected. */
    normalizeStringValue?: (raw: string) => string | null;
    /** Historical env flags enabled by any nonempty value, including `false`; Off serializes as empty. */
    booleanEnvEncoding?: 'presence';
    description: string;
    docs?: string;
    /** Constraint class of a read-only key; required for (and only for) `bootstrap` entries. */
    readOnlyReason?: ServerConfigReadOnlyReason;
    /** Why the key is not Home-editable, as text; required for (and only for) `bootstrap` entries. */
    reason?: string;
}>;

export type ServerConfigEntry<K extends string = string> = ServerConfigEntryInput & Readonly<{ key: K }>;

export type ServerConfigRegistry = Readonly<Record<string, ServerConfigEntry>>;

export type DefinedServerConfigRegistry<T extends Readonly<Record<string, ServerConfigEntryInput>>> = {
    readonly [K in keyof T & string]: T[K] & Readonly<{ key: K }>;
};

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;

function fail(key: string, message: string): never {
    throw new Error(`Server config entry ${key}: ${message}`);
}

/**
 * The entry rules the plan makes binding. They run once when a registry module loads, so a bad
 * declaration fails every test and every server start rather than surfacing as a console bug.
 */
export function assertServerConfigEntry(key: string, entry: ServerConfigEntryInput): void {
    if (!ENV_KEY_PATTERN.test(key)) fail(key, 'key must be an upper-case environment variable name');
    if (!entry.description.trim()) fail(key, 'description is required');
    if (entry.group !== undefined && (!entry.group.trim() || entry.group !== entry.group.trim())) {
        fail(key, 'group must be a nonempty, unpadded identifier');
    }
    if (entry.appliesWhen) {
        if (!ENV_KEY_PATTERN.test(entry.appliesWhen.key) || entry.appliesWhen.key === key) {
            fail(key, 'applicability must reference another environment key');
        }
        if (entry.appliesWhen.values.length === 0 || entry.appliesWhen.values.some((value) => !value.trim())) {
            fail(key, 'applicability must declare nonempty values');
        }
    }
    if (entry.editable === 'bootstrap' && !entry.reason?.trim()) fail(key, 'a bootstrap entry must state its reason');
    if (entry.editable === 'bootstrap' && !entry.readOnlyReason) fail(key, 'a bootstrap entry must declare its readOnlyReason');
    if (entry.editable !== 'bootstrap' && (entry.reason !== undefined || entry.readOnlyReason !== undefined)) {
        fail(key, 'only a bootstrap entry carries a read-only reason');
    }
    if (entry.type === 'enum' && !(entry.bounds?.values && entry.bounds.values.length > 0)) {
        fail(key, 'an enum entry must declare bounds.values');
    }
    if (entry.normalizeEnumValue && entry.type !== 'enum') fail(key, 'enum normalization applies only to enum entries');
    if (entry.normalizeStringValue && entry.type !== 'string') fail(key, 'string normalization applies only to string entries');
    if (entry.booleanEnvEncoding && (entry.type !== 'boolean' || entry.default !== false)) {
        fail(key, 'presence encoding requires a boolean entry with default false');
    }
    if (entry.bounds?.values && entry.type !== 'enum' && entry.type !== 'list') {
        fail(key, 'bounds.values applies only to enum and list entries');
    }
    if ((entry.bounds?.min !== undefined || entry.bounds?.max !== undefined) && entry.type !== 'int' && entry.type !== 'float') {
        fail(key, 'numeric bounds apply only to int and float entries');
    }
    if (entry.bounds?.maxUtf8Bytes !== undefined && entry.type !== 'string') {
        fail(key, 'UTF-8 byte bounds apply only to string entries');
    }
    if (entry.bounds?.noControlChars && entry.type !== 'string') {
        fail(key, 'control-character bounds apply only to string entries');
    }
    if (entry.bounds?.scheme && entry.type !== 'url' && entry.type !== 'list') {
        fail(key, 'bounds.scheme applies only to url and list entries');
    }
    if (entry.sensitivity === 'secret' && entry.default !== undefined) {
        fail(key, 'a secret entry cannot declare a default');
    }
    for (const alias of entry.aliases ?? []) {
        if (!ENV_KEY_PATTERN.test(alias)) fail(key, `alias ${alias} must be an environment variable name`);
        if (alias === key) fail(key, 'an alias cannot repeat the key');
    }
}

/** Declares a group of entries and stamps each with its own key. */
export function defineServerConfigRegistry<const T extends Readonly<Record<string, ServerConfigEntryInput>>>(
    entries: T,
): DefinedServerConfigRegistry<T> {
    const out: Record<string, ServerConfigEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
        assertServerConfigEntry(key, entry);
        out[key] = Object.freeze({ ...entry, key });
    }
    return Object.freeze(out) as DefinedServerConfigRegistry<T>;
}

/**
 * Joins declaration groups into one registry. A key or alias declared twice is a registry bug
 * (two owners for one key), so it throws instead of letting the later group win.
 */
export function composeServerConfigRegistry(
    ...groups: ReadonlyArray<ServerConfigRegistry | readonly ServerConfigEntry[]>
): ServerConfigRegistry {
    const out: Record<string, ServerConfigEntry> = {};
    const names = new Map<string, string>();
    for (const group of groups) {
        const entries = Array.isArray(group) ? group : Object.values(group);
        for (const entry of entries as readonly ServerConfigEntry[]) {
            assertServerConfigEntry(entry.key, entry);
            for (const name of [entry.key, ...(entry.aliases ?? [])]) {
                const owner = names.get(name);
                if (owner) fail(entry.key, `${name} is already declared by ${owner}`);
                names.set(name, entry.key);
            }
            out[entry.key] = entry;
        }
    }
    for (const entry of Object.values(out)) {
        const condition = entry.appliesWhen;
        if (!condition) continue;
        const controlling = out[condition.key];
        if (!controlling || controlling.type !== 'enum' || controlling.sensitivity !== 'plain') {
            fail(entry.key, 'applicability must reference a declared plain enum');
        }
        if (condition.values.some((value) => !controlling.bounds?.values?.includes(value))) {
            fail(entry.key, 'applicability values must belong to the referenced enum');
        }
    }
    return Object.freeze(out);
}

/** Resolves an env name (a key or one of its aliases) to its entry. */
export function findServerConfigEntry(registry: ServerConfigRegistry, name: string): ServerConfigEntry | null {
    const direct = registry[name];
    if (direct) return direct;
    for (const entry of Object.values(registry)) {
        if (entry.aliases?.includes(name)) return entry;
    }
    return null;
}

export function serverConfigReadOnlyReason(entry: ServerConfigEntryInput): string | null {
    return entry.editable === 'bootstrap' ? entry.reason ?? null : null;
}
