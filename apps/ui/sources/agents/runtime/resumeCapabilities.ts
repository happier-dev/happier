/**
 * Agent capability configuration.
 *
 * Resume behavior is agent-specific and may be:
 * - always available (vendor-native),
 * - experimental (requires explicit opt-in).
 */

import { buildBackendTargetKey } from '@happier-dev/protocol';
import { AGENTS_CORE, evaluateVendorResumeEligibility, resolveAgentIdFromFlavor, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { Settings } from '@/sync/domains/settings/settings';

import { deriveAcpBackendIdFromFlavor, isAcpFlavorPrefix } from './acpFlavor';

export type ResumeCapabilityOptions = {
    accountSettings?: Partial<Settings> | null;
};

function isConfiguredAcpBackendEnabled(backendId: string, options?: ResumeCapabilityOptions): boolean {
    const backendEnabledByTargetKey = options?.accountSettings?.backendEnabledByTargetKey;
    if (!backendEnabledByTargetKey || typeof backendEnabledByTargetKey !== 'object') {
        return true;
    }

    const targetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId });
    return (backendEnabledByTargetKey as Record<string, unknown>)[targetKey] !== false;
}

function getConfiguredAcpBackendId(
    flavor: string | null | undefined,
    metadata?: SessionMetadata | null,
): string | null {
    const backendIdFromFlavor = deriveAcpBackendIdFromFlavor(flavor);
    if (backendIdFromFlavor === null) {
        return null;
    }

    const backendIdFromMetadata =
        typeof metadata?.acpConfiguredBackendV1 === 'object'
            && metadata.acpConfiguredBackendV1 !== null
            && 'backendId' in metadata.acpConfiguredBackendV1
            && typeof metadata.acpConfiguredBackendV1.backendId === 'string'
            ? metadata.acpConfiguredBackendV1.backendId.trim()
            : '';

    return backendIdFromMetadata.length > 0 ? backendIdFromMetadata : backendIdFromFlavor;
}

export function canAgentResume(agent: string | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (typeof agent !== 'string') return false;

    if (isAcpFlavorPrefix(agent)) {
        const backendId = getConfiguredAcpBackendId(agent);
        return backendId !== null && isConfiguredAcpBackendEnabled(backendId, options);
    }

    const agentId = resolveAgentIdFromFlavor(agent);
    if (!agentId) return false;

    const resume = AGENTS_CORE[agentId]?.resume;
    const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField : null;
    if (!field) return false;

    // Use a synthetic metadata payload to evaluate enablement without requiring
    // a specific session's persisted vendor resume id.
    return (
        evaluateVendorResumeEligibility({
            agentId,
            metadata: { [field]: '__happier__' },
            accountSettings: options?.accountSettings ?? null,
        }).eligible === true
    );
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

export function canResumeSession(metadata: SessionMetadata | null | undefined): boolean {
    if (!metadata) return false;
    return canResumeSessionWithOptions(metadata, undefined);
}

export function canResumeSessionWithOptions(metadata: SessionMetadata | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (!metadata) return false;
    const flavor = metadata.flavor;

    if (isAcpFlavorPrefix(flavor)) {
        const backendId = getConfiguredAcpBackendId(flavor, metadata);
        return backendId !== null && isConfiguredAcpBackendEnabled(backendId, options);
    }

    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return false;

    return (
        evaluateVendorResumeEligibility({
            agentId,
            metadata,
            accountSettings: options?.accountSettings ?? null,
        }).eligible === true
    );
}

export function getAgentSessionId(metadata: SessionMetadata | null | undefined): string | null {
    if (!metadata) return null;
    return getAgentVendorResumeId(metadata, metadata.flavor, undefined);
}

export function getAgentVendorResumeId(
    metadata: SessionMetadata | null | undefined,
    agent: string | null | undefined,
    options?: ResumeCapabilityOptions,
): string | null {
    if (!metadata) return null;

    if (isAcpFlavorPrefix(metadata.flavor) || isAcpFlavorPrefix(agent)) {
        return null;
    }

    const agentId = resolveAgentIdFromFlavor(agent) ?? resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return null;

    const eligibility = evaluateVendorResumeEligibility({
        agentId,
        metadata,
        accountSettings: options?.accountSettings ?? null,
    });
    return eligibility.eligible === true ? eligibility.vendorResumeId : null;
}
