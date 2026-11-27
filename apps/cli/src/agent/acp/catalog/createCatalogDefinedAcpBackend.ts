import { type AgentId, getBuiltInAcpConfig, resolveAcpSessionMode } from '@happier-dev/agents';

import type { AcpBackendOptions, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { HAPPIER_SESSION_ID_ENV_KEY, withCurrentHappierSessionId } from '@/agent/runtime/session/currentSessionIdEnv';
import type { PermissionMode } from '@/api/types';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AgentBackend, AgentFactoryOptions, AgentSessionOpenOptions, McpServerConfig, SessionId, StartSessionResult } from '@/agent/core';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveAcpCatalogTransportHandler } from './transport/resolveAcpCatalogTransportHandler';

type CatalogLaunch = Readonly<{ command: string; args: readonly string[] }>;
type PreparedCatalogLaunch = Awaited<ReturnType<NonNullable<AcpBackendOptions['prepareProcessLaunch']>>> & CatalogLaunch;
type PrepareCatalogLaunch = (context: Readonly<{
  loadSessionId: string | null;
  resolveDefaultLaunch: () => CatalogLaunch;
}>) => Promise<PreparedCatalogLaunch>;

export type CatalogDefinedAcpBackendOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  happierSessionId?: string;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
  getPermissionMode?: () => PermissionMode | null | undefined;
  prepareProcessLaunch?: AcpBackendOptions['prepareProcessLaunch'];
  providerTurnSource?: AcpBackendOptions['providerTurnSource'];
  unsetEnv?: AcpBackendOptions['unsetEnv'];
  isAuthenticationSetupFailure?: AcpBackendOptions['isAuthenticationSetupFailure'];
  sessionModelAdapter?: AcpBackendOptions['sessionModelAdapter'];
  initialSessionModeId?: AcpBackendOptions['initialSessionModeId'];
  /** Provider-owned transport policy; defaults to the catalog transport profile. */
  transportHandler?: AcpBackendOptions['transportHandler'];
  launch?: CatalogLaunch | PrepareCatalogLaunch;
}>;

/**
 * Compose catalog transport policy with launch/source ownership. Every native mode write for a mapped
 * agent goes through the shared agent-mode/permission-mode resolution: after native open or resume,
 * on a mode override, and when the override is cleared.
 */
export function createCatalogDefinedAcpBackend(
  agentId: AgentId,
  options: CatalogDefinedAcpBackendOptions,
): AgentBackend {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
    throw new Error(`Agent '${agentId}' is not a built-in generic ACP agent`);
  }
  const resolveDefaultLaunch = (): CatalogLaunch => {
    const launch = requireProviderCliLaunchSpec(agentId, { processEnv: { ...process.env, ...options.env } });
    return { command: launch.command, args: [...launch.args, ...config.launcher.args] };
  };
  const prepareLaunch = typeof options.launch === 'function' ? options.launch : undefined;
  const launch = typeof options.launch === 'function' ? undefined : options.launch ?? resolveDefaultLaunch();

  const env = { ...options.env, NODE_ENV: 'production', DEBUG: '' };
  const backend: AgentBackend = createAcpBackend({
    agentName: agentId,
    cwd: options.cwd,
    command: launch?.command,
    args: launch ? [...launch.args] : undefined,
    env: options.happierSessionId !== undefined
      ? withCurrentHappierSessionId(env, options.happierSessionId)
      : env,
    prepareProcessLaunch: prepareLaunch
      ? (context) => prepareLaunch({ ...context, resolveDefaultLaunch })
      : options.prepareProcessLaunch,
    unsetEnv: options.happierSessionId !== undefined
      ? [...(options.unsetEnv ?? []), HAPPIER_SESSION_ID_ENV_KEY]
      : options.unsetEnv,
    isAuthenticationSetupFailure: options.isAuthenticationSetupFailure,
    sessionModelAdapter: options.sessionModelAdapter,
    sessionModesEnabled: config.supportsModes !== 'no',
    initialSessionModeId: options.initialSessionModeId,
    mcpServers: config.mcpServers === 'drop' ? undefined : options.mcpServers,
    permissionHandler: options.permissionHandler,
    formElicitation: config.formElicitation === true,
    permissionMode: options.permissionMode,
    getPermissionMode: options.getPermissionMode,
    providerTurnSource: options.providerTurnSource,
    transportHandler: options.transportHandler ?? resolveAcpCatalogTransportHandler(config.transportProfile, agentId),
    declaredSessionLoadSupport: config.supportsLoadSession,
  });

  if (!config.permissionModeMapping) return backend;

  const configurable = backend as AgentBackend & {
    setSessionMode?: (sessionId: SessionId, modeId: string) => Promise<void>;
    clearSessionModeOverride?: (sessionId: SessionId) => Promise<void>;
    getSessionModeState?: () => { availableModes: ReadonlyArray<{ id: string }> } | null;
  };
  if (typeof configurable.setSessionMode !== 'function') return backend;

  const setNativeSessionMode = configurable.setSessionMode.bind(backend);
  const applySessionMode = async (sessionId: SessionId, agentModeId: string | null): Promise<void> => {
    const permissionMode = options.getPermissionMode?.() ?? options.permissionMode ?? 'default';
    const resolution = resolveAcpSessionMode({
      agentId,
      agentModeId,
      permissionMode,
      availableModes: configurable.getSessionModeState?.()?.availableModes ?? [],
    });
    // Provider policy delegates to the agent; it does not imply a native reset token.
    if (resolution.kind === 'provider-policy') return;
    if (resolution.kind === 'unavailable') {
      throw new Error(`Agent '${agentId}' has no advertised permission mode for '${permissionMode}'`);
    }
    await setNativeSessionMode(sessionId, resolution.modeId);
  };
  const applyPermissionMode = (sessionId: SessionId): Promise<void> => applySessionMode(sessionId, null);
  configurable.setSessionMode = applySessionMode;
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
