import type { BackendTargetRefV1, McpValueRefV1 } from '@happier-dev/protocol';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { createConfiguredAcpBackend } from '@/agent/acp/catalog/configured/createConfiguredAcpBackend';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';

import { isConfiguredAcpProbeTarget } from './isConfiguredAcpProbeTarget';

function tryResolveLiteralConfiguredAcpEnvironment(
  env: Readonly<Record<string, McpValueRefV1>>,
): Record<string, string> | null {
  const launchEnv: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(env)) {
    if (valueRef.t !== 'literal') {
      return null;
    }
    launchEnv[envKey] = valueRef.v;
  }
  return launchEnv;
}

const abortingPermissionHandler: AcpPermissionHandler = {
  handleToolCall: async () => ({ decision: 'abort' }),
};

export async function createConfiguredAcpProbeBackend(params: Readonly<{
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials | null;
}>): Promise<AcpProbeBackend | null> {
  if (!isConfiguredAcpProbeTarget(params)) return null;

  const backend = resolveConfiguredAcpBackendFromAccountSettings(
    params.accountSettings ?? {},
    params.backendTarget.backendId,
  );
  if (!backend) return null;

  let launchEnv = tryResolveLiteralConfiguredAcpEnvironment(backend.env);
  if (launchEnv === null) {
    if (!params.accountSettings || !params.credentials) return null;
    launchEnv = materializeConfiguredAcpEnvironment({
      backend,
      accountSettings: params.accountSettings,
      credentials: params.credentials,
    });
  }

  return createConfiguredAcpBackend({
    cwd: params.cwd,
    backend,
    launchEnv,
    mcpServers: {},
    permissionHandler: abortingPermissionHandler,
  });
}
