import {
    readAiLaunchProfileCollection,
    readProviderSettingsFromAccountSettingsV1,
    shouldPreserveLegacyAiLaunchProfileBindingV1,
    type AccountSettingsDefaults,
} from '@happier-dev/protocol';

type EnvVarRequirementLike = Readonly<{
    name: string;
    kind?: string | null;
}>;

type SettingsLike = Readonly<{
    profiles?: readonly unknown[];
    secrets?: ReadonlyArray<Readonly<{ id: string }>>;
    secretBindingsByProfileId?: Readonly<Record<string, unknown>>;
    providerSettingsV1?: unknown;
}>;

/** The only secret-binding shape exposed to runtime profile consumers. */
export type CurrentSecretBindingsByProfileId = Record<string, Record<string, string>>;

/** Protocol-owned retained carrier, intentionally not part of the runtime Settings facade. */
export type RetainedSecretBindingsByProfileId = AccountSettingsDefaults['secretBindingsByProfileId'];

type SettingsWithRetainedSecretBindingsByProfileId = Readonly<{
    secretBindingsByProfileId?: RetainedSecretBindingsByProfileId;
}>;

/**
 * Read the raw Protocol carrier only at the persistence-facing owner boundary.
 * Runtime consumers use `projectCurrentSecretBindingsByProfileId` instead.
 */
export function readRetainedSecretBindingsByProfileId(
    settings: object,
): RetainedSecretBindingsByProfileId {
    return (settings as SettingsWithRetainedSecretBindingsByProfileId).secretBindingsByProfileId ?? {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEnvVarRequirements(value: unknown): EnvVarRequirementLike[] {
    if (!Array.isArray(value)) return [];
    return value as EnvVarRequirementLike[];
}

function normalizeEnvVarName(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(upper)) return null;
    return upper;
}

function isCurrentSecretBindingMap(
    value: unknown,
    allowedSecretEnvVarNames: ReadonlySet<string>,
): value is Readonly<Record<string, string>> {
    if (!isRecord(value)) return false;
    const entries = Object.entries(value);
    return entries.length > 0
        && entries.every(([, secretId]) => typeof secretId === 'string')
        && entries.some(([rawEnvName]) => {
            const envName = normalizeEnvVarName(rawEnvName);
            return envName !== null && allowedSecretEnvVarNames.has(envName);
        });
}

type CurrentSecretBindingMapRead =
    | Readonly<{ kind: 'opaque' }>
    | Readonly<{
        kind: 'current';
        bindings: Record<string, string>;
        changed: boolean;
    }>;

function readCurrentSecretBindingMap(params: Readonly<{
    value: unknown;
    allowedSecretEnvVarNames: ReadonlySet<string>;
    secretIds: ReadonlySet<string>;
}>): CurrentSecretBindingMapRead {
    if (!isCurrentSecretBindingMap(params.value, params.allowedSecretEnvVarNames)) {
        return { kind: 'opaque' };
    }

    const bindings: Record<string, string> = {};
    let changed = false;
    for (const [rawEnvName, secretId] of Object.entries(params.value)) {
        const envName = normalizeEnvVarName(rawEnvName);
        if (!envName || !params.allowedSecretEnvVarNames.has(envName) || !params.secretIds.has(secretId)) {
            changed = true;
            continue;
        }
        if (rawEnvName !== envName) {
            changed = true;
        }
        bindings[envName] = secretId;
    }

    return { kind: 'current', bindings, changed };
}

function getAllowedSecretEnvVarNamesByProfileId(settings: SettingsLike): Record<string, Set<string>> {
    const out: Record<string, Set<string>> = {};

    for (const entry of readAiLaunchProfileCollection(settings.profiles ?? []).entries) {
        if (entry.kind !== 'legacy') continue;
        const p = entry.profile;
        const names: Set<string> = new Set<string>(
            normalizeEnvVarRequirements(p.envVarRequirements)
                .filter((r: EnvVarRequirementLike) => (r.kind ?? 'secret') === 'secret')
                .map((r: EnvVarRequirementLike) => normalizeEnvVarName(String(r.name ?? '')))
                .filter((n: string | null): n is string => typeof n === 'string' && n.length > 0),
        );
        out[p.id] = names;
    }

    return out;
}

/**
 * Retained Account JSON can carry future profile-binding envelopes. This is
 * the sole runtime reader: it exposes only positively recognized current maps
 * and leaves every opaque carrier on the persisted root for writeback.
 */
export function projectCurrentSecretBindingsByProfileId(
    settings: SettingsLike,
): CurrentSecretBindingsByProfileId {
    const bindings = settings.secretBindingsByProfileId ?? {};
    const secretIds = new Set((settings.secrets ?? []).map((secret) => secret.id));
    const allowedByProfileId = getAllowedSecretEnvVarNamesByProfileId(settings);
    const current: CurrentSecretBindingsByProfileId = {};

    for (const [profileId, byEnv] of Object.entries(bindings)) {
        const allowed = allowedByProfileId[profileId];
        if (!allowed) continue;
        const read = readCurrentSecretBindingMap({
            value: byEnv,
            allowedSecretEnvVarNames: allowed,
            secretIds,
        });
        if (read.kind !== 'current' || Object.keys(read.bindings).length === 0) continue;
        current[profileId] = read.bindings;
    }

    return current;
}

/**
 * Apply a user-visible current-map edit without deleting opaque retained
 * carriers that the runtime projection intentionally does not expose.
 */
export function mergeCurrentSecretBindingsIntoRawBindings(params: Readonly<{
    rawBindings: Readonly<RetainedSecretBindingsByProfileId>;
    currentBindings: Readonly<CurrentSecretBindingsByProfileId>;
    nextBindings: Readonly<CurrentSecretBindingsByProfileId>;
}>): RetainedSecretBindingsByProfileId {
    const next: RetainedSecretBindingsByProfileId = { ...params.rawBindings };
    for (const profileId of Object.keys(params.currentBindings)) {
        if (!Object.prototype.hasOwnProperty.call(params.nextBindings, profileId)) {
            delete next[profileId];
        }
    }
    for (const [profileId, bindings] of Object.entries(params.nextBindings)) {
        // A profile absent from the current projection but present in the raw
        // carrier is opaque. Do not let an editor that cannot read it replace
        // its retained bytes. A genuinely new profile has no raw entry.
        if (
            !Object.prototype.hasOwnProperty.call(params.currentBindings, profileId)
            && Object.prototype.hasOwnProperty.call(params.rawBindings, profileId)
        ) {
            continue;
        }
        next[profileId] = { ...bindings };
    }
    return next;
}

/**
 * Remove dangling/invalid secret bindings.
 *
 * Invariants:
 * - Unknown/historical/opaque profile bindings are preserved. Only the atomic
 *   migration owner may move or remove them.
 * - No bindings for env var names that are not declared as a secret requirement on that profile.
 * - No bindings referencing deleted secrets.
 * - Env var names are normalized to uppercase.
 */
export function pruneSecretBindings<TSettings extends SettingsLike>(settings: TSettings): TSettings {
    const bindings = settings.secretBindingsByProfileId ?? {};
    if (Object.keys(bindings).length === 0) return settings;

    const secretIds = new Set((settings.secrets ?? []).map((s: { id: string }) => s.id));
    const allowedByProfileId = getAllowedSecretEnvVarNamesByProfileId(settings);
    const collection = readAiLaunchProfileCollection(settings.profiles ?? []);
    const migration = readProviderSettingsFromAccountSettingsV1(settings).settings.migration;

    let changed = false;
    const next: Record<string, unknown> = {};

    for (const [profileId, byEnv] of Object.entries(bindings)) {
        const allowed = allowedByProfileId[profileId];
        if (!allowed) {
            if (shouldPreserveLegacyAiLaunchProfileBindingV1({ profileId, collection, migration })) {
                next[profileId] = byEnv;
            } else {
                changed = true;
            }
            continue;
        }

        // The Protocol catalog retains this root as bounded legacy JSON. A
        // non-empty all-string map with at least one declared secret key is a
        // current carrier, so prune its stale sibling entries. Preserve every
        // other carrier without interpreting it.
        const read = readCurrentSecretBindingMap({
            value: byEnv,
            allowedSecretEnvVarNames: allowed,
            secretIds,
        });
        if (read.kind !== 'current') {
            next[profileId] = byEnv;
            continue;
        }

        changed = changed || read.changed;
        if (Object.keys(read.bindings).length === 0) {
            // A `current` read is necessarily a non-empty map. If all of its
            // entries were rejected, removing that map is always a change.
            changed = true;
            continue;
        }

        next[profileId] = read.bindings;
    }

    if (!changed) return settings;
    return {
        ...settings,
        secretBindingsByProfileId: next,
    } as TSettings;
}
