import { convertBackendTargetRefV2ToV1, parseBackendTargetKeyV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { getProfileEnvironmentVariables as getProfileEnvironmentVariablesProtocol } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { isProfileCompatibleWithBackendTarget as isProfileCompatibleWithBackendTargetProtocol, isProfileCompatibleWithAgent as isProfileCompatibleWithAgentProtocol } from '@happier-dev/protocol/profiles/profileCompatibility';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import type { AgentId } from '@/agents/registry/registryCore';

export {
    AIBackendProfileSchema,
    type AIBackendProfile,
} from './aiBackendProfileSchema';
import type { AIBackendProfile } from './aiBackendProfileSchema';
export type ProfileCompatibilitySummary =
    Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>
    & Partial<Pick<AIBackendProfile, 'compatibilityByTargetKey'>>;

function normalizeCompatibilityProfile(
    profile: ProfileCompatibilitySummary,
): Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'> {
    return {
        compatibility: profile.compatibility,
        compatibilityByTargetKey: profile.compatibilityByTargetKey ?? {},
        isBuiltIn: profile.isBuiltIn,
    };
}

export function isProfileCompatibleWithBackendTarget(
    profile: ProfileCompatibilitySummary,
    target: BackendTargetRefV2Input,
): boolean {
    const canonicalTargetKey = resolveBackendTargetKeyV2(target);
    const explicitCanonical = profile.compatibilityByTargetKey?.[canonicalTargetKey];
    if (typeof explicitCanonical === 'boolean') return explicitCanonical;
    // Read the qualified identity from the canonical key rather than from the
    // caller's spelling: a target key, a persisted ref, and a runtime carrier id
    // all name the same Agent, and only the canonical key owner knows which.
    // Deriving it here also keeps an installed Agent off the V1 conversion,
    // which can only represent identities the Protocol reader already knows.
    const canonicalTarget = parseBackendTargetKeyV2(canonicalTargetKey);
    if (canonicalTarget.kind === 'agent') {
        const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(canonicalTarget.identity);
        if (bundledAgentId !== null) {
            return isProfileCompatibleWithBackendTargetProtocol(
                normalizeCompatibilityProfile(profile),
                { kind: 'builtInAgent', agentId: bundledAgentId },
            );
        }
        // An external qualified Agent has no legacy flat Agent id. Preserve the
        // canonical profile default instead of guessing one from its identity.
        return profile.isBuiltIn ? false : true;
    }
    return isProfileCompatibleWithBackendTargetProtocol(
        normalizeCompatibilityProfile(profile),
        convertBackendTargetRefV2ToV1(canonicalTarget),
    );
}

export function isProfileCompatibleWithAgent(
    profile: ProfileCompatibilitySummary,
    agentId: AgentId,
): boolean {
    return isProfileCompatibleWithAgentProtocol(normalizeCompatibilityProfile(profile), agentId);
}

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    return getProfileEnvironmentVariablesProtocol(profile);
}
