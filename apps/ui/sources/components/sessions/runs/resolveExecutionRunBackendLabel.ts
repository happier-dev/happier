import { readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { hasAgentIconMark, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';

function readExecutionRunDisplayTarget(backendTarget: BackendTargetRefV2Input | null | undefined) {
    if (!backendTarget) return null;
    try {
        return readBackendTargetRefV2(backendTarget);
    } catch {
        return null;
    }
}

export function resolveExecutionRunBackendLabel(
    backendTarget: BackendTargetRefV2Input | null | undefined,
    catalog?: AcpCatalogSnapshotV1 | null,
): string | null {
    const canonicalTarget = readExecutionRunDisplayTarget(backendTarget);
    if (!canonicalTarget) return null;

    if (!canonicalTarget.configuredBackendId) {
        if (isBundledAgentId(canonicalTarget.backendId)) {
            return resolveAgentCatalogTitle(canonicalTarget.backendId);
        }
        return canonicalTarget.backendId;
    }

    if (catalog?.status !== 'ready') return canonicalTarget.configuredBackendId;
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: [], acpCatalogSnapshot: catalog })
        .find(candidate => candidate.kind === 'configuredBackend' && backendTargetKeysMatch(candidate.backendTarget, canonicalTarget));
    return entry?.title ?? canonicalTarget.configuredBackendId;
}

/**
 * The Agent whose brand mark stands for a run's backend (the walkthrough's "Opus 5.5 read all 14").
 * A configured backend, an unreadable target or an Agent without a contributed mark has none: callers
 * keep their neutral glyph rather than inventing an identity.
 */
export function resolveExecutionRunAgentMarkId(
    backendTarget: BackendTargetRefV2Input | null | undefined,
    theme: Parameters<typeof hasAgentIconMark>[1],
): string | null {
    const canonicalTarget = readExecutionRunDisplayTarget(backendTarget);
    if (!canonicalTarget || canonicalTarget.configuredBackendId) return null;
    return hasAgentIconMark(canonicalTarget.backendId, theme) ? canonicalTarget.backendId : null;
}
