/**
 * Agent capability configuration.
 *
 * Resume behavior is agent-specific and may be:
 * - always available (vendor-native),
 * - experimental (requires explicit opt-in).
 */

import {
    evaluateVendorResumeEligibility,
    getAgentResumeConfig,
    isBundledAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
    resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    supportsCurrentProjectedAgentSessionOpen,
    type CurrentProjectedAgentCapabilities,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import { normalizeAcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

export type ResumeCapabilityOptions = {
    accountSettings?: Record<string, unknown> | null;
    linkedSessionCurrentAgent?: Readonly<{
        identity: PluginContributionIdentityV1;
        sourceKinds: readonly string[];
    }> | null;
    /**
     * Exact lifecycle declaration from a ready daemon V2 projection. It is
     * required for non-bundled Agent resume paths; presentation backing is not
     * a substitute for this current fact.
     */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
};

function isConfiguredAcpBackendEnabled(backendId: string, options?: ResumeCapabilityOptions): boolean {
    const backendEnabledByTargetKey = options?.accountSettings?.backendEnabledByTargetKey;
    if (!backendEnabledByTargetKey || typeof backendEnabledByTargetKey !== 'object') {
        return true;
    }

    const targetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId, configuredBackendId: backendId });
    return (backendEnabledByTargetKey as Record<string, unknown>)[targetKey] !== false;
}

/**
 * The configured ACP backend a Session (or an Agent carrier id) names, or
 * `null` when neither carrier is present.
 *
 * `acpConfiguredBackendV1` is the canonical identity the daemon writes with the
 * Session and the only carrier the daemon's own
 * `resolveBackendTargetFromSessionMetadata` reads, so it outranks every other
 * evidence here. The `acp:<backendId>` spelling stays a strictly lower-precedence
 * carrier for two reachable reasons: the account-configured runtime publishes it
 * as its Agent id, and released Sessions persist it as `flavor`. It is parsed by
 * the Protocol compat owner rather than re-derived here, and it can never widen
 * eligibility on its own because resume still requires the exact Account-declared
 * backend below.
 */
export function resolveConfiguredAcpBackendId(params: Readonly<{
    metadata?: SessionMetadata | null;
    agent?: string | null;
}>): string | null {
    const canonicalBackendId = readAcpConfiguredBackendV1FromMetadata(params.metadata ?? null)?.backendId.trim();
    if (canonicalBackendId) return canonicalBackendId;

    return readLegacyConfiguredAcpBackendId(params.metadata?.flavor)
        ?? readLegacyConfiguredAcpBackendId(params.agent);
}

/**
 * Configured ACP resume requires the Account's own declaration that this exact
 * backend supports `session/load`, matching the daemon admission gate in
 * `prepareExecuteSpawnSessionRequest`, which refuses resume for a configured
 * backend whose `capabilities.supportsLoadSession` is not true. A backend that
 * is unknown to the current catalog, malformed, or silent about load support
 * fails closed: presentation must never offer a resume the runtime will reject.
 */
function canConfiguredAcpBackendResume(backendId: string, options?: ResumeCapabilityOptions): boolean {
    const catalog = normalizeAcpCatalogSettingsV1(options?.accountSettings?.acpCatalogSettingsV1);
    const backend = catalog.backends.find((candidate) => candidate.id === backendId) ?? null;
    if (backend?.capabilities.supportsLoadSession !== true) return false;

    return isConfiguredAcpBackendEnabled(backendId, options);
}

export function canAgentResume(agent: string | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (typeof agent !== 'string') return false;

    const configuredAcpBackendId = resolveConfiguredAcpBackendId({ agent });
    if (configuredAcpBackendId !== null) {
        return canConfiguredAcpBackendResume(configuredAcpBackendId, options);
    }

    const agentId = resolveExplicitAgentId(agent);
    if (!agentId) return false;
    if (!isBundledAgentId(agentId)) {
        return options?.currentAgentCapabilities?.agentId === agentId
            && supportsCurrentProjectedAgentSessionOpen(options.currentAgentCapabilities, 'resume');
    }

    const resume = getAgentResumeConfig(agentId);
    const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField : null;
    if (!field) return false;

    // Use a synthetic metadata payload to evaluate enablement without requiring
    // a specific session's persisted vendor resume id.
    const eligibilityInput = {
        agentId,
        metadata: { [field]: '__happier__' },
        accountSettings: options?.accountSettings ?? null,
        linkedSessionCurrentAgent: options?.linkedSessionCurrentAgent ?? null,
    };
    return evaluateVendorResumeEligibility(eligibilityInput).eligible === true;
}

/**
 * Minimal metadata shape used by resume capability checks.
 *
 * Note: `metadata.flavor` comes from persisted session metadata and may be `null` or an unknown string.
 */
export interface SessionMetadata {
    flavor?: string | null;
    // Vendor resume id fields vary by agent; store them as plain string properties on metadata.
    [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveDeclaredAgentIdForResume(metadata: SessionMetadata | null | undefined): string | null {
    const runtimeProviderId = readRuntimeDescriptorV1FromMetadata(metadata)?.agentId;
    if (runtimeProviderId) return runtimeProviderId;

    const linkedAgentId = readExternalSessionLink(metadata)?.agentId;
    return readNonEmptyString(linkedAgentId);
}

function resolveExplicitAgentId(agent: string | null | undefined): string | null {
    return resolveAgentIdFromFlavor(agent) ?? readNonEmptyString(agent);
}

function matchesCurrentExternalLink(
    metadata: SessionMetadata,
    currentAgent: CurrentProjectedAgentCapabilities,
    providerSessionId: string | null,
): boolean {
    const linkedSession = resolveLinkedExternalSessionMetadataV1(metadata);
    if (!linkedSession.ok) {
        return linkedSession.error === 'linked_session_not_found';
    }

    const qualifiedAgent = linkedSession.linkedSession.qualifiedIdentity?.agent;
    return linkedSession.linkedSession.agentId === currentAgent.agentId
        && qualifiedAgent !== undefined
        && qualifiedAgent.pluginId === currentAgent.identity.pluginId
        && qualifiedAgent.localId === currentAgent.identity.localId
        && (providerSessionId === null || linkedSession.linkedSession.remoteSessionId === providerSessionId);
}

function resolveCurrentExternalAgentResumeCapability(
    metadata: SessionMetadata,
    agentId: string | null,
    options?: ResumeCapabilityOptions,
): Readonly<{
    currentAgent: CurrentProjectedAgentCapabilities;
    providerSessionId: string | null;
}> | null {
    if (!agentId || isBundledAgentId(agentId)) return null;
    const currentAgent = options?.currentAgentCapabilities ?? null;
    if (!currentAgent || currentAgent.agentId !== agentId) return null;

    const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
    if (!descriptor || descriptor.agentId !== agentId) return null;
    // One owner decides what a Session's native resume id is. Re-deriving it
    // from the descriptor here is how this view and the daemon's spawn path
    // could disagree about whether a Session is resumable.
    const providerSessionId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
    if (!matchesCurrentExternalLink(metadata, currentAgent, providerSessionId)) return null;

    return {
        currentAgent,
        providerSessionId,
    };
}

function readForkLineage(metadata: Record<string, unknown>): Record<string, unknown> | null {
    const fork = asRecord(metadata.forkV1);
    if (!fork || fork.v !== 1) return null;
    const parentSessionId = readNonEmptyString(fork.parentSessionId);
    return parentSessionId ? fork : null;
}

function hasUnconsumedReplaySeed(metadata: Record<string, unknown>): boolean {
    const replaySeed = asRecord(metadata.replaySeedV1);
    if (!replaySeed || replaySeed.v !== 1) return false;
    if (!readNonEmptyString(replaySeed.seedText)) return false;
    if (readNonEmptyString(replaySeed.appliedToLocalId)) return false;
    if (readFiniteNumber(replaySeed.appliedAtMs) !== null) return false;
    return true;
}

function canFreshSpawnMissingVendorResumeId(metadata: SessionMetadata): boolean {
    const record = asRecord(metadata);
    if (!record) return false;
    const linkedSession = resolveLinkedExternalSessionMetadataV1(record);
    if (linkedSession.ok || linkedSession.error !== 'linked_session_not_found') return false;

    const fork = readForkLineage(record);
    if (!fork) return true;

    // Fork children inherit prior-session context. Without a vendor resume id,
    // a fresh spawn can only preserve that context while the replay seed is still pending.
    return readNonEmptyString(fork.strategy) === 'replay'
        && hasUnconsumedReplaySeed(record);
}

export function canResumeSession(metadata: SessionMetadata | null | undefined): boolean {
    if (!metadata) return false;
    return canResumeSessionWithOptions(metadata, undefined);
}

export function canResumeSessionWithOptions(metadata: SessionMetadata | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (!metadata) return false;
    const flavor = metadata.flavor;

    const configuredAcpBackendId = resolveConfiguredAcpBackendId({ metadata });
    if (configuredAcpBackendId !== null) {
        const metadataRecord = asRecord(metadata);
        const linkedSession = resolveLinkedExternalSessionMetadataV1(metadataRecord);
        if (linkedSession.ok || linkedSession.error !== 'linked_session_not_found') return false;
        return canConfiguredAcpBackendResume(configuredAcpBackendId, options);
    }

    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return false;
    if (!isBundledAgentId(agentId)) {
        const external = resolveCurrentExternalAgentResumeCapability(metadata, agentId, options);
        return external !== null
            && external.providerSessionId !== null
            && supportsCurrentProjectedAgentSessionOpen(external.currentAgent, 'resume');
    }

    const eligibilityInput = {
        agentId,
        metadata,
        accountSettings: options?.accountSettings ?? null,
        linkedSessionCurrentAgent: options?.linkedSessionCurrentAgent ?? null,
    };
    return evaluateVendorResumeEligibility(eligibilityInput).eligible === true;
}

/**
 * A session whose provider never started (the agent persists a vendor resume id
 * at provider session start, and none exists in metadata) has no provider
 * context to restore: it is continuable by a fresh spawn against the same
 * Happier session. Without this gate, pre-start deaths show a misleading
 * "doesn't support restoring context" dead-end (QA A-F5).
 */
export function canContinueSessionWithFreshSpawn(
    metadata: SessionMetadata | null | undefined,
    options?: ResumeCapabilityOptions,
): boolean {
    if (!metadata) return false;
    const flavor = metadata.flavor;

    // Configured ACP backends are governed by the normal resume gate.
    if (resolveConfiguredAcpBackendId({ metadata }) !== null) return false;

    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return false;
    if (!isBundledAgentId(agentId)) {
        const external = resolveCurrentExternalAgentResumeCapability(metadata, agentId, options);
        return external?.providerSessionId === null
            && supportsCurrentProjectedAgentSessionOpen(external?.currentAgent, 'create')
            && canFreshSpawnMissingVendorResumeId(metadata);
    }

    const resume = getAgentResumeConfig(agentId);
    const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField : null;
    if (!field) return false;

    const vendorResumeId = metadata[field];
    if (typeof vendorResumeId === 'string' && vendorResumeId.trim().length > 0) {
        return false;
    }

    return canFreshSpawnMissingVendorResumeId(metadata);
}

export function canResumeOrContinueSessionWithOptions(
    metadata: SessionMetadata | null | undefined,
    options?: ResumeCapabilityOptions,
): boolean {
    return canResumeSessionWithOptions(metadata, options)
        || canContinueSessionWithFreshSpawn(metadata, options);
}

export function getAgentSessionId(metadata: SessionMetadata | null | undefined): string | null {
    if (!metadata) return null;
    return getAgentVendorResumeId(metadata, undefined, undefined);
}

export function getAgentVendorResumeId(
    metadata: SessionMetadata | null | undefined,
    agent: string | null | undefined,
    options?: ResumeCapabilityOptions,
): string | null {
    if (!metadata) return null;

    // Configured ACP attach has no vendor resume id: the provider Session is
    // rejoined through the configured backend target, never through a flat
    // vendor key that another Agent's metadata may also carry.
    if (resolveConfiguredAcpBackendId({ metadata, agent }) !== null) {
        return null;
    }

    const declaredAgentId = resolveDeclaredAgentIdForResume(metadata);
    const explicitAgentId = resolveExplicitAgentId(agent);
    if (declaredAgentId && explicitAgentId && declaredAgentId !== explicitAgentId) {
        return null;
    }

    const agentId = declaredAgentId
        ?? explicitAgentId
        ?? resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return null;
    if (!isBundledAgentId(agentId)) {
        const external = resolveCurrentExternalAgentResumeCapability(metadata, agentId, options);
        if (!external || !supportsCurrentProjectedAgentSessionOpen(external.currentAgent, 'resume')) {
            return null;
        }
        return external.providerSessionId;
    }

    const eligibilityInput = {
        agentId,
        metadata,
        accountSettings: options?.accountSettings ?? null,
        linkedSessionCurrentAgent: options?.linkedSessionCurrentAgent ?? null,
    };
    const eligibility = evaluateVendorResumeEligibility(eligibilityInput);
    return eligibility.eligible === true ? eligibility.vendorResumeId : null;
}
