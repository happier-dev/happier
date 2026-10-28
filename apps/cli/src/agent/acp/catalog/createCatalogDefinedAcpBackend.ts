import { type AgentId, getBuiltInAcpConfig, resolveAcpPermissionModeId } from '@happier-dev/agents';

import type { AcpBackendOptions, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { HAPPIER_SESSION_ID_ENV_KEY, withCurrentHappierSessionId } from '@/agent/runtime/session/currentSessionIdEnv';
import type { PermissionMode } from '@/api/types';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AgentBackend, AgentFactoryOptions, AgentSessionOpenOptions, McpServerConfig, SessionId, StartSessionResult } from '@/agent/core';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveAcpCatalogTransportHandler } from './transport/resolveAcpCatalogTransportHandler';

export type CatalogDefinedAcpBackendOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  happierSessionId?: string;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
  getPermissionMode?: () => PermissionMode | null | undefined;
  prepareProcessLaunch?: AcpBackendOptions['prepareProcessLaunch'];
  unsetEnv?: AcpBackendOptions['unsetEnv'];
  isAuthenticationSetupFailure?: AcpBackendOptions['isAuthenticationSetupFailure'];
  sessionModelAdapter?: AcpBackendOptions['sessionModelAdapter'];
  launch?: Readonly<{ command: string; args: readonly string[] }>;
}>;

export function createCatalogDefinedAcpBackend(
  agentId: AgentId,
  options: CatalogDefinedAcpBackendOptions,
): AgentBackend {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
    throw new Error(`Agent '${agentId}' is not a built-in generic ACP agent`);
  }
  const launch = options.launch
    ?? requireProviderCliLaunchSpec(agentId, { processEnv: { ...process.env, ...options.env } });

  const env = { ...options.env, NODE_ENV: 'production', DEBUG: '' };
  const backend: AgentBackend = createAcpBackend({
    agentName: agentId,
    cwd: options.cwd,
    command: launch.command,
    args: options.launch ? [...launch.args] : [...launch.args, ...config.launcher.args],
    env: options.happierSessionId !== undefined
      ? withCurrentHappierSessionId(env, options.happierSessionId)
      : env,
    prepareProcessLaunch: options.prepareProcessLaunch,
    unsetEnv: options.happierSessionId !== undefined
      ? [...(options.unsetEnv ?? []), HAPPIER_SESSION_ID_ENV_KEY]
      : options.unsetEnv,
    isAuthenticationSetupFailure: options.isAuthenticationSetupFailure,
    sessionModelAdapter: options.sessionModelAdapter,
    sessionModesEnabled: config.supportsModes !== 'no',
    mcpServers: config.mcpServers === 'drop' ? undefined : options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(config.transportProfile),
    declaredSessionLoadSupport: config.supportsLoadSession,
  });

  if (!config.permissionModeMapping) return backend;

  const configurable = backend as AgentBackend & {
    setSessionMode?: (sessionId: SessionId, modeId: string) => Promise<void>;
    clearSessionModeOverride?: (sessionId: SessionId) => Promise<void>;
    getSessionModeState?: () => { availableModes: ReadonlyArray<{ id: string }> } | null;
  };
  if (typeof configurable.setSessionMode !== 'function') return backend;

  const applyPermissionMode = async (sessionId: SessionId): Promise<void> => {
    const permissionMode = options.getPermissionMode?.() ?? options.permissionMode ?? 'default';
    const mapping = config.permissionModeMapping?.[permissionMode] ?? null;
    // A null mapping delegates to provider policy; it does not imply a native reset token.
    if (mapping === null) return;
    const availableModes = configurable.getSessionModeState?.()?.availableModes ?? [];
    const sessionModeId = resolveAcpPermissionModeId(mapping, availableModes);
    if (!sessionModeId) {
      throw new Error(`Agent '${agentId}' has no advertised permission mode for '${permissionMode}'`);
    }
    await configurable.setSessionMode?.(sessionId, sessionModeId);
  };
  configurable.clearSessionModeOverride = applyPermissionMode;

  const applyMode = async (result: StartSessionResult): Promise<StartSessionResult> => {
    await applyPermissionMode(result.sessionId);
    return result;
  };

  const startSession = backend.startSession.bind(backend);
  configurable.startSession = async (
    initialPrompt?: string,
    openOptions?: AgentSessionOpenOptions,
  ): Promise<StartSessionResult> => applyMode(await startSession(initialPrompt, openOptions));

  if (typeof backend.loadSession === 'function') {
    const loadSession = backend.loadSession.bind(backend);
    configurable.loadSession = async (
      sessionId: SessionId,
      openOptions?: AgentSessionOpenOptions,
    ): Promise<StartSessionResult> => applyMode(await loadSession(sessionId, openOptions));
  }

  // ACP replay capture delegates to this same wrapped loadSession. Applying the
  // mode again around capture would send a second provider configuration write.

  return backend;
}
