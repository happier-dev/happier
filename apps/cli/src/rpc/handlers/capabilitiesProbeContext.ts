import { AGENTS } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { readStoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AgentId } from '@happier-dev/agents';
import { applyAgentRuntimeKindOverrideToAccountSettings } from '@happier-dev/agents';
import { BackendTargetRefSchema, type BackendTargetRefV1 } from '@happier-dev/protocol';

export async function resolveProbeBackendContext(
  params?: Record<string, unknown>,
  options: Readonly<{ requireCredentials?: boolean }> = {},
): Promise<{
  backendTarget: BackendTargetRefV1 | undefined;
  credentials: Awaited<ReturnType<typeof readStoredCredentials>> | null;
  accountSettings: Record<string, unknown> | null;
}> {
  const parsedBackendTarget = BackendTargetRefSchema.safeParse((params ?? {}).backendTarget);
  const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;
  const runtimeKindOverride = (params ?? {}).runtimeKindOverride;

  const agentId = typeof params?.agentId === 'string' ? params.agentId : null;
  const needsAccountSettingsForProbes =
    agentId && (AGENTS[agentId as keyof typeof AGENTS] as AgentCatalogEntry | undefined)?.needsAccountSettingsForProbes === true;
  const shouldLoadAccountSettings = backendTarget?.kind === 'configuredAcpBackend' || needsAccountSettingsForProbes;
  if (!shouldLoadAccountSettings && options.requireCredentials !== true) {
    return { backendTarget, credentials: null, accountSettings: null };
  }

  const credentials = await readStoredCredentials().catch(() => null);
  if (!credentials) return { backendTarget, credentials: null, accountSettings: null };

  if (!shouldLoadAccountSettings) {
    return { backendTarget, credentials, accountSettings: null };
  }

  const accountSettingsContext = await bootstrapAccountSettingsContext({
    credentials,
    ...(params?.agentId ? { agentId: params.agentId as AgentId } : {}),
    backendTarget,
    mode: 'blocking',
    refresh: 'auto',
  }).catch(() => null);

  const accountSettings = accountSettingsContext?.settings ?? null;
  const effectiveAccountSettings = params?.agentId
    ? applyAgentRuntimeKindOverrideToAccountSettings({
      agentId: params.agentId as AgentId,
      accountSettings,
      runtimeKindOverride,
    })
    : accountSettings;

  return {
    backendTarget,
    credentials,
    accountSettings: effectiveAccountSettings,
  };
}
