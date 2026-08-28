import { AcpCatalogSettingsV1Schema, type AcpCatalogSettingsV1 } from '@happier-dev/protocol';

export function normalizeAcpCatalogSettingsV1(settings: unknown): AcpCatalogSettingsV1 {
    const parsed = AcpCatalogSettingsV1Schema.safeParse(settings);
    return parsed.success ? parsed.data : { v: 2, backends: [] };
}
