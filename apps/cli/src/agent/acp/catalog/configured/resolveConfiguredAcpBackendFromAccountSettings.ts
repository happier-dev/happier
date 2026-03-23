import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  AcpCatalogTransportProfileV1,
  McpValueRefV1,
} from '@happier-dev/protocol';

import { readAcpCatalogSettingsFromAccountSettings } from '../readAcpCatalogSettingsFromAccountSettings';

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  name: string;
  title: string;
  description?: string;
  command: string;
  args: ReadonlyArray<string>;
  env: Readonly<Record<string, McpValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  transportProfile: AcpCatalogTransportProfileV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
}>;

export function resolveConfiguredAcpBackendFromAccountSettings(
  settings: Readonly<Record<string, unknown>>,
  backendId: string,
): ResolvedConfiguredAcpBackend | null {
  const acpCatalog = readAcpCatalogSettingsFromAccountSettings(settings);
  const backend = acpCatalog.backends.find((entry) => entry.id === backendId) ?? null;
  if (!backend) return null;
  const backendRecord = backend as Record<string, unknown>;
  const defaultMode = typeof backendRecord.defaultMode === 'string' ? backendRecord.defaultMode : undefined;
  const defaultModel = typeof backendRecord.defaultModel === 'string' ? backendRecord.defaultModel : undefined;

  return {
    backendId: backend.id,
    name: backend.name,
    title: backend.title,
    description: backend.description,
    command: backend.command,
    args: [...backend.args],
    env: { ...backend.env },
    auth: backend.auth,
    transportProfile: backend.transportProfile,
    capabilities: backend.capabilities,
    defaultMode,
    defaultModel,
  };
}
