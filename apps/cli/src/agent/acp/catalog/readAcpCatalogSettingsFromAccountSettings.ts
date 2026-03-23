/**
 * ACP catalog settings access (account settings)
 *
 * Reads the server-synced ACP catalog settings blob from the account settings object.
 * Invalid payloads are treated as empty settings (fail-closed on config).
 */

import { AcpCatalogSettingsV1Schema, type AcpCatalogSettingsV1 } from '@happier-dev/protocol';

function emptySettings(): AcpCatalogSettingsV1 {
  return AcpCatalogSettingsV1Schema.parse({});
}

export function readAcpCatalogSettingsFromAccountSettings(settings: Readonly<Record<string, unknown>>): AcpCatalogSettingsV1 {
  const raw = (settings as any)?.acpCatalogSettingsV1;
  if (!raw) return emptySettings();
  const parsed = AcpCatalogSettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : emptySettings();
}
