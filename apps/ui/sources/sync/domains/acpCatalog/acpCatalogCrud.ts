import type { AcpBackendDefinitionV1, AcpCatalogSettingsV1 } from '@happier-dev/protocol';

function hasDuplicateBackendId(settings: AcpCatalogSettingsV1, id: string): boolean {
    return settings.backends.some((backend) => backend.id === id);
}

function hasDuplicateBackendName(settings: AcpCatalogSettingsV1, name: string, excludeId?: string): boolean {
    return settings.backends.some((backend) => backend.id !== excludeId && backend.name === name);
}

export function upsertAcpBackendDefinitionV1(
    settings: AcpCatalogSettingsV1,
    backend: AcpBackendDefinitionV1,
): AcpCatalogSettingsV1 {
    if (hasDuplicateBackendName(settings, backend.name, backend.id)) {
        throw new Error(`Duplicate ACP backend name: ${backend.name}`);
    }

    const hasExisting = hasDuplicateBackendId(settings, backend.id);
    const backends = hasExisting
        ? settings.backends.map((entry) => (entry.id === backend.id ? backend : entry))
        : [...settings.backends, backend];

    return { ...settings, backends };
}

export function deleteAcpBackendDefinitionV1(
    settings: AcpCatalogSettingsV1,
    backendId: string,
): AcpCatalogSettingsV1 {
    return {
        ...settings,
        backends: settings.backends.filter((backend) => backend.id !== backendId),
    };
}
