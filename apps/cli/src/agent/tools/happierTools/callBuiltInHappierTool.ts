import type { StoredCredentials } from '@/persistence';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';

export async function callBuiltInHappierTool(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  toolName: string;
  args: unknown;
  surface?: 'cli' | 'agent';
  toolCallId?: string | null;
}>): Promise<Awaited<ReturnType<typeof dispatchBuiltInHappierTool>>> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
  });
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
  const sessionMetadata = rawSession.metadata && typeof rawSession.metadata === 'object' && !Array.isArray(rawSession.metadata)
    ? rawSession.metadata
    : tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
  if (surface === 'agent' && sessionMetadata === null) {
    return {
      ok: false,
      errorCode: 'session_metadata_unavailable',
      error: 'Session metadata is unavailable for Agent tool authorization',
    };
  }
  const callerPermissionMode = surface === 'agent'
    ? resolvePermissionIntentFromSessionMetadata(sessionMetadata)?.intent ?? 'default'
    : null;
  const toolCallId = surface === 'agent' && typeof params.toolCallId === 'string'
    ? params.toolCallId.trim()
    : '';
  const approvalOrigin = toolCallId
    ? {
        kind: 'transcript_tool_call' as const,
        sessionId,
        toolCallId,
        toolName: params.toolName,
      }
    : null;
  const sessionMachineId = typeof rawSession.machineId === 'string' && rawSession.machineId.trim().length > 0
    ? rawSession.machineId.trim()
    : null;
  const executor = createCliActionExecutor({
    ...sessionTarget,
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId,
    rawSession,
  });
  const actionsSettings = readActionsSettingsFromEnv();
  const daemonCatalog = await readDaemonPluginCatalog().catch(() => ({
    kind: 'unavailable' as const,
    code: 'daemon_unavailable',
  }));
  const pluginToolCatalog = daemonCatalog.kind === 'available'
    ? daemonCatalog.tools
    : Object.freeze([]);
  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface }),
    surface,
    actionsSettings,
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
    actionsSettings,
    pluginToolCatalog,
    ...(approvalOrigin ? { approvalOrigin } : {}),
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
