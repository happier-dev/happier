import type { ActionApprovalScopeV1 } from './actionSettings.js';
import { ACTION_IDS } from './actionIds.js';
import { isAutomationApprovalRequestSurface, canRequestPresentUserApprovalForActionInputV1 } from './decisionAuthority.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import type {
  ActionSettingsActionId,
  ActionsSettingsV1,
  ActionSettingsOverride,
} from './actionSettings.js';
import { resolveActionApprovalFlow, type ActionApprovalFlow, type ActionApprovalResult } from './actionApprovalMetadata.js';
import { getActionSpec, resolveActionExecutionPlacementForInput, type ActionSpec } from './actionSpecs.js';
import { isAgentOrUnresolvedSurface, resolveApprovalSurface } from './actionApprovalSurface.js';
import { isProjectSetupTrustRequestV1 } from './projectActionFamily.js';
export { isSharedRequesterActionV1 } from './actionRequestAttributionV1.js';
export { isAgentOrUnresolvedSurface } from './actionApprovalSurface.js';

export type ActionApprovalRoutingDecision = Readonly<{
  required: boolean;
  flow: ActionApprovalFlow;
  result: ActionApprovalResult;
}>;
export type ActionEnvironmentApprovalScopeAdmissionV1 = Readonly<{
  /** The actual child owns authority/effects. Null is an admitted global-only operation. */
  scope: Extract<ActionApprovalScopeV1, { kind: 'environment' }> | null;
  previewTemplateEnvironmentId?: string;
  /** A current nonwaivable custody hold, such as an unapproved exact fork head. */
  mandatoryApprovalRequired?: true;
}>;

/** Only confirmation preferences inherit; scope authority remains with the child. */
export function resolveActionApprovalPreferenceScopeV1(
  scope: ActionApprovalScopeV1 | undefined,
  previewTemplateEnvironmentId?: string,
): ActionApprovalScopeV1 | undefined {
  return scope?.kind === 'environment' && previewTemplateEnvironmentId
    ? { kind: 'environment', environmentId: previewTemplateEnvironmentId }
    : scope;
}

export type ResolveActionApprovalRoutingArgs = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  input?: unknown;
  settings?: ActionsSettingsV1 | null;
  context?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation' | 'bypassApprovals' | 'actionCaller' | 'isPluginSettingsIntentCurrent'> | null;
  requiredByPolicy?: boolean;
  /** Host-proved contextual classification, resolved through the same settings/waiver owner. */
  defaultSafety?: ActionSpec['safety'];
  /** Host-proved exposure classification; Settings and execution authority still apply. */
  defaultUiConfirmation?: boolean;
  /** An admitted shared request's outward effect; still subject to Settings Require/Waive. */
  defaultConfirmation?: boolean;
  /** Fresh computer-owner consent, never a caller-authored grant. */
  computerConsentGranted?: boolean;
  /** Exact live host operation proved by the executor's private factory port. */
  retainHostOperationApproval?: boolean;
}>;

function isApprovalAction(actionId: ActionId): boolean {
  return getActionSpec(actionId).approvalPolicy?.control === true;
}

/** Published projections of the declaration-owned confirmation defaults. */
export const EGRESS_SENSITIVE_AGENT_FLOOR: readonly ActionId[] = ACTION_IDS.filter(id => getActionSpec(id).approvalPolicy?.agentDefault === "egress");
export const SURFACE_AUTHORITY_AGENT_FLOOR: readonly ActionId[] = ACTION_IDS.filter(id => getActionSpec(id).approvalPolicy?.agentDefault === "authority");
export const AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS: readonly ActionId[] = ACTION_IDS.filter(id => {
  const spec = getActionSpec(id);
  return spec.approvalPolicy?.agentDefault !== undefined || (spec.safety === "danger" && spec.surfaces.agent && spec.approvalPolicy?.scopeAdmissionOwnsConfirmation !== true);
});

/**
 * True when an Action result leaving the host on this surface must be redacted before it can
 * egress to an agent turn — the canonical owner of the egress-surface question (INV-1 / DEC-2).
 *
 * This is deliberately the SAME resolution as the agent approval floor above: consent and egress
 * are two halves of one agent trust boundary and must not disagree. It replaced two hand-rolled
 * `context.surface === 'agent'` allowlists (the local-services runtime-action executors in the
 * daemon and in the UI sync domain) which failed OPEN — every surface value other than the exact
 * string `'agent'`, including `undefined`, received the unredacted payload.
 *
 * This predicate answers *whether* to redact. *What* to redact stays with the payload owner (for
 * public-preview URLs: `local/services/public/v1.ts`); do not add redaction rules here.
 */
export function requiresAgentEgressRedaction(
  ctx?: Pick<ActionExecutorContext, 'surface'> | null,
): boolean {
  return isAgentOrUnresolvedSurface(ctx);
}

/**
 * True when `actionId` is in the dangerous agent-initiated subset that requires human approval
 * by default. Exported so the action-settings UI (Phase 3.3) can surface the default and let a
 * user require, waive, or restore the default confirmation policy.
 */
export function isAgentInitiatedApprovalRequiredByDefault(actionId: ActionId): boolean {
  const spec = getActionSpec(actionId);
  return spec.approvalPolicy?.agentDefault !== undefined
    || (spec.safety === 'danger' && spec.surfaces.agent === true && spec.approvalPolicy?.scopeAdmissionOwnsConfirmation !== true);
}

/** Whether persisted Action settings may waive this host-declared confirmation. */
export function isActionApprovalWaivable(spec: Pick<ActionSpec, 'approvalPolicy'>): boolean {
  return spec.approvalPolicy?.nonWaivable !== true;
}

function requiresDefaultApprovalFloor(
  actionId: ActionId,
  ctx?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation'> | null,
  defaultSafety?: ActionSpec['safety'],
  input?: unknown,
  defaultUiConfirmation?: boolean,
): boolean {
  const surface = resolveApprovalSurface(ctx);
  const spec = getActionSpec(actionId);
  const policy = spec.approvalPolicy;
  const uiPolicyConfirmation = defaultUiConfirmation
    ?? policy?.uiConfirmationForInput?.(input) ?? (policy?.uiConfirmation === 'policy');
  defaultSafety ??= spec.safetyForInput?.(input) ?? spec.safety;
  if (policy?.pluginCaptureWaiver === true) return true;
  // Permission answers share the Agent default on MCP too; persisted surface
  // waivers remain resolved by the same ActionsSettings owner above this floor.
  if (surface.kind !== 'ambiguous' && policy?.requiredSurfaces?.includes(surface.surface)) return true;
  // Scoped removal is dangerous metadata, but its own/led Session policy owns
  // admission (FIN 03 §5.4/§5.7); it does not acquire the Account trigger approval floor.
  if (policy?.scopeAdmissionOwnsConfirmation === true && surface.kind !== 'ambiguous') return false;
  // Reversible UI intents and effects with their own UI review may explicitly
  // declare direct admission. This changes only the present user's UI default;
  // declared danger still governs automation and ambiguous callers.
  // CLI and UI suppress the duplicate default when the host records a completed
  // confirmation for this exact Action. Explicit settings are evaluated first
  // and still win.
  if (
    surface.kind === 'non_agent'
    && (
      (surface.surface === 'ui' && !uiPolicyConfirmation
        && (defaultSafety !== 'danger' || policy?.uiConfirmation === 'direct'))
      || ((surface.surface === 'cli' || surface.surface === 'ui') && ctx?.presentUserConfirmation?.actionId === actionId)
    )
    && ctx?.authority === 'present_user'
  ) {
    return false;
  }
  if (defaultSafety === 'danger') {
    if (surface.kind === 'ambiguous') return true;
    // General RPC remains an internal transport surface. These new semantic
    // filesystem methods are directly reachable effect entry points, however,
    // and use the same configurable Ask-first owner as their other surfaces.
    // Released unrooted aliases retain their separate incumbent admission path.
    if (surface.surface !== 'rpc' || policy?.rpcConfirmation === true) {
      return spec.surfaces[surface.surface] === true;
    }
  }
  return isAgentOrUnresolvedSurface(ctx) && (defaultSafety === undefined
    ? isAgentInitiatedApprovalRequiredByDefault(actionId)
    : policy?.agentDefault !== undefined);
}

/**
 * Generic approvals policy resolution rooted in persisted ActionsSettings.
 *
 * Notes:
 * - This answers “should this action be routed through approvals on this surface?”
 * - It does not decide enablement (use `isActionEnabledByActionsSettings` separately).
 * - Missing/unknown surfaces fail closed by applying the danger/egress floor. Known exposed
 *   surfaces use the dangerous default unless a persisted waiver explicitly opts out.
 */
export function isApprovalRequiredByActionsSettings(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation' | 'actionCaller'> | null,
  defaultSafety?: ActionSpec['safety'],
  /** Contributed Action manifest default, resolved by its shared admission owner. */
  contributedApprovalDefault?: boolean,
  input?: unknown,
  defaultUiConfirmation?: boolean,
  defaultConfirmation?: boolean,
): boolean {
  const requestActionId = ActionIdSchema.safeParse(actionId);
  if (requestActionId.success && !isActionApprovalWaivable(getActionSpec(requestActionId.data))) return true;
  const surface = resolveApprovalSurface(ctx);
  const rawSurface = ctx?.surface;
  const override: ActionSettingsOverride | undefined = settings.actions?.[actionId];
  const required = Array.isArray(override?.approvalRequiredSurfaces) ? override.approvalRequiredSurfaces : [];
  if (typeof rawSurface === 'string' && required.some((requiredSurface) => requiredSurface === rawSurface)) return true;
  if (requestActionId.success && getActionSpec(requestActionId.data).approvalPolicy?.pluginCaptureWaiver === true) {
    return ctx?.surface !== 'plugin' || ctx.actionCaller?.kind !== 'plugin'
      || settings.pluginHostCaptureApprovalWaived?.includes(ctx.actionCaller.pluginId) !== true;
  }
  const waived = Array.isArray(settings.approvalWaivedSurfaces?.[actionId])
    ? settings.approvalWaivedSurfaces[actionId]
    : [];
  if (surface.kind !== 'ambiguous' && waived.includes(surface.surface)) return false;
  if (requestActionId.success && isAutomationApprovalRequestSurface(ctx?.surface, getActionSpec(requestActionId.data), input)
    && canRequestPresentUserApprovalForActionInputV1(getActionSpec(requestActionId.data), input)) return true;

  const builtInActionId = ActionIdSchema.safeParse(actionId);
  return builtInActionId.success
    ? defaultConfirmation === true || requiresDefaultApprovalFloor(builtInActionId.data, ctx, defaultSafety, input, defaultUiConfirmation)
    : contributedApprovalDefault === true;
}

/**
 * Fail-safe default when no approval-requirement signal is supplied (neither an explicit
 * `requiredByPolicy` boolean nor persisted `settings`). A host that never wired the approval
 * policy must NOT silently fall open for dangerous Actions: the surface-keyed danger floor
 * still applies on every recognized exposed surface. Unknown surfaces retain the fail-closed
 * result, while internal RPC has no human confirmation host.
 *
 * Centralized here (rather than coerced at the executor call site with `=== true`) so the safe
 * default is applied in exactly one place. F7 (Runtime Unification v2 finalization).
 */
function resolveUnwiredApprovalDefault(
  actionId: ActionId,
  context: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation'> | null | undefined,
  input?: unknown,
): boolean {
  return requiresDefaultApprovalFloor(actionId, context, undefined, input);
}

export function resolveActionApprovalRouting(args: ResolveActionApprovalRoutingArgs): ActionApprovalRoutingDecision {
  // A setup waiver authorizes an invocation, never a remembered human Trust decision.
  if (isProjectSetupTrustRequestV1(args.actionId, args.input) && args.context?.authority !== 'present_user'
    && args.context?.bypassApprovals !== true) return { required: true, flow: 'deferred', result: 'required' };
  const presentUserRequest = isAutomationApprovalRequestSurface(args.context?.surface, args.spec, args.input)
    && canRequestPresentUserApprovalForActionInputV1(args.spec, args.input);
  const computerAction = args.spec.approvalPolicy?.computerConsent === true;
  const computerConsent = computerAction && args.computerConsentGranted === true
    && args.context?.authority !== 'present_user' && args.context?.bypassApprovals !== true;
  const explicitComputerApproval = args.settings?.actions?.[args.actionId]?.approvalRequiredSurfaces
    .some(surface => surface === args.context?.surface) === true;
  const requiredByPolicy = computerConsent
    ? explicitComputerApproval
    : args.defaultConfirmation === true
    ? args.settings ? isApprovalRequiredByActionsSettings(args.actionId, args.settings, args.context,
      args.defaultSafety, undefined, args.input, args.defaultUiConfirmation, true) : true
    : typeof args.requiredByPolicy === 'boolean'
    ? args.requiredByPolicy
    : args.settings
      ? isApprovalRequiredByActionsSettings(args.actionId, args.settings, args.context, args.defaultSafety, undefined, args.input, args.defaultUiConfirmation)
      : presentUserRequest || (args.defaultSafety !== undefined || args.defaultUiConfirmation !== undefined
        ? requiresDefaultApprovalFloor(args.actionId, args.context, args.defaultSafety, args.input, args.defaultUiConfirmation)
        : resolveUnwiredApprovalDefault(args.actionId, args.context, args.input));
  // Waivers choose whether to request approval; execution authority remains
  // independently enforced by the executor before preparation or effects.
  const required = !isApprovalAction(args.actionId)
    && (args.context?.bypassApprovals === true
      ? false
      : !isActionApprovalWaivable(args.spec) || requiredByPolicy);

  // The public Action API reports a created approval artifact to its caller;
  // it cannot retain an HTTP or server-relay request as the blocking waiter.
  // UI ingress has the same lifecycle shape, including an automation-narrowed
  // Account carrier: its mounted continuation follows the Artifact and consumes
  // the replayed typed result,
  // while the original invocation returns immediately. CLI commands likewise
  // need the Artifact id before exiting, rather than a silent daemon HTTP
  // waiter whose response expires before a human can discover the approval.
  // Live-only custody is
  // the deliberate exception, on either side of the call: the exact invocation
  // stays as the blocking waiter because its raw result — or its raw
  // credential-bearing input — must never become durable Artifact custody.
  // Keep required-result metadata for replay/settlement, and leave Agent/MCP
  // blocking callers unchanged.
  const custodyStaysOnLiveInvocation = args.spec.approvalResultCustody === 'live_only'
    || args.spec.approvalInputCustody === 'live_only';
  // A mounted Settings field already owns an exact declaration/target intent.
  // Retain that same closure with the incumbent human waiter; Artifact replay
  // cannot restore a host-private field assertion. Other UI/CLI callers keep
  // their existing deferred custody.
  const retainPluginSettingsFieldIntent = args.context?.surface === 'ui'
    && (!args.context.actionCaller || args.context.actionCaller.kind === 'host')
    && typeof args.context.isPluginSettingsIntentCurrent === 'function'
    && args.spec.safety === 'danger'
    && args.spec.approvalPolicy?.retainUiFieldIntent === true;
  const mustReturnApprovalCustody = !custodyStaysOnLiveInvocation
    && (
      args.context?.surface === 'api'
      || args.context?.surface === 'cli'
      || args.context?.surface === 'ui'
      || args.defaultConfirmation === true
    );
  // A mounted native read retains interest, not the Machine's replay authority.
  // Its durable operands/result still belong to the exact daemon. The original
  // host waits for that recorded receipt and can withdraw its abandoned intent.
  const retainedNativeRead = args.retainHostOperationApproval === true
    && args.context?.surface === 'ui' && (!args.context.actionCaller || args.context.actionCaller.kind === 'host')
    && args.spec.sideEffectClass === 'read' && !custodyStaysOnLiveInvocation
    && resolveActionExecutionPlacementForInput(args.spec, args.input) === 'machine';
  const flow = required && (args.retainHostOperationApproval === true && !retainedNativeRead || retainPluginSettingsFieldIntent
    || custodyStaysOnLiveInvocation && args.spec.approval.flow === 'blocking')
    ? 'blocking'
    : required && (mustReturnApprovalCustody
    || (presentUserRequest && args.spec.approvalInputCustody !== 'live_only'))
    ? 'deferred'
    : resolveActionApprovalFlow(args.spec.approval);

  return {
    required,
    flow,
    result: args.spec.approval.result,
  };
}
