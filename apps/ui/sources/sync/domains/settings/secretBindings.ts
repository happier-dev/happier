import {
    readAiLaunchProfileCollection,
    readProviderSettingsFromAccountSettingsV1,
    shouldPreserveLegacyAiLaunchProfileBindingV1,
} from '@happier-dev/protocol';

type EnvVarRequirementLike = Readonly<{
    name: string;
    kind?: string | null;
}>;

type SettingsLike = Readonly<{
    profiles: readonly unknown[];
    secrets?: ReadonlyArray<Readonly<{ id: string }>>;
    secretBindingsByProfileId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    providerSettingsV1?: unknown;
}>;

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

function getAllowedSecretEnvVarNamesByProfileId(settings: SettingsLike): Record<string, Set<string>> {
    const out: Record<string, Set<string>> = {};

    for (const entry of readAiLaunchProfileCollection(settings.profiles).entries) {
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
    const collection = readAiLaunchProfileCollection(settings.profiles);
    const migration = readProviderSettingsFromAccountSettingsV1(settings).settings.migration;

    let changed = false;
    const next: Record<string, Record<string, string>> = {};

    for (const [profileId, byEnv] of Object.entries(bindings)) {
        const allowed = allowedByProfileId[profileId];
        if (!allowed) {
            if (shouldPreserveLegacyAiLaunchProfileBindingV1({ profileId, collection, migration })) {
                next[profileId] = byEnv as Record<string, string>;
            } else {
                changed = true;
            }
            continue;
        }

        let nextByEnv: Record<string, string> | null = null;
        for (const [rawEnvName, secretId] of Object.entries(byEnv ?? {})) {
            const envName = typeof rawEnvName === 'string' ? normalizeEnvVarName(rawEnvName) : null;
            if (!envName) {
                changed = true;
                continue;
            }
            if (!allowed.has(envName)) {
                changed = true;
                continue;
            }
            if (typeof secretId !== 'string' || !secretIds.has(secretId)) {
                changed = true;
                continue;
            }
            if (!nextByEnv) nextByEnv = {};
            nextByEnv[envName] = secretId;
        }

        if (!nextByEnv || Object.keys(nextByEnv).length === 0) {
            if (Object.keys(byEnv ?? {}).length > 0) changed = true;
            continue;
        }

        next[profileId] = nextByEnv;
    }

    if (!changed) return settings;
    return {
        ...settings,
        secretBindingsByProfileId: next,
    } as TSettings;
}
