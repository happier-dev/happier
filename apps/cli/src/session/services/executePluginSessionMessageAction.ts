import {
  PluginContributionLocalIdSchema,
  PluginIdSchema,
  PluginMachineMaterializationRefV1Schema,
  PluginSessionInputRequestV1Schema,
  SessionInputAdmissionResultV1Schema,
  derivePluginSessionInputLocalIdV1,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type PluginMachineMaterializationRefV1,
  type SessionInputAdmissionResultV1,
} from '@happier-dev/protocol';

type SessionMessageActionExecutor = (
  actionId: 'session.message.send',
  input: unknown,
  context: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

/** Canonical SessionHandle.send -> Action adapter. It owns no writer or identity. */
export async function executePluginSessionMessageAction(params: Readonly<{
  execute: SessionMessageActionExecutor;
  pluginId: string;
  contributionLocalId: string;
  /**
   * The runtime-owned registry callback is read at dispatch time. A plugin
   * session handle must never recreate this authority from its plugin id.
   */
  resolveCallerMaterialization?(): PluginMachineMaterializationRefV1 | null;
  sessionId: string;
  /** Public SDK input is validated and narrowed at this host boundary. */
  request: unknown;
  signal: AbortSignal;
}>): Promise<SessionInputAdmissionResultV1> {
  const request = PluginSessionInputRequestV1Schema.safeParse(params.request);
  if (!request.success) return { status: 'rejected', code: 'session_input_invalid' };
  const pluginId = PluginIdSchema.safeParse(params.pluginId);
  const contributionLocalId = PluginContributionLocalIdSchema.safeParse(params.contributionLocalId);
  if (!pluginId.success || !contributionLocalId.success) {
    return { status: 'rejected', code: 'session_input_untrusted_assertion' };
  }
  let rawMaterialization: PluginMachineMaterializationRefV1 | null | undefined;
  try {
    rawMaterialization = params.resolveCallerMaterialization?.();
  } catch {
    return { status: 'rejected', code: 'session_input_untrusted_assertion' };
  }
  const materialization = PluginMachineMaterializationRefV1Schema.safeParse(rawMaterialization);
  if (!materialization.success || materialization.data.pluginId !== pluginId.data) {
    return { status: 'rejected', code: 'session_input_untrusted_assertion' };
  }
  const actionCaller = {
    kind: 'plugin' as const,
    pluginId: pluginId.data,
    contributionLocalId: contributionLocalId.data,
    materialization: materialization.data,
  };
  const localId = derivePluginSessionInputLocalIdV1({
    caller: actionCaller,
    sessionId: params.sessionId,
    idempotencyKey: request.data.idempotencyKey,
  });
  let result: ActionExecuteResult;
  try {
    result = await params.execute(
      'session.message.send',
      request.data.kind === 'sessionSubagentLaunch'
        ? {
            sessionId: params.sessionId,
            kind: request.data.kind,
            launch: request.data.launch,
            idempotencyKey: request.data.idempotencyKey,
          }
        : {
            sessionId: params.sessionId,
            message: request.data.text,
            idempotencyKey: request.data.idempotencyKey,
            ...(request.data.source ? { source: request.data.source } : {}),
            ...(request.data.attachments ? { attachments: request.data.attachments } : {}),
          },
      {
        surface: 'plugin',
        actionCaller,
        signal: params.signal,
      },
    );
  } catch {
    return {
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_action_execution_failed',
    };
  }
  if (!result.ok) {
    return {
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_action_execution_failed',
    };
  }
  const parsed = SessionInputAdmissionResultV1Schema.safeParse(result.result);
  return parsed.success
    ? parsed.data
    : {
        status: 'outcomeUnknown',
        localId,
        code: 'session_input_admission_result_malformed',
      };
}
