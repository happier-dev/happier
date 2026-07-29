import type { Credentials } from '@/persistence';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';

export async function callBuiltInHappierTool(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  toolName: string;
  args: unknown;
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
    return {
      ok: false,
      errorCode: sessionTarget.code,
      error: sessionTarget.code === 'unsupported'
        ? `Session transport unsupported for: ${params.sessionId}`
        : `Session not found: ${params.sessionId}`,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }
  const { rawSession, ctx, mode, sessionId } = sessionTarget;
  const executor = createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId,
    ctx,
    mode,
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
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'cli' }),
    surface: 'cli',
    actionsSettings,
    pluginToolCatalog,
  });

  return await dispatchBuiltInHappierTool({
    toolName: params.toolName,
    args: params.args,
    sessionId,
    surface: 'cli',
    actionsSettings,
    pluginToolCatalog,
    deps: {
      changeTitle: createChangeTitleToolHandler({ executor, surface: 'cli' }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });
}
