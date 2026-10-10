import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

type EnvVarRequirementLike = Readonly<{
    name: string;
    kind?: string | null;
}>;

/** The only secret-binding shape exposed to runtime profile consumers. */
export type CurrentSecretBindingsByProfileId = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSavedSecretReference(value: string): boolean {
    try {
        parseSavedSecretRefV1(value);
        return true;
    } catch {
        return false;
    }
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
    }>;

function readCurrentSecretBindingMap(params: Readonly<{
    value: unknown;
    allowedSecretEnvVarNames: ReadonlySet<string>;
}>): CurrentSecretBindingMapRead {
    if (!isCurrentSecretBindingMap(params.value, params.allowedSecretEnvVarNames)) {
        return { kind: 'opaque' };
    }

    const bindings: Record<string, string> = {};
    for (const [rawEnvName, secretId] of Object.entries(params.value)) {
        const envName = normalizeEnvVarName(rawEnvName);
        if (
            !envName
            || !params.allowedSecretEnvVarNames.has(envName)
            || !isSavedSecretReference(secretId)
        ) {
            continue;
        }
        bindings[envName] = secretId;
    }

    return { kind: 'current', bindings };
}

function getAllowedSecretEnvVarNamesByProfileId(profiles: readonly AiLaunchProfile[]): Record<string, Set<string>> {
    const out: Record<string, Set<string>> = {};

    for (const p of profiles) {
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
 * Project bindings from the admitted Profile source. Material availability is
 * resolved separately by the scoped Saved Secret owner, never legacy arrays.
 */
export function projectCurrentSecretBindingsByProfileId(
    profiles: readonly AiLaunchProfile[],
): CurrentSecretBindingsByProfileId {
    const bindings: Record<string, unknown> = {};
    for (const profile of profiles) {
        if (profile.secretBindings) bindings[profile.id] = profile.secretBindings;
    }
    const allowedByProfileId = getAllowedSecretEnvVarNamesByProfileId(profiles);
    const current: CurrentSecretBindingsByProfileId = {};

    for (const [profileId, byEnv] of Object.entries(bindings)) {
        const allowed = allowedByProfileId[profileId];
        if (!allowed) continue;
        const read = readCurrentSecretBindingMap({
            value: byEnv,
            allowedSecretEnvVarNames: allowed,
        });
        if (read.kind !== 'current' || Object.keys(read.bindings).length === 0) continue;
        current[profileId] = read.bindings;
    }

    return current;
}
