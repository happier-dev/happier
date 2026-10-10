import React from 'react';
import { getSecretSatisfaction } from '@happier-dev/protocol/profiles/secretSatisfaction';
import type { SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { isRunnerProviderOwnedEnvironmentKey } from '@/sync/domains/ephemeralRunner/runnerAuthoringCompatibility';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

// Optimized profile lookup utility
export const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
// Returns ALL profile environment variables - daemon will use them as-is
export const transformProfileToEnvironmentVars = (profile: AIBackendProfile) => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array
    return getProfileEnvironmentVariables(profile);
};

export type MaterializedLaunchProfileEnvironment =
    | Readonly<{ ok: true; environmentVariables: Record<string, string> }>
    | Readonly<{ ok: false; reason: 'secret_requirement_unsatisfied' }>;

export class LaunchProfileEnvironmentUnavailableError extends Error {
    readonly code = 'runner_profile_environment_unavailable' as const;

    constructor(readonly reason: Extract<MaterializedLaunchProfileEnvironment, { ok: false }>['reason']) {
        super(`runner_profile_environment_unavailable:${reason}`);
        this.name = 'LaunchProfileEnvironmentUnavailableError';
    }
}

/**
 * Canonical New Session profile snapshot materializer. It resolves only the
 * explicitly selected Profile and secret bindings into the environment that a
 * Session host consumes; callers retain compatibility/config-requirement UX.
 */
export function materializeLaunchProfileEnvironment(input: Readonly<{
    profile: AIBackendProfile;
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[];
    secrets: readonly SavedSecret[];
    defaultBindings?: Record<string, string> | null;
    selectedSecretIds?: Record<string, string | null | undefined> | null;
    sessionOnlyValues?: Record<string, string | null | undefined> | null;
    machineEnvReadyByName?: Record<string, boolean | null | undefined> | null;
    resolveSavedSecretReference: (ref: string) => SavedSecretReferenceResolution;
    decryptSecretValue: (encryptedValue: SavedSecret['encryptedValue'] | null | undefined) => string | null;
}>): MaterializedLaunchProfileEnvironment {
    const isProviderOwned = (name: string) => isRunnerProviderOwnedEnvironmentKey({
        name,
        selectedAgentProviderOwnedEnvironmentKeys: input.selectedAgentProviderOwnedEnvironmentKeys,
    });
    // The selected Provider/model is already frozen independently and opened
    // through Lane 10's exact broker. Remove its legacy Profile environment at
    // the Profile owner before satisfaction/decryption so direct credential
    // material can never enter creator launch custody or the endpoint manifest.
    const portableProfile: AIBackendProfile = {
        ...input.profile,
        environmentVariables: input.profile.environmentVariables.filter((entry) => !isProviderOwned(entry.name)),
        envVarRequirements: input.profile.envVarRequirements.filter((entry) => !isProviderOwned(entry.name)),
    };
    let environmentVariables = transformProfileToEnvironmentVars(portableProfile);
    const satisfaction = getSecretSatisfaction({
        profile: portableProfile,
        secrets: [...input.secrets],
        defaultBindings: input.defaultBindings,
        selectedSecretIds: input.selectedSecretIds,
        sessionOnlyValues: input.sessionOnlyValues,
        machineEnvReadyByName: input.machineEnvReadyByName,
    });
    if (!satisfaction.isSatisfied) return { ok: false, reason: 'secret_requirement_unsatisfied' };

    for (const item of satisfaction.items) {
        if (!item.isSatisfied || item.satisfiedBy === 'machineEnv') continue;
        let injected: string | null = null;
        if (item.satisfiedBy === 'sessionOnly') {
            injected = input.sessionOnlyValues?.[item.envVarName] ?? null;
        } else if (item.savedSecretId) {
            const resolved = input.resolveSavedSecretReference(item.savedSecretId);
            if (resolved.status !== 'ready' || !resolved.secret) {
                return { ok: false, reason: 'secret_requirement_unsatisfied' };
            }
            injected = input.decryptSecretValue(resolved.secret.encryptedValue);
        }
        if (typeof injected !== 'string' || injected.length === 0) {
            return { ok: false, reason: 'secret_requirement_unsatisfied' };
        }
        environmentVariables = { ...environmentVariables, [item.envVarName]: injected };
    }
    return { ok: true, environmentVariables };
}

export function isLaunchProfileReviewCurrent(
    reviewed: AIBackendProfile | null,
    current: AIBackendProfile | null,
): boolean {
    return reviewed !== null
        && current !== null
        && createCanonicalJsonSigningInput(reviewed) === createCanonicalJsonSigningInput(current);
}

export class LaunchProfileReviewChangedError extends Error {
    readonly code = 'runner_profile_selection_changed' as const;

    constructor() {
        super('runner_profile_selection_changed');
        this.name = 'LaunchProfileReviewChangedError';
    }
}

export function assertLaunchProfileReviewCurrent(
    reviewed: AIBackendProfile | null,
    current: AIBackendProfile | null,
): asserts current is AIBackendProfile {
    if (!isLaunchProfileReviewCurrent(reviewed, current)) {
        throw new LaunchProfileReviewChangedError();
    }
}

/**
 * The two deterministic answers this owner can give a frozen launch submission.
 *
 * Both are decided entirely from the target Account's current Profile record and
 * secrets, so sending the same frozen submission again produces the same answer.
 * Consumers use them to replace a generic retryable failure with the exact
 * unsupported selection and the one recovery that can resolve it: editing.
 */
export const LAUNCH_PROFILE_INCOMPATIBILITIES = [
    'profile_changed',
    'profile_environment_unavailable',
] as const;

export type LaunchProfileIncompatibility = typeof LAUNCH_PROFILE_INCOMPATIBILITIES[number];

export function resolveLaunchProfileIncompatibility(error: unknown): LaunchProfileIncompatibility | null {
    if (error instanceof LaunchProfileReviewChangedError) return 'profile_changed';
    if (error instanceof LaunchProfileEnvironmentUnavailableError) return 'profile_environment_unavailable';
    return null;
}

export function isLaunchProfileIncompatibility(value: string): value is LaunchProfileIncompatibility {
    return (LAUNCH_PROFILE_INCOMPATIBILITIES as readonly string[]).includes(value);
}
