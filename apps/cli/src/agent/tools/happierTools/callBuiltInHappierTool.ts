import type { Credentials } from '@/persistence';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';
import { normalizeExecutionRunToolResult } from './normalizeExecutionRunToolResult';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { startExecutionRun } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export async function callBuiltInHappierTool(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  toolName: string;
  args: unknown;
  invocation?: 'cli' | 'session_agent_bridge';
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
  const { rawSession, ctx, mode, sessionId } = sessionTarget;
  const surface = params.invocation === 'session_agent_bridge' ? 'session_agent' : 'cli';
  const defaultSessionMachineId = typeof rawSession.machineId === 'string' && rawSession.machineId.trim()
    ? rawSession.machineId.trim()
    : null;
  const actionsSettings = readActionsSettingsFromEnv();
  const executor = createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId,
    ctx,
    mode,
    rawSession,
  });
  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface }),
    surface,
    actionsSettings,
    defaultSessionMachineId,
  });

  return await dispatchBuiltInHappierTool({
    toolName: params.toolName,
    args: params.args,
    sessionId,
    surface,
    actionsSettings,
    deps: {
      changeTitle: createChangeTitleToolHandler({ executor, surface }),
      startExecutionRun: async (sessionId, request) => {
        const result = await startExecutionRun({
          token: params.credentials.token,
          sessionId,
          mode,
          ctx,
          request,
        });
        return normalizeExecutionRunToolResult(result);
      },
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });
}
