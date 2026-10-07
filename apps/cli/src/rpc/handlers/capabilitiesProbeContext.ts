import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENTS } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { readStoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AgentId } from '@happier-dev/agents';
import { getAgentModelConfig } from '@happier-dev/agents';
import { BackendTargetRefSchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { normalizeBackendTargetRefV2InputToV1 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, RuntimeDescriptorV1 } from '@happier-dev/protocol';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';

export async function resolveProbeBackendContext(
  params?: Record<string, unknown>,
  options: Readonly<{ requireCredentials?: boolean; catalogEntry?: AgentCatalogEntry | null; signal?: AbortSignal }> = {},
): Promise<{
  backendTarget: BackendTargetRefV1 | undefined;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
  credentials: Awaited<ReturnType<typeof readStoredCredentials>> | null;
  accountSettings: Record<string, unknown> | null;
  pluginSettings?: AgentCliSessionCommandPluginSettingsV1;
}> {
  const parsedBackendTarget = BackendTargetRefSchema.safeParse(normalizeBackendTargetRefV2InputToV1(params?.backendTarget));
  const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;
  const agentId = typeof params?.agentId === 'string' ? params.agentId : null;
  const runtimeDescriptorV1 = params?.runtimeDescriptorV1 == null
    ? undefined : RuntimeDescriptorV1Schema.parse(params.runtimeDescriptorV1);
  if (runtimeDescriptorV1 && runtimeDescriptorV1.agentId !== agentId) {
    throw new TypeError('Probe runtime descriptor belongs to another Agent');
  }
  const runtimeContext = {
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    // cli-v0.2.12 and the moving 0.2 predecessor send this Agent-owned scalar.
    // Preserve it at the seam; only the Agent interprets it, without rewriting settings.
    ...(typeof params?.runtimeKindOverride === 'string' ? { runtimeKindOverride: params.runtimeKindOverride } : {}),
  };
  const hasSelectedProfile = typeof params?.profileId === 'string' && params.profileId.trim().length > 0;
  const catalogEntry = options.catalogEntry === undefined
    ? (agentId ? AGENTS[agentId] : undefined)
    : options.catalogEntry;
  options.signal?.throwIfAborted();
  const pluginSettings = await catalogEntry?.resolveProbePluginSettings?.({ signal: options.signal });
  options.signal?.throwIfAborted();
  Object.assign(runtimeContext, pluginSettings == null ? {} : { pluginSettings });
  const needsAccountSettingsForProbes =
    agentId && (
      catalogEntry?.needsAccountSettingsForProbes === true
      || getAgentModelConfig(agentId as AgentId)?.dynamicProbeControl !== undefined
    );
  const shouldLoadAccountSettings = backendTarget?.kind === 'configuredAcpBackend'
    || needsAccountSettingsForProbes
    || hasSelectedProfile;
  if (!shouldLoadAccountSettings && options.requireCredentials !== true) {
    return { ...runtimeContext, backendTarget, credentials: null, accountSettings: null };
  }

  const credentials = await readStoredCredentials().catch(() => null);
  if (!credentials) return { ...runtimeContext, backendTarget, credentials: null, accountSettings: null };

  if (!shouldLoadAccountSettings) {
    return { ...runtimeContext, backendTarget, credentials, accountSettings: null };
  }

  const accountSettingsContext = await bootstrapAccountSettingsContext({
    credentials,
    ...(params?.agentId ? { agentId: params.agentId as AgentId } : {}),
    backendTarget,
    mode: 'blocking',
    refresh: 'auto',
  }).catch(() => null);

  return {
    ...runtimeContext,
    backendTarget,
    credentials,
    accountSettings: accountSettingsContext?.settings ?? null,
  };
}
