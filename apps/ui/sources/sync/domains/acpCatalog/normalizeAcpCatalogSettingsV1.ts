import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';

export function normalizeAcpCatalogSettingsV1(settings: unknown): AcpCatalogSettingsV1 {
    const raw = settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings as Partial<AcpCatalogSettingsV1>
        : null;

    if (raw?.v !== 2) {
        return {
            v: 2,
            backends: [],
        };
    }

    const backends = Array.isArray(raw.backends) ? raw.backends : [];
    if (backends === raw.backends) {
        return raw as AcpCatalogSettingsV1;
    }
    return {
        v: 2,
        backends,
    };
}
