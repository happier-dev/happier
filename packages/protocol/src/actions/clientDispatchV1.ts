import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ACTION_ID_FAMILIES_V1, ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionSurfaceSchema, ActionRequiredAuthoritySchema, getActionSpec, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import type { ActionExecuteResult, ActionExecutorContext } from './executor/types.js';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteResultSchema, type ActionExecuteFailure } from './actionExecutionResult.js';
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
import { isThemeActionId, type ThemeActionId } from './themeActionIdsV1.js';
import { isAccountLifecycleActionId } from './accountLifecycleActionFamily.js';
import { isVoiceConversationActionId } from './voiceConversationActionFamily.js';
import type { SocketRpcAnsweringClientCandidateV1 } from '../rpc/socket.js';
import { AdmittedHostReviewedChildrenV1Schema, type AdmittedHostReviewedChildrenV1 } from './executor/hostReviewedChildrenV1.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { PERSONAL_HOME_CREATE_ACTION_ID_V1 } from './specs/machineConnectionActionIdsV1.js';
import { LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1 } from './specs/localDaemonServiceActionIdsV1.js';
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

export const DESKTOP_UI_ACTION_CLIENT_RPC_METHOD = `${RPC_METHODS.UI_ACTION_EXECUTE}.desktop` as const;

const DESKTOP_ACTION_IDS: ReadonlySet<ActionId> = new Set([
  ...ACTION_ID_FAMILIES_V1.desktop_shell, ...ACTION_ID_FAMILIES_V1.desktop_windows, PERSONAL_HOME_CREATE_ACTION_ID_V1,
]);

/** Desktop effects use the Home's desktop responder, even for an Agent with a bound Session. */
export function resolveDesktopUiActionClientRpcMethod(actionId: ActionId, input: unknown): typeof DESKTOP_UI_ACTION_CLIENT_RPC_METHOD | undefined {
  if (actionId === LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1) {
    // An explicit addressing choice can also be an Electron client. Both
    // native shells serve System Tasks; only Tauri advertises the desktop room.
    if (input && typeof input === 'object' && 'clientId' in input && typeof input.clientId === 'string') return undefined;
    return DESKTOP_UI_ACTION_CLIENT_RPC_METHOD;
  }
  const presentation = actionId === 'session.open' && input && typeof input === 'object' && 'presentation' in input
    ? input.presentation : undefined;
  if (DESKTOP_ACTION_IDS.has(actionId) || presentation === 'overlay' || presentation === 'window') {
    return DESKTOP_UI_ACTION_CLIENT_RPC_METHOD;
  }
  return undefined;
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

/** The existing reverse Action transport, addressed to the App hosting this Voice Run. */
export function voiceRunActionClientRpcMethod(runId: string): string {
  return `${RPC_METHODS.UI_ACTION_EXECUTE}.voice.${encodeURIComponent(JSON.stringify(runId))}`;
}

export function isVoiceRunActionClientRpcMethod(method: string): boolean {
  const prefix = `${RPC_METHODS.UI_ACTION_EXECUTE}.voice.`;
  if (!method.startsWith(prefix)) return false;
  try {
    const runId: unknown = JSON.parse(decodeURIComponent(method.slice(prefix.length)));
    return typeof runId === 'string' && runId.trim().length > 0;
  } catch { return false; }
}

/** A live Run's request for its owning App's Action front door; carries no authority claims. */
export const VoiceRunActionDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actionId: ActionIdSchema,
  input: z.unknown(),
  voiceRun: z.strictObject({
    runId: z.string().check(z.trim(), z.minLength(1)),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    occurrenceId: z.string().check(z.trim(), z.minLength(1)),
    turnId: z.string().check(z.trim(), z.minLength(1)),
    actionRequestId: z.string().check(z.trim(), z.minLength(1)),
  }),
}));
export type VoiceRunActionDispatchRequestV1 = z.infer<typeof VoiceRunActionDispatchRequestV1Schema>;

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
    admittedHostReviewedChildren: z.optional(AdmittedHostReviewedChildrenV1Schema),
  }),
}).check(z.superRefine((request, ctx) => {
  const spec = getActionSpec(request.actionId);
  const input = spec.inputSchema.safeParse(request.input);
  if (!Object.hasOwn(request, 'input') || !input.success || resolveActionExecutionPlacementForInput(spec, input.data, request.context.actionCaller, request.context.surface) !== 'client') {
    ctx.addIssue({ code: 'custom', message: 'Invalid client Action', path: ['input'] });
  }
  const children = request.context.admittedHostReviewedChildren;
  if (children && (children.parentActionId !== request.actionId
    || children.parentInputDigest !== computeActionInputApprovalDigestV1(request.actionId, request.input))) {
    ctx.addIssue({ code: 'custom', message: 'Reviewed children belong to another parent input', path: ['context', 'admittedHostReviewedChildren'] });
  }
})));
export type UiActionDispatchRequestV1 = z.infer<typeof UiActionDispatchRequestV1Schema>;

/** Serialize only the wire owner's context fields; local callbacks and runtime facts stay in their realm. */
export function buildUiActionDispatchRequestV1(request: Readonly<{
  actionId: ActionId; input: unknown; context: ActionExecutorContext;
  admittedHostReviewedChildren?: AdmittedHostReviewedChildrenV1;
}>): UiActionDispatchRequestV1 {
  const shape = UiActionDispatchRequestV1Schema.shape.context.shape;
  // Only the executor's closed admission supplies these facts, never a caller's context projection.
  const context = { ...Object.fromEntries(Object.entries(request.context)
    .filter(([key]) => key !== 'admittedHostReviewedChildren' && Object.hasOwn(shape, key))),
    ...(request.admittedHostReviewedChildren ? { admittedHostReviewedChildren: request.admittedHostReviewedChildren } : {}) };
  return UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: request.actionId, input: request.input, context });
}

/**
 * Workflow definition writes and trigger operations whose non-person caller is
 * admitted by the Machine host's agent-start policy and materializer.
 */
const WORKFLOW_HOST_ADMITTED_CHILD_ACTION_IDS_V1: ReadonlySet<ActionId> = new Set<ActionId>([
  'workflow.definition.create', 'workflow.definition.update', 'workflow.definition.edit', 'workflow.definition.delete',
  'workflow.trigger.list', 'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove', 'workflow.trigger.test',
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
  execution: ActionExecuteResultSchema,
}));
export type UiActionDispatchResultV1 = z.infer<typeof UiActionDispatchResultV1Schema>;

/** Absence is a declared domain result where the Action has one, otherwise a typed failure. */
export function clientActionUnavailable(actionId: ThemeActionId): ActionExecuteFailure;
export function clientActionUnavailable(actionId: ActionId): ActionExecuteResult;
export function clientActionUnavailable(actionId: ActionId): ActionExecuteResult {
  if (isThemeActionId(actionId)) return { ok: false, errorCode: 'client_not_connected', error: 'client_not_connected' };
  if (actionId === 'session.draft.delete') return { ok: false, errorCode: 'unavailable', error: 'noClient',
    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE,
      instruction: 'Open a signed-in Happier client connected to the target Machine, then request draft deletion again.' } } };
  if (isWorkspaceActionId(actionId) || isUpdatesActionId(actionId) || isAppUpdateActionId(actionId)
    || isAccountLifecycleActionId(actionId) || actionId === 'bugreport.submit' || actionId === 'desktop.windows.open') {
    return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
  }
  if (isAppShellActionId(actionId) && actionId !== 'inbox.mark_all_read') return { ok: true, result: { status: 'unavailable' } };
  if (isWorkflowAuthoringActionId(actionId)) return { ok: true, result: { status: 'unavailable' } };
  if (actionId === 'usage.sources.dismiss') return { ok: true, result: { status: 'unavailable' } };
  if (actionId === 'session.authoring.open') {
    return { ok: true, result: { kind: 'unavailable', reason: 'client_unavailable' } };
  }
  if (actionId === 'ui.find' || actionId === 'ui.prompts.picker.open' || actionId === 'ui.prompts.picker.select'
    || actionId === 'ui.prompts.picker.apply' || actionId === 'ui.prompts.history' || actionId === 'session.messages.pins') {
    return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  }
  if (actionId === 'session.pending.next') return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  if (isSettingsDeclarationActionIdV1(actionId) || isVoiceConversationActionId(actionId) || actionId === 'projects.sources.moveToTeam') return { ok: false, errorCode: 'unavailable', error: 'noClient',
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
  if (approval.success) return { ...execution, result: approval.data };
  const output = getActionSpec(actionId).outputSchema?.safeParse(execution.result);
  return output?.success ? { ...execution, result: output.data } : null;
}
