import { readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';

export function resolveExecutionRunBackendLabel(
    backendTarget: BackendTargetRefV2Input | null | undefined,
    catalog?: AcpCatalogSnapshotV1 | null,
): string | null {
    if (!backendTarget) return null;

    const canonicalTarget = readBackendTargetRefV2(backendTarget);

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
