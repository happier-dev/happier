import { SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS } from '../../sessionAgentTransitionActionFamily.js';
import { SessionAgentTransitionRequestV1Schema } from '../../../sessions/agentTransition.js';
import { resolveSessionIdFromInput, resolveServerIdForSession } from '../sessionScope.js';
import { completeActionResult } from '../resultProjection.js';
import { PluginSessionInputAttachmentsV1Schema, PluginSessionInputSourceV1Schema, PluginSessionUserTextAuthoredFieldSchemasV1, derivePluginSessionInputLocalIdV1 } from '../../../sessions/messages/sessionInputAdmission.js';
import { resolveSubagentLaunchStructuredSend } from '../../../messages/structured/subagentLaunchV1.js';
import { resolveSubagentCommandStructuredSend } from '../../../messages/structured/subagentCommandV1.js';
import { PendingRequestedActionV1Schema } from '../../../sessions/pending/pendingRequestedActionV1.js';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, RawIngressStructuredInputV1Schema } from '../../../runtime/input/structuredInputV1.js';
import { SCM_WALKTHROUGH_QUESTION_META_KEY_V1, SESSION_TOOL_ANSWER_DELIVERY_KIND } from '../../../sessions/messages/sessionMessageMeta.js';
import { SessionSendMessageInputSchema } from '../../actionSpecs.js';
import { ParticipantRecipientRoutingIdentityV1Schema } from '../../../messages/structured/participantMessageV1.js';
import { ProviderConnectionIdSchema } from '../../../providers/ids.js';
import { SessionMessageExplicitReplyV1Schema } from '../../../sessions/messages/sessionMessageReplyV1.js';
import { AutonomousExchangeControlRequestV1Schema } from '../../../sessions/messages/autonomousExchangeV1.js';
import type { ActionExecutorContext } from '../types.js';
import { PendingLocalIdSchema } from '../../../sessions/pending/pendingLocalId.js';
import { readNonEmptyString } from '../../../inputs/inputRecords.js';
import type { DispatchFacts } from '../coreInvocation.js';
import type { SessionMessageSendAdmission } from '../callerContext.js';
import type { CoreInvocation, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorDeps } from '../types.js';

function resolveSessionMessageSendLocalId(
  data: Readonly<Record<string, unknown>>,
  ctx: ActionExecutorContext,
): string | null {
  const explicitLocalId = PendingLocalIdSchema.safeParse(data.localId);
  if (explicitLocalId.success) return explicitLocalId.data;
  const actionRequestId = readNonEmptyString(ctx.actionRequestId);
  return actionRequestId
    ? PendingLocalIdSchema.parse(`action-request:${actionRequestId}`)
    : null;
}

export async function dispatchSessionMessages(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx' | 'data'> & Readonly<{
  sessionMessageSendAdmission: Extract<SessionMessageSendAdmission, { ok: true }>;
  dispatchFacts: DispatchFacts;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, sessionMessageSendAdmission, data, dispatchFacts } = inv;
        if (actionId === 'session.agent.transition') {
          if (!deps.sessionAgentTransition) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const input = SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS[actionId].parse(parsed.data);
          const request = SessionAgentTransitionRequestV1Schema.parse({ v: 1, ...input });
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          return completeActionResult(await deps.sessionAgentTransition({ request, context: ctx,
            ...(serverId ? { serverId } : {}),
            ...(sessionMessageSendAdmission.sessionInputSource ? { sessionInputSource: sessionMessageSendAdmission.sessionInputSource } : {}),
          }));
        }
        if (actionId === 'session.message.send') {
          if (!deps.sessionSendMessage) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const actionCaller = ctx.actionCaller ?? { kind: 'host' as const };
          if (data.kind === 'sessionSubagentLaunch' && actionCaller.kind !== 'plugin') {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          // Mediated external source authority is a plugin-mediator fact: it
          // names the mediator, its external revision, and the ceiling that
          // input may request. Only a plugin caller can be held to it, and the
          // Agent/MCP cross-Session path derives its own source authority from
          // the host-stamped active turn instead. A generic caller supplying
          // the field is refused rather than silently stripped, so a permission
          // ceiling is never quietly dropped from an accepted send.
          const parsedSource = data.source === undefined
            ? undefined
            : PluginSessionInputSourceV1Schema.safeParse(data.source);
          if (parsedSource && (actionCaller.kind !== 'plugin' || !parsedSource.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          // Only a plugin caller owns a declared Composer attachment the host
          // can qualify. A generic caller supplying the field is refused rather
          // than silently stripped, so a mis-routed send never delivers its
          // text with the entry context quietly dropped.
          const parsedAttachments = Object.prototype.hasOwnProperty.call(data, 'attachments')
            ? PluginSessionInputAttachmentsV1Schema.safeParse(data.attachments)
            : null;
          if (parsedAttachments && (actionCaller.kind !== 'plugin' || !parsedAttachments.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const parsedToolAnswerDelivery = data.toolAnswerDelivery === undefined
            ? null
            : PluginSessionUserTextAuthoredFieldSchemasV1.toolAnswerDelivery.safeParse(data.toolAnswerDelivery);
          if (parsedToolAnswerDelivery && (actionCaller.kind !== 'plugin' || !parsedToolAnswerDelivery.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          if (
            actionCaller.kind === 'plugin'
            && (
              typeof actionCaller.contributionLocalId !== 'string'
              || actionCaller.contributionLocalId.length === 0
              || typeof data.idempotencyKey !== 'string'
            )
          ) {
            return {
              ok: false,
              errorCode: 'plugin_action_caller_required',
              error: 'plugin_action_caller_required',
            };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const modelOverrideRaw = Object.prototype.hasOwnProperty.call(data, 'modelOverride')
            ? data.modelOverride
            : undefined;
          const providerConnectionIdRaw = Object.prototype.hasOwnProperty.call(data, 'providerConnectionId')
            ? data.providerConnectionId
            : undefined;
          const { permissionModeOverride, sessionInputSource } = sessionMessageSendAdmission;
          const retainedLocalId = actionCaller.kind === 'plugin'
            ? null
            : resolveSessionMessageSendLocalId(data, ctx);
          const structuredSubagentInput = data.kind === 'sessionSubagentLaunch'
            ? resolveSubagentLaunchStructuredSend(data.launch)
            : data.kind === 'sessionSubagentCommand'
              ? resolveSubagentCommandStructuredSend(data.command)
              : null;
          const requestedAction = PendingRequestedActionV1Schema.parse(
            structuredSubagentInput
              ? { v: 1, kind: 'send_now' }
              : data.requestedAction ?? { v: 1, kind: 'steer_if_active' },
          );
          const toolAnswerDelivery = actionCaller.kind === 'plugin' && parsedToolAnswerDelivery?.success
            ? parsedToolAnswerDelivery.data : undefined;
          const messageMeta = structuredSubagentInput || data.structuredInput !== undefined
            || data.forgeEvidence !== undefined || toolAnswerDelivery || ctx.sessionMessageScmWalkthroughQuestion !== undefined
            ? {
                ...(structuredSubagentInput
                  ? structuredSubagentInput.messageMeta
                  : data.structuredInput !== undefined
                    ? { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: RawIngressStructuredInputV1Schema.parse(data.structuredInput) }
                    : {}),
                ...(data.forgeEvidence === undefined ? {} : { forgeEvidence: data.forgeEvidence }),
                ...(ctx.sessionMessageScmWalkthroughQuestion === undefined ? {} : {
                  [SCM_WALKTHROUGH_QUESTION_META_KEY_V1]: ctx.sessionMessageScmWalkthroughQuestion,
                }),
                ...(toolAnswerDelivery ? {
                  happier: {
                    kind: SESSION_TOOL_ANSWER_DELIVERY_KIND,
                    payload: { toolCallId: toolAnswerDelivery.toolCallId },
                  },
                } : {}),
              }
            : undefined;
          const sendMessageArgs = {
            context: ctx,
            authoredInput: SessionSendMessageInputSchema.parse({ ...data, sessionId }),
            ...(ctx.externalActionCredential?.grant ? { callerInputConstraints: {
              models: ctx.externalActionCredential.grant.models,
              permissionModes: ctx.externalActionCredential.grant.permissionModes,
            } } : {}),
            sessionId,
            message: structuredSubagentInput?.text ?? String(data.message ?? ''),
            ...(data.recipient === undefined ? {} : {
              recipient: ParticipantRecipientRoutingIdentityV1Schema.parse(data.recipient),
            }),
            ...(structuredSubagentInput
              ? {
                  displayText: structuredSubagentInput.displayText,
                }
              : {}),
            ...(messageMeta === undefined ? {} : { messageMeta }),
            ...(ctx.sessionMessageDisplayText !== undefined ? { displayText: ctx.sessionMessageDisplayText } : {}),
            requestedAction,
            actionCaller,
            ...(typeof data.idempotencyKey === 'string' ? { idempotencyKey: data.idempotencyKey } : {}),
            // A plugin input's identity is host-derived from its idempotency
            // key, so only a non-plugin caller may retain its own localId.
            ...(retainedLocalId
              ? { localId: retainedLocalId }
              : {}),
            ...(parsedSource?.success ? { source: parsedSource.data } : {}),
            ...(parsedAttachments?.success ? { attachments: parsedAttachments.data } : {}),
            ...(permissionModeOverride ? { permissionModeOverride } : {}),
            ...(modelOverrideRaw === null
              ? { modelOverride: null }
              : typeof modelOverrideRaw === 'string' && modelOverrideRaw.trim().length > 0
                ? { modelOverride: modelOverrideRaw.trim() }
                : {}),
            ...(providerConnectionIdRaw === null
              ? { providerConnectionId: null }
              : typeof providerConnectionIdRaw === 'string' && providerConnectionIdRaw.trim().length > 0
                ? { providerConnectionId: ProviderConnectionIdSchema.parse(providerConnectionIdRaw) }
                : {}),
            ...(data.reply === 'none' || data.reply === 'wait' || data.reply === 'return'
              ? { reply: data.reply }
              : typeof data.wait === 'boolean' ? { wait: data.wait } : {}),
            ...(typeof data.returnToSessionId === 'string' ? { returnToSessionId: data.returnToSessionId } : {}),
            ...(typeof data.timeoutSeconds === 'number' ? { timeoutSeconds: data.timeoutSeconds } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.surface ? { callerSurface: ctx.surface } : {}),
            ...(sessionInputSource ? { sessionInputSource } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          } satisfies Parameters<typeof deps.sessionSendMessage>[0];
          if (actionCaller.kind === 'plugin') {
            dispatchFacts.dispatchedPluginSessionInputLocalId = derivePluginSessionInputLocalIdV1({
              caller: actionCaller,
              sessionId,
              idempotencyKey: String(data.idempotencyKey),
            });
          }
          const res = await deps.sessionSendMessage(sendMessageArgs);
          return completeActionResult(res);
        }

        if (actionId === 'session.message.reply') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionMessageReply) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionMessageReply({ context: ctx, sessionId,
            requestLocalId: String(data.requestLocalId), reply: SessionMessageExplicitReplyV1Schema.parse(data.reply),
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'session.exchange.control') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionExchangeControl) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionExchangeControl({ context: ctx, sessionId,
            originInputLocalId: String(data.originInputLocalId),
            request: AutonomousExchangeControlRequestV1Schema.parse({
              control: data.decision === 'continue_more' ? 'continue_more_10' : data.decision,
              observedRevision: data.observedRevision }),
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }
  return null;
}
