/**
 * Agent capability configuration.
 *
 * Resume behavior is agent-specific and may be:
 * - always available (vendor-native),
 * - experimental (requires explicit opt-in).
 */

import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol';
import {
    AGENTS_CORE,
    evaluateVendorResumeEligibility,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
    resolveConfiguredAcpSessionResume,
} from '@happier-dev/agents';
import type { Settings } from '@/sync/domains/settings/settings';

import { isAcpFlavorPrefix } from './acpFlavor';

export type ResumeCapabilityOptions = {
    accountSettings?: Partial<Settings> | null;
};

export function canAgentResume(agent: string | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (typeof agent !== 'string') return false;

    if (isAcpFlavorPrefix(agent)) {
        return false;
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

    const configuredResume = resolveConfiguredAcpSessionResume({
        metadata,
        accountSettings: options?.accountSettings ?? null,
    });
    if (configuredResume.eligible) return true;
    if (readAcpConfiguredBackendV1FromMetadata(metadata) || isAcpFlavorPrefix(flavor)) return false;

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
    void options;
    if (!metadata) return false;
    const flavor = metadata.flavor;

    // Configured ACP backends are governed by the normal exact-target resume gate.
    if (readAcpConfiguredBackendV1FromMetadata(metadata) || isAcpFlavorPrefix(flavor)) return false;

    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return false;

    const resume = AGENTS_CORE[agentId]?.resume;
    const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField : null;
    if (!field) return false;

    const vendorResumeId = metadata[field];
    return !(typeof vendorResumeId === 'string' && vendorResumeId.trim().length > 0);
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
