import { readBackendTargetRefV2, type AcpCatalogSettingsV1, type BackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';

function resolveConfiguredBackendLabel(target: BackendTargetRefV2, catalog: AcpCatalogSettingsV1): string {
    const configuredBackendId = target.configuredBackendId ?? '';
    if (!configuredBackendId) return target.backendId;

    const normalized = normalizeAcpCatalogSettingsV1(catalog);
    const backend = normalized.backends.find((candidate) => candidate.id === configuredBackendId) ?? null;
    if (!backend) return configuredBackendId;
    return backend.title || backend.name || configuredBackendId;
}

export function resolveExecutionRunBackendLabel(
    backendTarget: BackendTargetRefV2Input | null | undefined,
    catalog?: AcpCatalogSettingsV1 | null,
): string | null {
    if (!backendTarget) return null;

    const canonicalTarget: BackendTargetRefV2 = readBackendTargetRefV2(backendTarget);

    if (!canonicalTarget.configuredBackendId) {
        if (isBundledAgentId(canonicalTarget.backendId)) {
            return t(getAgentCore(canonicalTarget.backendId).displayNameKey);
        }
        return canonicalTarget.backendId;
    }

    return resolveConfiguredBackendLabel(
        canonicalTarget,
        catalog
            ?? storage.getState()?.settings?.acpCatalogSettingsV1
            ?? { v: 2, backends: [] },
    );
}
