import type { Credentials } from '@/persistence';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/sessionControl/sessionEncryptionContext';
import { createSessionControlActionExecutor } from '@/sessionControl/createSessionControlActionExecutor';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export async function callBuiltInHappierTool(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  toolName: string;
  args: unknown;
}>): Promise<Awaited<ReturnType<typeof dispatchBuiltInHappierTool>>> {
  const rawSession = await fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId });
  if (!rawSession) {
    return { ok: false, errorCode: 'session_not_found', error: `Session not found: ${params.sessionId}` };
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
  const mode = resolveSessionStoredContentEncryptionMode(rawSession);
  const executor = createSessionControlActionExecutor({
    token: params.credentials.token,
    sessionId: params.sessionId,
    ctx,
    mode,
  });
  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'mcp' }),
  });

  return await dispatchBuiltInHappierTool({
    toolName: params.toolName,
    args: params.args,
    sessionId: params.sessionId,
    deps: {
      changeTitle: async (sessionId, title) => {
        await updateSessionMetadataWithRetry({
          token: params.credentials.token,
          credentials: params.credentials,
          sessionId,
          rawSession,
          updater: (metadata) => ({ ...metadata, summary: { text: title, updatedAt: Date.now() } }),
        });
        return { success: true, title };
      },
      startExecutionRun: async (sessionId, request) => {
        const result = await callSessionRpc({
          token: params.credentials.token,
          sessionId,
          mode,
          ctx,
          method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
          request,
        });
        return { ok: true, result };
      },
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, params.sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });
}
