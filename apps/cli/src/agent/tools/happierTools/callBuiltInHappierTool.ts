import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveMcpToolCallRequestTimeoutMs } from '@/mcp/mcpToolCallRequestOptions';
import { configuration } from '@/configuration';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

function normalizeNativeAgentToolResponse(value: unknown): Awaited<ReturnType<typeof dispatchBuiltInHappierTool>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
  }
  const response = value as Readonly<Record<string, unknown>>;
  if (response.ok === true && Object.prototype.hasOwnProperty.call(response, 'result')) {
    return { ok: true, result: response.result };
  }
  if (response.ok === false && typeof response.errorCode === 'string' && typeof response.error === 'string') {
    return {
      ok: false,
      errorCode: response.errorCode,
      error: response.error,
      ...(Object.prototype.hasOwnProperty.call(response, 'details') ? { details: response.details } : {}),
    };
  }
  return { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
}

export async function callBuiltInHappierTool(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  toolName: string;
  args: unknown;
  surface?: 'cli' | 'agent';
  toolCallId?: string | null;
  /** Live credential reader for the one-shot CLI fence; omitted callers retain their existing fixed snapshot. */
  readCredentials?: () => Promise<StoredCredentials | null>;
}>): Promise<Awaited<ReturnType<typeof dispatchBuiltInHappierTool>>> {
  const credentialSnapshot = params.readCredentials
    ? await params.readCredentials().catch(() => null)
    : params.credentials;
  if (!credentialSnapshot || !sameStoredCredentials(params.credentials, credentialSnapshot)) {
    return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
  }
  const sessionTarget = await resolveSessionTransportContext({
    credentials: credentialSnapshot,
    idOrPrefix: params.sessionId,
  });
  if (params.readCredentials) {
    const currentCredentials = await params.readCredentials().catch(() => null);
    if (!sameStoredCredentials(credentialSnapshot, currentCredentials)) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
  }
  if (!sessionTarget.ok) {
    if (sessionTarget.code === 'session_id_ambiguous') {
      return {
        ok: false,
        errorCode: sessionTarget.code,
        error: 'Session id is ambiguous',
        ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
      };
    }
    if (sessionTarget.code === 'session_lookup_timeout') {
      return {
        ok: false,
        errorCode: sessionTarget.code,
        error: 'Session lookup timed out; try again',
      };
    }
    return {
      ok: false,
      errorCode: sessionTarget.code,
      error: sessionTarget.code === 'unsupported'
        ? `Session transport unsupported for: ${params.sessionId}`
        : `Session not found: ${params.sessionId}`,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }
  const { rawSession, sessionId } = sessionTarget;
  const surface = params.surface ?? 'cli';
  if (surface === 'agent') {
    const request = {
      token: credentialSnapshot.token,
      sessionId,
      method: SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
      request: {
        toolName: params.toolName,
        args: params.args,
        ...(typeof params.toolCallId === 'string' && params.toolCallId.trim().length > 0
          ? { toolCallId: params.toolCallId.trim() }
          : {}),
      },
      timeoutMs: resolveMcpToolCallRequestTimeoutMs({
        toolName: params.toolName,
        args: params.args,
      }),
    };
    const response = await callSessionRpc(sessionTarget.mode === 'plain'
      ? { ...request, mode: 'plain', ctx: null }
      : { ...request, mode: 'e2ee', ctx: sessionTarget.ctx });
    return normalizeNativeAgentToolResponse(response);
  }
  const callerPermissionMode = null;
  const sessionMachineId = typeof rawSession.machineId === 'string' && rawSession.machineId.trim().length > 0
    ? rawSession.machineId.trim()
    : null;
  await ensureCliActionPolicySettings(credentialSnapshot);
  if (params.readCredentials) {
    const currentCredentials = await params.readCredentials().catch(() => null);
    if (!sameStoredCredentials(credentialSnapshot, currentCredentials)) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
  }
  const actionsSettingsProvider = createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(credentialSnapshot.token),
  });
  const isActionEnabled = (id: Parameters<typeof isActionEnabledByActionsSettings>[0]) =>
    isActionEnabledByActionsSettings(id, actionsSettingsProvider.getActionsSettings(), { surface });
  const executor = createCliActionExecutorFromCredentials({
    credentials: credentialSnapshot,
    actionsSettingsProvider,
    serverId: configuration.activeServerId,
    serverApiUrl: configuration.apiServerUrl,
    ...(params.readCredentials
      ? {
          readCredentials: async () => {
            const currentCredentials = await params.readCredentials!().catch(() => null);
            return sameStoredCredentials(credentialSnapshot, currentCredentials)
              ? currentCredentials
              : null;
          },
        }
      : {}),
    ...(sessionMachineId ? { machineId: sessionMachineId } : {}),
  });
  const daemonCatalog = await readDaemonPluginCatalog().catch(() => ({
    kind: 'unavailable' as const,
    code: 'daemon_unavailable',
  }));
  const pluginToolCatalog = daemonCatalog.kind === 'available'
    ? daemonCatalog.tools
    : Object.freeze([]);
  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled,
    surface,
    getActionsSettings: actionsSettingsProvider.getActionsSettings,
    pluginToolCatalog,
    resolveCallerPermissionMode: () => callerPermissionMode,
    defaultSessionMachineId: sessionMachineId,
  });

  return await dispatchBuiltInHappierTool({
    toolName: params.toolName,
    args: params.args,
    sessionId,
    sessionMachineId,
    surface,
    getActionsSettings: actionsSettingsProvider.getActionsSettings,
    pluginToolCatalog,
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface,
        resolveCallerPermissionMode: () => callerPermissionMode,
      }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });
}
