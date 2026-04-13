import { readBackendTargetRefV2, type AcpCatalogSettingsV1, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { storage } from '@/sync/domains/state/storage';

function resolveConfiguredBackendLabel(target: Extract<BackendTargetRefV1, { kind: 'configuredAcpBackend' }>, catalog: AcpCatalogSettingsV1): string {
    const normalized = normalizeAcpCatalogSettingsV1(catalog);
    const backend = normalized.backends.find((candidate) => candidate.id === target.backendId) ?? null;
    if (!backend) return target.backendId;
    return backend.title || backend.name || target.backendId;
}

export function resolveExecutionRunBackendLabel(
    backendTarget: BackendTargetRefV1 | null | undefined,
    catalog?: AcpCatalogSettingsV1 | null,
): string | null {
    if (!backendTarget) return null;
    const canonicalBackendTarget = readBackendTargetRefV2(backendTarget as any);
    if (canonicalBackendTarget.kind === 'backend' && canonicalBackendTarget.sourceKind !== 'configured') {
        return canonicalBackendTarget.backendId;
    }
    return resolveConfiguredBackendLabel(
        backendTarget.kind === 'configuredAcpBackend'
            ? backendTarget
            : { kind: 'configuredAcpBackend', backendId: canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId },
        catalog
            ?? storage.getState()?.settings?.acpCatalogSettingsV1
            ?? { v: 2, backends: [] },
    );
}
