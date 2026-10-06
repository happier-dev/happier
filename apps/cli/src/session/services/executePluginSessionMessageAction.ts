import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginSessionInputRequestV1Schema, SessionInputAdmissionResultV1Schema, derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ActionExecuteResult, ActionExecutorContext, PluginMachineMaterializationRefV1, PluginSourceCustodyV1, SessionInputAdmissionResultV1 } from '@happier-dev/protocol';

import { resolvePluginActionCaller } from '@/plugins/runtime/invocation/services/actionCaller';
import { PluginError } from '@happier-dev/plugin-sdk';

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
  /** Exact host-stamped process-local occurrence; never accepted from plugin input. */
  occurrenceId: string;
  /** Exact durable source custody; never accepted from plugin input. */
  sourceCustody: PluginSourceCustodyV1;
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
  const actionCaller = resolvePluginActionCaller({
    plugin: { id: pluginId.data },
    contribution: { id: contributionLocalId.data },
    occurrenceId: params.occurrenceId,
    sourceCustody: params.sourceCustody,
    ...(params.resolveCallerMaterialization
      ? { resolveCurrentPluginMaterializationRef: params.resolveCallerMaterialization }
      : {}),
  });
  if (!actionCaller) {
    return { status: 'rejected', code: 'session_input_untrusted_assertion' };
  }
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
            ...(request.data.recipient ? { recipient: request.data.recipient } : {}),
            ...(request.data.source ? { source: request.data.source } : {}),
            ...(request.data.attachments ? { attachments: request.data.attachments } : {}),
            ...(request.data.toolAnswerDelivery ? { toolAnswerDelivery: request.data.toolAnswerDelivery } : {}),
          },
      {
        surface: 'plugin',
        authority: 'account_automation',
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
    if (result.errorCode === 'machine_admission_transport_unavailable') {
      throw new PluginError({ code: result.errorCode, message: result.error, retryable: true });
    }
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
