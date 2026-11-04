import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionSurfaceSchema, ActionRequiredAuthoritySchema, getActionSpec, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import type { ActionExecuteResult, ActionExecutorContext } from './executor/types.js';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { ApprovalExecutionOriginCallerV1Schema } from '../approvals/approvalRequestV1.js';
import { ExternalActionTargetV1Schema } from './externalActionApi.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { isWorkflowAuthoringActionId } from './workflowAuthoringActionIds.js';
import { isAppShellActionId } from './appShellActionFamily.js';
import { isWorkspaceActionId } from './workspaceActionFamily.js';
import { isUpdatesActionId } from './updatesActionFamily.js';
import { isAppUpdateActionId } from './appUpdateActionFamily.js';
import { isAccountLifecycleActionId } from './accountLifecycleActionFamily.js';
import { isVoiceConversationActionId } from './voiceConversationActionFamily.js';
import type { SocketRpcAnsweringClientCandidateV1 } from '../rpc/socket.js';
export { withoutClientActionInput } from './clientActionInput.js';

/** One deterministic recovery contract for every client-placed Action family. */
export function clientActionAmbiguous(clients: readonly SocketRpcAnsweringClientCandidateV1[] = []): Readonly<{
  ok: false; errorCode: 'client_ambiguous'; error: string;
  details: { clients: SocketRpcAnsweringClientCandidateV1[];
    recovery: { kind: 'choose_client'; inputField: 'clientId' } };
}> {
  return { ok: false, errorCode: 'client_ambiguous',
    error: 'Pass clientId from details.clients to choose an exact answering client.',
    details: { clients: [...clients], recovery: { kind: 'choose_client', inputField: 'clientId' } } };
}

/** A mounted Session view, rather than any signed-in client on the Account. */
export function sessionUiActionClientRpcMethod(sessionId: string): string {
  return `${RPC_METHODS.UI_ACTION_EXECUTE}.session.${encodeURIComponent(JSON.stringify(sessionId))}`;
}

export function isSessionUiActionClientRpcMethod(method: string): boolean {
  const prefix = `${RPC_METHODS.UI_ACTION_EXECUTE}.session.`;
  if (!method.startsWith(prefix)) return false;
  try {
    const sessionId: unknown = JSON.parse(decodeURIComponent(method.slice(prefix.length)));
    return typeof sessionId === 'string' && sessionId.trim().length > 0;
  } catch { return false; }
}

/** Existing reverse-RPC rooms select a mounted read owner, rather than an arbitrary App. */
export function mountedWorkReadClientRpcMethod(actionId: 'session.work.get' | 'inbox.get', sessionId?: string): string {
  return actionId === 'inbox.get' ? `${RPC_METHODS.UI_ACTION_EXECUTE}.inbox`
    : `${RPC_METHODS.UI_ACTION_EXECUTE}.work.${encodeURIComponent(JSON.stringify(sessionId ?? ''))}`;
}

export function isMountedWorkReadClientRpcMethod(method: string): boolean {
  if (method === mountedWorkReadClientRpcMethod('inbox.get')) return true;
  const prefix = `${RPC_METHODS.UI_ACTION_EXECUTE}.work.`;
  if (!method.startsWith(prefix)) return false;
  try {
    const sessionId: unknown = JSON.parse(decodeURIComponent(method.slice(prefix.length)));
    return typeof sessionId === 'string' && sessionId.trim().length > 0;
  }
  catch { return false; }
}

/** Current UI reads advertise only from an App that can presently disclose a snapshot. */
export function currentUiContextReadClientRpcMethod(): string {
  return `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.read`;
}

/** Opaque command ids bind follow-up execution to the App that produced the descriptor. */
export function currentUiContextCommandClientRpcMethod(commandId: string): string {
  return `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.command.${encodeURIComponent(JSON.stringify(commandId))}`;
}

export function isCurrentUiContextClientRpcMethod(method: string): boolean {
  if (method === currentUiContextReadClientRpcMethod()) return true;
  const prefix = `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.command.`;
  if (!method.startsWith(prefix)) return false;
  try {
    const commandId: unknown = JSON.parse(decodeURIComponent(method.slice(prefix.length)));
    return typeof commandId === 'string' && commandId.trim().length > 0;
  }
  catch { return false; }
}

/** Private continuation of an Action admitted by the authenticated Machine host. */
export const UiActionDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actionId: ActionIdSchema,
  input: z.unknown(),
  context: z.strictObject({
    surface: z.keyof(ActionSurfaceSchema),
    authority: ActionRequiredAuthoritySchema,
    defaultSessionId: z.optional(z.string().check(z.minLength(1))),
    defaultSessionMachineId: z.optional(z.string().check(z.minLength(1))),
    agentStartWorkspaceWrites: z.optional(z.enum(['allow', 'deny'])),
    // Host provenance, never Action input. Nested owners recheck the grant and
    // keep their own approval policy; the root's bypass/signature is not delegated.
    actionCaller: z.optional(ApprovalExecutionOriginCallerV1Schema),
    actionRequestId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    externalActionCredential: z.optional(z.strictObject({
      accountId: z.string().check(z.minLength(1)), principalId: z.string().check(z.minLength(1)), credentialId: z.string().check(z.minLength(1)),
      grant: ApiTokenGrantV1Schema,
    })),
    externalActionTarget: z.optional(ExternalActionTargetV1Schema),
  }),
}).check(z.superRefine((request, ctx) => {
  const spec = getActionSpec(request.actionId);
  const input = spec.inputSchema.safeParse(request.input);
  if (!Object.hasOwn(request, 'input') || !input.success || resolveActionExecutionPlacementForInput(spec, input.data) !== 'client') {
    ctx.addIssue({ code: 'custom', message: 'Invalid client Action', path: ['input'] });
  }
})));
export type UiActionDispatchRequestV1 = z.infer<typeof UiActionDispatchRequestV1Schema>;

export function buildUiActionDispatchRequestV1(request: Readonly<{
  actionId: ActionId; input: unknown; context: ActionExecutorContext;
}>): UiActionDispatchRequestV1 {
  const shape = UiActionDispatchRequestV1Schema.shape.context.shape;
  // Only the executor's closed admission supplies these facts, never a caller's context projection.
  const context = { ...Object.fromEntries(Object.entries(request.context)
    .filter(([key]) => Object.hasOwn(shape, key))) };
  return UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: request.actionId, input: request.input, context });
}

/**
 * Workflow definition writes and trigger operations whose non-person caller is
 * admitted by the Machine host's agent-start policy and materializer.
 */
const WORKFLOW_HOST_ADMITTED_CHILD_ACTION_IDS_V1: ReadonlySet<ActionId> = new Set<ActionId>([
  'workflow.definition.create', 'workflow.definition.update', 'workflow.definition.edit', 'workflow.definition.delete',
  'workflow.trigger.list', 'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove', 'workflow.trigger.test',
  'session.trigger.list', 'session.trigger.add', 'session.trigger.update', 'session.trigger.remove',
]);

/** Exact list: a new trigger Action joins deliberately; `workflow.trigger.run_now` is not a child here. */
export function isWorkflowHostAdmittedChildActionIdV1(actionId: ActionId): boolean {
  return WORKFLOW_HOST_ADMITTED_CHILD_ACTION_IDS_V1.has(actionId);
}

/**
 * A child of a client Action the dispatching daemon admitted and is still awaiting.
 * It names that parent; caller, Session, Run and Account facts stay with the daemon.
 */
export const UiActionChildExecuteRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  parentRequestId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  actionId: ActionIdSchema,
  input: z.unknown(),
}).check(z.refine(request => isWorkflowHostAdmittedChildActionIdV1(request.actionId)
  && Object.hasOwn(request, 'input'), { message: 'Invalid admitted client Action child', path: ['actionId'] })));
export type UiActionChildExecuteRequestV1 = z.infer<typeof UiActionChildExecuteRequestV1Schema>;

export const UiActionDispatchResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  execution: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), result: z.unknown() }),
    ActionExecuteFailureSchema,
  ]),
}));
export type UiActionDispatchResultV1 = z.infer<typeof UiActionDispatchResultV1Schema>;

/** Absence is a declared domain result where the Action has one, otherwise a typed failure. */
export function clientActionUnavailable(actionId: ActionId): ActionExecuteResult {
  if (actionId === 'session.draft.delete') return { ok: false, errorCode: 'unavailable', error: 'noClient',
    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE,
      instruction: 'Open a signed-in Happier client connected to the target Machine, then request draft deletion again.' } } };
  if (isWorkspaceActionId(actionId) || isUpdatesActionId(actionId) || isAppUpdateActionId(actionId)
    || isAccountLifecycleActionId(actionId) || actionId === 'bugreport.submit') {
    return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
  }
  if (isAppShellActionId(actionId) && actionId !== 'inbox.mark_all_read') return { ok: true, result: { status: 'unavailable' } };
  if (isWorkflowAuthoringActionId(actionId)) return { ok: true, result: { status: 'unavailable' } };
  if (actionId === 'usage.sources.dismiss') return { ok: true, result: { status: 'unavailable' } };
  if (actionId === 'session.authoring.open') {
    return { ok: true, result: { kind: 'unavailable', reason: 'client_unavailable' } };
  }
  if (actionId === 'ui.find' || actionId === 'ui.prompts.picker.open') {
    return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  }
  if (actionId === 'session.pending.next') return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  if (isSettingsDeclarationActionIdV1(actionId) || isVoiceConversationActionId(actionId)) return { ok: false, errorCode: 'unavailable', error: 'noClient',
    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE,
      instruction: 'Open a signed-in Happier client connected to the target Machine, then retry this Action.' } } };
  return { ok: false, errorCode: 'unavailable', error: 'noClient' };
}

/** Dynamic result validation belongs to the same Action spec on both sides of delivery. */
export function parseClientActionDispatchResult(actionId: ActionId, raw: unknown): ActionExecuteResult | null {
  const parsed = UiActionDispatchResultV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const execution = parsed.data.execution;
  if (!execution.ok) return execution;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
  if (approval.success) return { ok: true, result: approval.data };
  const output = getActionSpec(actionId).outputSchema?.safeParse(execution.result);
  return output?.success ? { ok: true, result: output.data } : null;
}
