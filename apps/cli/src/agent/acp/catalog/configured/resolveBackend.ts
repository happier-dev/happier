import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  McpValueRefV1,
} from '@happier-dev/protocol';

import { readAcpCatalogSettingsFromAccountSettings } from '../readAcpCatalogSettingsFromAccountSettings';

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  source: Readonly<{ kind: 'account_configured' }>;
  name: string;
  title: string;
  description?: string;
  command: string;
  args: ReadonlyArray<string>;
  env: Readonly<Record<string, McpValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
}>;

type AccountSettingsConfiguredAcpBackend = ReturnType<typeof readAcpCatalogSettingsFromAccountSettings>['backends'][number];

function materializeConfiguredAcpBackendFromAccountSettingsEntry(
  backend: AccountSettingsConfiguredAcpBackend,
): ResolvedConfiguredAcpBackend {
  const backendRecord = backend as Record<string, unknown>;
  const defaultMode = typeof backendRecord.defaultMode === 'string' ? backendRecord.defaultMode : undefined;
  const defaultModel = typeof backendRecord.defaultModel === 'string' ? backendRecord.defaultModel : undefined;

  return {
    backendId: backend.id,
    source: { kind: 'account_configured' },
    name: backend.name,
    title: backend.title,
    description: backend.description,
    command: backend.command,
    args: [...backend.args],
    env: { ...backend.env },
    auth: backend.auth,
    capabilities: backend.capabilities,
    defaultMode,
    defaultModel,
  };
}

export function resolveConfiguredAcpBackendFromAccountSettings(
  settings: Readonly<Record<string, unknown>>,
  backendId: string,
): ResolvedConfiguredAcpBackend | null {
  const acpCatalog = readAcpCatalogSettingsFromAccountSettings(settings);
  const backend = acpCatalog.backends.find((entry) => entry.id === backendId) ?? null;
  return backend ? materializeConfiguredAcpBackendFromAccountSettingsEntry(backend) : null;
}

export async function listConfiguredAcpBackendsFromAccountSettings(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
}>): Promise<ReadonlyArray<ResolvedConfiguredAcpBackend>> {
  return readAcpCatalogSettingsFromAccountSettings(params.settings)
    .backends
    .map((backend) => materializeConfiguredAcpBackendFromAccountSettingsEntry(backend));
}
