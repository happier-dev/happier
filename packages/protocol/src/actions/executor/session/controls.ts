import { isSessionStateFieldActionId, resolveSessionStateFieldActionWrite } from '../../sessionStateFieldActions.js';
import { resolveSessionControlTarget, resolveSessionIdFromInput, resolveServerIdForSession } from '../sessionScope.js';
import { completeActionResult, isDeferredApprovalResult, normalizeActionExecutorThrownError } from '../resultProjection.js';
import { normalizeId, readNullableString } from '../inputReading.js';
import { readNonBlankOpaqueIdentifier } from '../../../strings/opaqueIdentifier.js';
import type { AdmittedActionInputById } from '../../actionSpecs.js';
import { createPermissionPolicyResult, assertAgentPermission } from '../callerContext.js';
import { SESSION_PERMISSION_MODES } from '../../../sessions/metadata/sessionPermissionModes.js';
import { isPermissionModeGrantedV1 } from '../../../auth/apiTokenGrant.js';
import { resolveSessionAttentionStandingRequest, SessionAttentionSetResultV1Schema } from '../../../sessions/organization/attentionAction.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { readRecord, hasOwn } from '../../../inputs/inputRecords.js';
import { NativePermissionChoiceAnswerV1Schema, SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondPayloadV1Schema } from '../../../sessions/permissions/respondRpcParamsV1.js';
import { normalizeResolvedOptions } from '../../../inputs/inputOptions.js';
import { resolveRequestedSessionModeId } from '../../sessionModeIds.js';
import {
  SessionConnectedServiceAuthSwitchReceiptSchema,
} from '../../../connect/sessionConnectedServiceAuthSwitch.js';
import type { ActionExecutorContext } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorDeps } from '../types.js';
import { ActionIdSchema, SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import { SessionConfigOptionWriteReceiptSchema } from '../../../sessions/control/sessionConfigOptionV1.js';
import { SessionStatusResultSchema } from '../../../sessions/control/contract.js';
import type { NativePermissionChoiceAnswerV1, NativePermissionChoicesV1 } from '../../../sessions/permissions/nativeChoicesV1.js';

export function readOfferedPermissionFollowUp(offer: NativePermissionChoicesV1 | undefined, answer: NativePermissionChoiceAnswerV1 | undefined) {
  return offer?.requirementId === answer?.requirementId ? offer?.choices.find(choice => choice.id === answer?.choiceId)?.followUp : undefined;
}

/** Every native response transport shares the same ordinary Action completion and retry operand. */
export async function completeOfferedPermissionChoice(
  answered: ActionExecuteResult,
  followUp: NativePermissionChoicesV1['choices'][number]['followUp'],
  execute: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>,
): Promise<ActionExecuteResult> {
  if (!answered.ok || !followUp) return answered;
  const id = ActionIdSchema.safeParse(followUp.actionId);
  let saved: ActionExecuteResult;
  try { saved = id.success ? await execute(id.data, followUp.input)
    : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }; }
  catch (error) { saved = { ok: false, ...normalizeActionExecutorThrownError(error) }; }
  if (!saved.ok) return { ...saved, details: { ...readRecord(saved.details), answered: true, followUp } };
  if (isDeferredApprovalResult(saved)) return { ok: false, errorCode: 'approval_request_created', error: 'approval_request_created',
    details: { ...readRecord(saved.result), answered: true, followUp } };
  return answered;
}

function readPermissionResponseDecision(raw: unknown) {
  const parsed = SessionPermissionRespondActionDecisionV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function readUserActionDecision(raw: unknown): 'approve' | 'reject' | 'request_changes' | undefined {
  return raw === 'approve' || raw === 'reject' || raw === 'request_changes' ? raw : undefined;
}

export async function dispatchSessionControls1(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'deps' | 'data'> & Readonly<{
  isSameHome: (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext) => boolean;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, deps, data, isSameHome } = inv;

        if (isSessionStateFieldActionId(actionId)) {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionStateFieldSet) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          const serverId = 'serverId' in data && typeof data.serverId === 'string'
            ? data.serverId : resolveServerIdForSession(deps, ctx, sessionId);
          const write = resolveSessionStateFieldActionWrite(actionId, parsed.data as AdmittedActionInputById[typeof actionId],
            ctx.invocationServices?.templateInstructionsSessionId === sessionId);
          const res = await deps.sessionStateFieldSet({ context: ctx, actionId, sessionId, ...write, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.compact') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionCompact) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.compact' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionCompact({ sessionId, context: ctx,
            ...(typeof data.instructions === 'string' ? { instructions: data.instructions } : {}),
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.turn.cancel') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTurnCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.turn.cancel' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const acknowledgement = await deps.sessionTurnCancel({ sessionId, context: ctx,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          // The Session abort RPC acknowledges delivery with no response body.
          return completeActionResult(acknowledgement ?? { requested: true });
        }

        if (actionId === 'session.runtime.refresh') {
          if (!deps.sessionRuntimeRefresh) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          const input = parsed.data as AdmittedActionInputById['session.runtime.refresh'];
          const serverId = input.serverId ?? resolveServerIdForSession(deps, ctx, input.sessionId);
          return completeActionResult(await deps.sessionRuntimeRefresh({ ...input, context: ctx,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.stop') {
          const input = parsed.data as AdmittedActionInputById['session.stop'];
          if (input.serverId && ctx.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStop) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop' };
          }
          const serverId = input.serverId ?? resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStop({ sessionId, stopIntent: input.stopIntent ?? 'explicit_stop', context: ctx, ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.terminalComposer.clear') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTerminalComposerClear) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.terminalComposer.clear' };
          }
          const expectedStateAtMs = typeof data.expectedStateAtMs === 'number'
            ? data.expectedStateAtMs
            : undefined;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTerminalComposerClear({
            sessionId,
            ...(expectedStateAtMs !== undefined ? { expectedStateAtMs } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.pendingInput.interruptAndRun') {
          const sessionId = normalizeId(data.sessionId);
          const localId = normalizeId(data.localId);
          if (!sessionId || !localId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPendingInputInterruptAndRun) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.pendingInput.interruptAndRun' };
          }
          const expectedStateAtMs = typeof data.expectedStateAtMs === 'number'
            ? data.expectedStateAtMs
            : undefined;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPendingInputInterruptAndRun({
            sessionId,
            localId,
            ...(expectedStateAtMs !== undefined ? { expectedStateAtMs } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.permission_mode.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPermissionModeSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission_mode.set' };
          }
          const permissionMode = normalizeId(data.permissionMode);
          if (!permissionMode) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const permissionResolution = assertAgentPermission(ctx, permissionMode);
          if (!permissionResolution.ok) {
            return permissionResolution.error;
          }
          const permissionDecision = permissionResolution.permissionDecision;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const effectiveMode = permissionDecision?.ok === true ? permissionDecision.normalizedMode : permissionMode;
          const grantedMode = SESSION_PERMISSION_MODES.find((mode) => mode === effectiveMode);
          const callerConstraints = ctx.externalActionCredential?.grant;
          if (callerConstraints && (!grantedMode || !isPermissionModeGrantedV1(callerConstraints, grantedMode))) {
            return { ok: false, errorCode: 'permission_mode_not_granted', error: 'permission_mode_not_granted' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionModeSet({
            sessionId,
            context: ctx,
            permissionMode: effectiveMode,
            ...(data.applyTiming === 'immediate' || data.applyTiming === 'next_prompt' ? { applyTiming: data.applyTiming } : {}),
            ...(callerConstraints ? { callerInputConstraints: {
              models: callerConstraints.models, permissionModes: callerConstraints.permissionModes,
            } } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.attention.set') {
          const input = parsed.data as AdmittedActionInputById['session.attention.set'];
          const request = resolveSessionAttentionStandingRequest(input);
          const sessionId = normalizeId(input.sessionId);
          if (!request || !sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionAttentionSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.attention.set' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const result = await deps.sessionAttentionSet({ context: ctx, sessionId, request,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          const output = SessionAttentionSetResultV1Schema.safeParse(result);
          if (!output.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          return completeActionResult(output.data);
        }

        if (actionId === 'session.approval_reviewer.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId || (data.enabled !== null && typeof data.enabled !== 'boolean')) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionApprovalReviewerSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.approval_reviewer.set' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionApprovalReviewerSet({ context: ctx, sessionId, enabled: data.enabled, ...(serverId ? { serverId } : {}) }));
        }

        if (actionId === 'session.model.set') {
          const input = parsed.data as AdmittedActionInputById['session.model.set'];
          const sessionId = normalizeId(input.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionModelSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.set' };
          }
          const { modelSelection, teamCredentialModel } = input;
          const modelId = readNonBlankOpaqueIdentifier(input.modelId);
          if (!modelSelection && !teamCredentialModel && !modelId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const providerConnectionId = input.providerConnectionId === null
            ? null
            : normalizeId(input.providerConnectionId);
          if (input.providerConnectionId !== undefined && input.providerConnectionId !== null && !providerConnectionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionModelSet({
            sessionId,
            context: ctx,
            ...(input.applyTiming ? { applyTiming: input.applyTiming } : {}),
            ...(input.captureBefore !== undefined ? { captureBefore: input.captureBefore } : {}),
            ...(input.expected !== undefined ? { expected: input.expected } : {}),
            ...(ctx.externalActionCredential?.grant ? { callerInputConstraints: {
              models: ctx.externalActionCredential.grant.models,
              permissionModes: ctx.externalActionCredential.grant.permissionModes,
            } } : {}),
            ...(modelId ? { modelId } : {}),
            ...(modelSelection !== undefined ? { modelSelection } : {}),
            ...(teamCredentialModel !== undefined ? { teamCredentialModel } : {}),
            ...(input.teamVisibilityGrantConsent !== undefined ? { teamVisibilityGrantConsent: input.teamVisibilityGrantConsent } : {}),
            ...(input.providerConnectionId !== undefined ? { providerConnectionId } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }
  return null;
}

export async function dispatchSessionControls2(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'deps' | 'data'> & Readonly<{
  isSameHome: (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext) => boolean;
  executeFollowUp: (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, deps, data, isSameHome } = inv;

        if (actionId === 'session.permission.respond') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionPermissionRespond) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const decision = readPermissionResponseDecision(data.decision);
          if (!decision && !data.nativeChoice) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const nativeChoice = data.nativeChoice === undefined ? undefined : NativePermissionChoiceAnswerV1Schema.parse(data.nativeChoice);
          // Capture the producer's effect before the native answer retires its pending occurrence.
          // The native ingress remains the sole offered-answer authority.
          const status = nativeChoice && deps.sessionStatusGet ? readRecord(await deps.sessionStatusGet({ sessionId,
            context: ctx, ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) })) : null;
          const pending = status ? SessionStatusResultSchema.shape.pendingRequests.parse(status.pendingRequests) : undefined;
          const occurrence = pending?.find(request => request.requestId === data.requestId
            && (data.turnId === undefined || data.turnId === null || request.turnId === data.turnId));
          const followUp = readOfferedPermissionFollowUp(occurrence?.nativeChoices, nativeChoice);
          const res = await deps.sessionPermissionRespond({
            sessionId,
            context: ctx,
            ...(decision ? { decision } : {}),
            ...(nativeChoice === undefined ? {} : { nativeChoice }),
            requestId: hasOwn(data, 'requestId') ? readNullableString(data.requestId) : null,
            turnId: hasOwn(data, 'turnId') ? readNullableString(data.turnId) : null,
            ...(data.mode === undefined ? {} : { mode: SessionPermissionRespondPayloadV1Schema.shape.mode.parse(data.mode) }),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
            ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
            ...(hasOwn(data, 'updatedPermissions') ? { updatedPermissions: data.updatedPermissions } : {}),
            ...(hasOwn(data, 'execPolicyAmendment') ? { execPolicyAmendment: SessionPermissionRespondPayloadV1Schema.shape.execPolicyAmendment.parse(data.execPolicyAmendment) } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeOfferedPermissionChoice(completeActionResult(res), followUp,
            (id, input) => inv.executeFollowUp(id, input, ctx));
        }

        if (actionId === 'session.needs_you.raise') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionNeedsYouRaise) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.needs_you.raise' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionNeedsYouRaise({ sessionId,
            input: parsed.data as AdmittedActionInputById['session.needs_you.raise'], context: ctx,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.user_action.answer') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionUserActionAnswer) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.user_action.answer' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionUserActionAnswer({
            sessionId,
            context: ctx,
            requestId: hasOwn(data, 'requestId') ? readNullableString(data.requestId) : null,
            ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}),
            answers: Array.isArray(data.answers) ? data.answers.map((entry) => {
              const answer = readRecord(entry);
              return {
                question: String(answer.question ?? ''),
                ...(typeof answer.freeText === 'string' ? { freeText: answer.freeText } : {}),
                ...(typeof answer.note === 'string' ? { note: answer.note } : {}),
                values: Array.isArray(answer.values)
                  ? answer.values.map((value) => String(value))
                  : typeof answer.answer === 'string'
                    ? [answer.answer]
                    : [],
              };
            }) : [],
            ...(data.disposition === 'pass_up' ? { disposition: 'pass_up' as const } : {}),
            ...(readUserActionDecision(data.decision) ? { decision: readUserActionDecision(data.decision) } : {}),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
            ...(hasOwn(data, 'updatedPermissions') ? { updatedPermissions: data.updatedPermissions } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.control.switch') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionControlSwitch) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.control.switch' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionControlSwitch({
            sessionId, to: data.to as 'remote' | 'local', context: ctx,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'session.mode.set') {
          if (!deps.sessionModesList || !deps.sessionModeSet) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const modeIdRaw = normalizeId(data.modeId);
          const availableModes = normalizeResolvedOptions(await deps.sessionModesList({ sessionId }));
          const modeId = resolveRequestedSessionModeId(modeIdRaw, availableModes);
          if (modeId && availableModes.length > 0) {
            if (!availableModes.some((option) => normalizeId(option.value) === modeId)) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
          }
          const res = await deps.sessionModeSet({ sessionId, modeId });
          return completeActionResult(res);
        }

        if (actionId === SESSION_CONFIG_OPTION_SET_ACTION_ID_V1) {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionConfigOptionSet) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          const target = await resolveSessionControlTarget(deps, ctx, sessionId);
          if (!target.ok) return target;
          const { ok: _resolved, ...address } = target;
          const result = await deps.sessionConfigOptionSet({
            ...address,
            configId: String(data.configId),
            valueId: data.valueId === null ? null : String(data.valueId),
          }, ctx);
          const refusal = readActionFailureEnvelope(result);
          if (refusal) return refusal;
          const receipt = SessionConfigOptionWriteReceiptSchema.safeParse(result);
          return receipt.success ? { ok: true, result: receipt.data }
            : { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
        }

        if (actionId === SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1) {
          if (!deps.sessionConnectedServicesAuthSet) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          const { sessionId, routing: { selectedServiceId: _selectedServiceId, ...routing }, ...input } = parsed.data as AdmittedActionInputById[typeof actionId];
          if (typeof sessionId !== 'string') return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const expectedMachineId = ctx.expectedSessionMachineId
            ?? (deps.sessionStatusGet ? readRecord(readRecord(await deps.sessionStatusGet({
              sessionId, serverId: ctx.expectedSessionAddress?.serverId ?? ctx.serverId,
              context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
            })).session).machineId : undefined);
          if (typeof expectedMachineId === 'string' && expectedMachineId.trim() && input.machineId !== expectedMachineId) {
            return { ok: false, errorCode: 'session_address_mismatch', error: 'session_address_mismatch' };
          }
          const response = await deps.sessionConnectedServicesAuthSet({ sessionId, ...input, ...routing }, ctx);
          // Action failures carry an error message. Receipt refusals carry per-service diagnostics.
          const refusal = typeof readRecord(response).error === 'string' ? readActionFailureEnvelope(response) : null;
          if (refusal) return refusal;
          const receipt = SessionConnectedServiceAuthSwitchReceiptSchema.safeParse(response);
          if (!receipt.success) return { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
          const result = receipt.data;
          return result.ok
            ? { ok: true, result }
            : { ok: false, errorCode: result.errorCode, error: result.errorCode, details: result };
        }

        if (actionId === 'session.target.primary.set') {
          if (!deps.sessionTargetPrimarySet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.primary.set' };
          }
          if (data.sessionId === null) {
            const res = await deps.sessionTargetPrimarySet({ sessionId: null });
            return completeActionResult(res);
          }
          const res = await deps.sessionTargetPrimarySet({
            serverId: String(data.serverId),
            sessionId: String(data.sessionId),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.target.tracked.set') {
          if (!deps.sessionTargetTrackedSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.tracked.set' };
          }
          const res = await deps.sessionTargetTrackedSet(Array.isArray(data.sessionAddresses)
            ? {
                context: ctx,
                sessionAddresses: data.sessionAddresses.map((address) => {
                  const record = readRecord(address);
                  return { serverId: String(record.serverId), sessionId: String(record.sessionId) };
                }),
              }
            : {
                context: ctx,
                sessionIds: Array.isArray(data.sessionIds) ? data.sessionIds.map(String) : [],
              });
          return completeActionResult(res);
        }
  return null;
}
