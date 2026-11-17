import { ACTION_IDS } from './actionIds.js';
import { WORKFLOW_TRIGGER_REMOVE_ACTION_ID } from './workflowTriggerActionIds.js';
import { resolveProfiledActionsSettingsV1, type ApprovalProfileResolutionV1, type ActionTargetApprovalV1 } from './approvalProfiles.js';
import { isAutomationApprovalRequestSurface, canRequestPresentUserApprovalForActionInputV1 } from './decisionAuthority.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import {
  type ActionApprovalScopeV1,
  type ActionSettingsActionId,
  type ActionsSettingsV1,
} from './actionSettings.js';
import { resolveActionApprovalFlow, type ActionApprovalFlow, type ActionApprovalResult } from './actionApprovalMetadata.js';
import { getActionSpec, resolveActionExecutionPlacementForInput, type ActionSpec } from './actionSpecs.js';
import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { isAgentOrUnresolvedSurface, resolveApprovalSurface, type ApprovalSurfaceResolution } from './actionApprovalSurface.js';
import { readBuiltInSettingDeclarationV1, readBuiltInSettingsPermissionChangingV1 } from './settings/settingsDeclarations.js';
import { isSettingsDeclarationWriteActionIdV1 } from './settingsDeclarationActionIdsV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { matchesApprovedOperationStepV1 } from './approvedOperationV1.js';
import { isApiTokenDeploymentGrantV1 } from '../auth/apiTokenGrant.js';
import type { WorkflowApprovedOperationV1 } from '../workflows/workflowDefinitionV1.js';
import { isHostAdmittedReviewedChildPolicyV1 } from './executor/deploymentRoleChild.js';
import { isHomeAdmittedPresentUserHostInvocation, isPresentUserHostInvocation } from './invocationAuthority.js';
import { readExplicitActionApprovalPreferenceFromSettingsV1 } from './actionApprovalPreference.js';
import { PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from './specs/projectSourcesActionIdsV1.js';
export { isSharedRequesterActionV1 } from './actionRequestAttributionV1.js';
export { isAgentOrUnresolvedSurface } from './actionApprovalSurface.js';

export type ActionApprovalRoutingDecision = Readonly<{
  required: boolean;
  /** Local product review, presented by the UI host without an approval Artifact. */
  uiConfirmationRequired?: true;
  /** Actual missing confidential operands or binding choices use their existing acquisition lifecycle. */
  inputRequired?: true;
  flow: ActionApprovalFlow;
  result: ActionApprovalResult;
  profile?: ApprovalProfileResolutionV1;
}>;

/** Host-private scope and live inheritance proved at admission; never persisted or caller-authored. */
export type ActionApprovalPolicyScopeV1 =
  | Extract<ActionApprovalScopeV1, { kind: 'machine' }>
  | (Extract<ActionApprovalScopeV1, { kind: 'environment' }> & Readonly<{ inheritedEnvironmentId?: string }>);

/** Host-private result of current Environment admission. */
export type ActionEnvironmentApprovalScopeAdmissionV1 = Readonly<{
  /** Retains the child identity and its admitted template. Null is an admitted global-only operation. */
  scope: Extract<ActionApprovalPolicyScopeV1, { kind: 'environment' }> | null;
  /** The admitted target's database agent level (D13), the AE 03 applier's Action-time target input. */
  targetApproval?: Pick<ActionTargetApprovalV1, 'databaseAgentLevel'>;
}>;

type ApprovalInvocationContext = Pick<ActionExecutorContext,
  'surface' | 'callerSurface' | 'authority' | 'presentUserConfirmation' | 'actionCaller'
  | 'externalActionCredential' | 'externalActionExecutionAuthorization' | 'rpcSessionAuthorization' | 'workflowTriggerMutationAdmission'>;

function isOwnUiInvocation(actionId: ActionSettingsActionId, ctx?: ApprovalInvocationContext | null): boolean {
  if (ctx?.surface !== 'ui' || ctx.callerSurface === 'foreign_session_html') return false;
  if (isPresentUserHostInvocation(ctx)) return true;
  const builtIn = ActionIdSchema.safeParse(actionId);
  return builtIn.success && isHomeAdmittedPresentUserHostInvocation(ctx, builtIn.data);
}

export type ResolveActionApprovalRoutingArgs = Readonly<{
  actionId: ActionId;
  /** Resolved contributed identity when the host Action delegates classification and Settings policy. */
  profileActionId?: ActionSettingsActionId;
  spec: ActionSpec;
  input?: unknown;
  settings?: ActionsSettingsV1 | null;
  /** Exact scope proved by the host's Action admission, never raw caller context. */
  approvalScope?: ActionApprovalPolicyScopeV1;
  /** Already admitted by the target owner; identity and scope come from this invocation. */
  targetApproval?: Pick<ActionTargetApprovalV1, 'databaseAgentLevel'>;
  context?: ApprovalInvocationContext & Pick<ActionExecutorContext, 'bypassApprovals' | 'isPluginSettingsIntentCurrent' | 'machineServiceLogsResource' | 'approvalProfileId' | 'approvalProfile' | 'approvalProfileTeamOrGroupDerived' | 'approvalProfileChange' | 'workflowTriggerMutationAdmission' | 'actionsSettings'> | null;
  requiredByPolicy?: boolean;
  /** Host fact: the receiving signed root owns this invocation's Ask, so the local host creates none. */
  approvalOwner?: 'receiver' | 'local';
  /** Explicit Artifact creation requests approval, independently of target execution defaults. */
  explicitApprovalRequest?: true;
  /** Prepared child review belongs to this parent; a parent waiver does not answer it. */
  childReviewRequired?: boolean;
  /** A consequence discovered by the host, independent of a configurable confirmation default. */
  reviewRequired?: boolean;
  /** The input owner still needs a choice; a boolean review answer cannot supply it. */
  inputRequired?: boolean;
  /** The executor's exact admitted review answers this operation's approval. Never caller input. */
  reviewAdmitted?: boolean;
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
  /** Private operation opened from current admitted Run storage, never caller input. */
  approvedOperation?: Pick<WorkflowApprovedOperationV1, 'parent' | 'steps'> | null;
}>;

/**
 * Person-class Actions default to Ask on the automation request surfaces (agent, MCP, plugin
 * and the declared carve-outs). Per-surface, never caller detection: CLI and UI follow their
 * own surface defaults, and a saved waiver above this check lets the call run (owner ruling
 * 2026-10-29, no present-user floors).
 */
function defaultsPersonClassActionToAsk(
  ctx: Pick<ActionExecutorContext, 'surface'> | null | undefined,
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority' | 'approvalInputCustody'>,
  input: unknown,
): boolean {
  return canRequestPresentUserApprovalForActionInputV1(spec, input)
    && isAutomationApprovalRequestSurface(ctx?.surface, spec, input);
}

/** Consequential Settings are declared (sensitive, or explicit `agentSafety: 'danger'`); unannotated ones are not. */
function isNonConsequentialSettingDeclaration(anchor: unknown): boolean {
  const declaration = readBuiltInSettingDeclarationV1(anchor);
  return declaration !== null && declaration.sensitive === false && declaration.agentSafety !== 'danger';
}

function isApprovalAction(actionId: ActionId): boolean {
  return getActionSpec(actionId).approvalPolicy?.control === true;
}

/**
 * Published projections of the declaration-owned confirmation defaults. They are derived on
 * first read: importing approval policy must not resolve every Action spec (module top level
 * stays cheap to evaluate).
 */
export const EGRESS_SENSITIVE_AGENT_FLOOR: readonly ActionId[] = lazyActionSpecArray(() => Object.freeze(
  ACTION_IDS.filter(id => getActionSpec(id).approvalPolicy?.agentDefault === "egress")));
export const SURFACE_AUTHORITY_AGENT_FLOOR: readonly ActionId[] = lazyActionSpecArray(() => Object.freeze(
  ACTION_IDS.filter(id => getActionSpec(id).approvalPolicy?.agentDefault === "authority")));
export const AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS: readonly ActionId[] = lazyActionSpecArray(() => Object.freeze(
  ACTION_IDS.filter(isAgentInitiatedApprovalRequiredByDefault)));

/**
 * True when an Action result leaving the host on this surface must be redacted before it can
 * egress to an agent turn — the canonical owner of the egress-surface question (INV-1 / DEC-2).
 *
 * This resolves the agent trust boundary for result redaction. MCP also shares agent approval
 * defaults, but retains its own result delivery. This replaced two hand-rolled
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
    || (spec.safety === 'danger' && spec.surfaces.agent === true);
}

function requiresDefaultApprovalFloor(
  actionId: ActionId,
  ctx?: ApprovalInvocationContext | null,
  defaultSafety?: ActionSpec['safety'],
  input?: unknown,
): boolean {
  const surface = resolveApprovalSurface(ctx);
  const spec = getActionSpec(actionId);
  const policy = spec.approvalPolicy;
  const safety = defaultSafety ?? spec.safetyForInput?.(input) ?? spec.safety;
  // The person's own UI press answers the automation approval floor. Product
  // confirmations are a separate fact consumed only by the UI host below.
  if (isOwnUiInvocation(actionId, ctx)) return false;
  if (policy?.pluginCaptureWaiver === true) return true;
  // Permission answers share the Agent default on MCP too; persisted surface
  // waivers remain resolved by the same ActionsSettings owner above this floor.
  if (surface.kind !== 'ambiguous' && policy?.requiredSurfaces?.includes(surface.surface)) return true;
  // Admitted Run cleanup retains its consent; the trigger owner restricts it
  // to the exact firing trigger (FIN 03 §5.7). Ordinary own/led Session access
  // authorizes execution but does not answer the dangerous Action's Ask default.
  if (actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID
    && ctx?.workflowTriggerMutationAdmission?.actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID
    && ctx.workflowTriggerMutationAdmission.exactFiringCleanup !== undefined) return false;
  // Present-person hosts suppress the duplicate default after a completed
  // confirmation for this exact Action. Explicit settings are evaluated first
  // and still win.
  if (
    surface.kind === 'non_agent'
    && ctx && isPresentUserHostInvocation(ctx)
    && ctx.presentUserConfirmation?.actionId === actionId
  ) {
    return false;
  }
  // A Voice Settings write needs the person's answer even when its reversible input
  // is safe. Spoken confirmation answers this above; without delegation the
  // existing approval request supplies the one-tap answer (owner 2026-10-30).
  if (surface.kind === 'non_agent' && surface.surface === 'voice'
    && isSettingsDeclarationWriteActionIdV1(actionId)) return true;
  // CLI surface default (owner ruling 2026-10-29: per-Action, per-surface; the CLI asks only for
  // consequential Actions). A Settings write is direct unless its declaration is consequential
  // (permission-changing or sensitive). Keyed on the surface only, never on who is calling.
  if (surface.kind === 'non_agent' && surface.surface === 'cli' && isSettingsDeclarationWriteActionIdV1(actionId)
    && !readBuiltInSettingsPermissionChangingV1(input) && isNonConsequentialSettingDeclaration(readRecord(input).anchor)) {
    return false;
  }
  if (safety === 'danger') {
    if (surface.kind === 'ambiguous') return true;
    // General RPC remains an internal transport surface. These new semantic
    // filesystem methods are directly reachable effect entry points, however,
    // and use the same configurable Ask-first owner as their other surfaces.
    // Released unrooted aliases retain their separate incumbent admission path.
    if (surface.surface !== 'rpc' || policy?.rpcConfirmation === true) {
      return spec.surfaces[surface.surface] === true;
    }
  }
  // Agent and external MCP share the declared agent default once here. Surface
  // Require/Waive preferences are resolved above this floor (owner 2026-10-12/29).
  return sharesAgentApprovalDefault(surface)
    && (policy?.agentDefault !== undefined || policy?.agentDefaultForInput?.(input) === true);
}

function sharesAgentApprovalDefault(surface: ApprovalSurfaceResolution): boolean {
  return surface.kind !== 'non_agent' || surface.surface === 'mcp';
}

/**
 * True when this surface's inherited answer asks only for some inputs (a declared
 * `agentDefaultForInput` consequence). Settings presents that default and lets the person
 * waive it explicitly, because the input-free answer alone reads as "does not ask".
 */
export function hasInputDependentAgentApprovalDefaultV1(
  actionId: ActionSettingsActionId,
  ctx?: Readonly<{ surface?: ActionExecutorContext['surface'] | null }> | null,
): boolean {
  const builtIn = ActionIdSchema.safeParse(actionId);
  return builtIn.success && getActionSpec(builtIn.data).approvalPolicy?.agentDefaultForInput !== undefined
    && sharesAgentApprovalDefault(resolveApprovalSurface(ctx));
}

/**
 * Generic approvals policy resolution rooted in persisted ActionsSettings.
 *
 * Notes:
 * - This answers “should this action be routed through approvals on this surface?”
 * - It does not decide enablement (use `isActionEnabledByActionsSettings` separately).
 * - Missing/unknown surfaces retain the danger/egress floor. A trusted person's direct UI
 *   interaction answers Account Ask; designed confirmations and host-discovered consequences still apply.
 */
export function isApprovalRequiredByActionsSettings(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: ApprovalInvocationContext | null,
  defaultSafety?: ActionSpec['safety'],
  /** Contributed Action manifest default, resolved by its shared admission owner. */
  contributedApprovalDefault?: boolean,
  input?: unknown,
  _defaultUiConfirmation?: boolean,
  defaultConfirmation?: boolean,
  approvedOperation?: Pick<WorkflowApprovedOperationV1, 'parent' | 'steps'> | null,
  approvalScope?: ActionApprovalPolicyScopeV1,
): boolean {
  // The parent owner admitted this exact role at its natural
  // preparation boundary. It is not a new independently approvable operation.
  if (isHostAdmittedReviewedChildPolicyV1(approvedOperation, actionId, input)) return false;
  const requestActionId = ActionIdSchema.safeParse(actionId);
  const explicit = readExplicitActionApprovalPreferenceV1(actionId, settings, ctx, approvalScope);
  if (explicit !== undefined) return explicit;
  if (requestActionId.success && getActionSpec(requestActionId.data).approvalPolicy?.pluginCaptureWaiver === true) {
    return ctx?.surface !== 'plugin' || ctx.actionCaller?.kind !== 'plugin'
      || settings.pluginHostCaptureApprovalWaived?.includes(ctx.actionCaller.pluginId) !== true;
  }
  if (requestActionId.success && defaultsPersonClassActionToAsk(ctx, getActionSpec(requestActionId.data), input)) return true;

  // The receiving host has opened the current Run/step through its admitted
  // storage boundary. Only this exact effect receives the parent's consent;
  // explicit Settings Require and nonwaivable authority remain above it.
  // Saved variable bindings become execution consent only after host materialization.
  if (approvedOperation?.steps.some(step => step.binding === undefined
    && matchesApprovedOperationStepV1(step, actionId, input))) return false;

  // The person saved this choice on the credential's exact Environment grant.
  // Environment edits, including protection, do not withdraw that consent.
  const grant = ctx?.externalActionCredential?.grant;
  if (actionId === 'deployments.deploy' && grant?.deployApproval === 'automatic'
    && isApiTokenDeploymentGrantV1(grant)
    && grant.targets?.environments?.[0] === readRecord(input).environmentId) return false;

  const builtInActionId = ActionIdSchema.safeParse(actionId);
  return builtInActionId.success
    ? defaultConfirmation === true || requiresDefaultApprovalFloor(builtInActionId.data, ctx, defaultSafety, input)
    : contributedApprovalDefault === true;
}

/** The explicit preference layer, shared by root preparation and ordinary execution. */
export function readExplicitActionApprovalPreferenceV1(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: ApprovalInvocationContext | null,
  approvalScope?: ActionApprovalPolicyScopeV1,
): boolean | undefined {
  const builtIn = ActionIdSchema.safeParse(actionId);
  const ignoreGlobalWaiver = builtIn.success && getActionSpec(builtIn.data).approvalPolicy?.pluginCaptureWaiver === true;
  return readExplicitActionApprovalPreferenceFromSettingsV1(actionId, settings, ctx, approvalScope, ignoreGlobalWaiver);
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
  context: ApprovalInvocationContext | null | undefined,
  input?: unknown,
): boolean {
  return requiresDefaultApprovalFloor(actionId, context, undefined, input);
}

export function resolveActionApprovalRouting(args: ResolveActionApprovalRoutingArgs): ActionApprovalRoutingDecision {
  const policy = args.spec.approvalPolicy;
  const policyActionId = args.profileActionId ?? args.actionId;
  // The caller's approval profile replaces the Account rows of the Actions it names. Everything
  // below decides once on the merged settings, with the same floors and person-class defaults.
  const profiled = args.settings ? resolveProfiledActionsSettingsV1(args.settings, args.context?.approvalProfileId, {
    actionId: policyActionId,
    boundProfile: args.context?.approvalProfile,
    approvalProfileTeamOrGroupDerived: args.context?.approvalProfileTeamOrGroupDerived,
    context: args.context ?? undefined,
    ...(args.targetApproval ? { targetApproval: { actionId: policyActionId,
      databaseAgentLevel: args.targetApproval.databaseAgentLevel, approvalScope: args.approvalScope } } : {}),
  }) : undefined;
  const settings = profiled?.settings ?? args.settings;
  const profile = profiled?.profile ?? (args.context?.approvalProfileId
    ? { status: 'missing' as const, requestedId: args.context.approvalProfileId } : undefined);
  const ownUiInvocation = isOwnUiInvocation(args.actionId, args.context);
  const explicitPreference = ownUiInvocation && settings ? readExplicitActionApprovalPreferenceV1(
    policyActionId, settings, args.context, args.approvalScope) : undefined;
  // Changing the carrier must not escape its selected profile through a broad
  // child-start/Run-control waiver. All carriers share the existing profile
  // control's preference and surface defaults, at this one routing owner.
  const input = readRecord(args.input);
  const runProfileControl = args.actionId === 'execution.run.action' && input.actionId === 'approval_profile.set';
  const projectDefaultChange = args.actionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1;
  const projectDefaults = projectDefaultChange ? readRecord(readRecord(input.patch).sessionDefaults).defaults : undefined;
  const referenceInput = runProfileControl ? readRecord(input.input)
    : projectDefaultChange ? readRecord(projectDefaults)
    : args.actionId === 'workflow.trigger.update' ? readRecord(input.patch) : input;
  const reference = projectDefaults === null ? null : referenceInput.approvalProfileId;
  const differsFromInherited = (value: unknown) => (value === null || typeof value === 'string')
    && (value !== (args.context?.approvalProfileId ?? null)
      // Accepting an inherited id clears tighten-only just as choosing another id does.
      || !projectDefaultChange && typeof value === 'string' && args.context?.approvalProfileTeamOrGroupDerived === true);
  // Editing a profile's rows or a Machine default changes what a running Session's profile means.
  const triggerMutation = args.context?.workflowTriggerMutationAdmission;
  const changesProfile = args.context?.approvalProfileChange === true || runProfileControl
    || triggerMutation?.actionId === args.actionId && triggerMutation.changesProfile
    || (args.actionId === 'actions.policy.set' && input.profileChange !== undefined)
    || differsFromInherited(reference)
    || (args.actionId === 'session.spawn_new' && Array.isArray(input.initialTriggers)
      && input.initialTriggers.some(trigger => differsFromInherited(readRecord(trigger).approvalProfileId)));
  // Account settings decide who may change profiles, never the profile being escaped.
  const profileControlRequired = !args.reviewAdmitted && changesProfile
    && isApprovalRequiredByActionsSettings('session.approval_profile.set', args.settings ?? { v: 1, actions: {} },
      args.context, undefined, undefined, args.input, undefined, undefined, undefined, args.approvalScope);
  // The person's profile-control Ask joins the carrier's native confirmation;
  // a carrier waiver cannot waive that consequence or create self-approval.
  const preparedReviewRequired = args.reviewRequired === true && !args.reviewAdmitted;
  const uiConfirmationRequired = !args.inputRequired && ownUiInvocation && (preparedReviewRequired
    || !args.reviewAdmitted && !args.context?.bypassApprovals
    && (args.requiredByPolicy === true || args.childReviewRequired || profileControlRequired || explicitPreference === true
      // A legacy marker answers only the default; exact admitted consent answers Ask above.
      || explicitPreference !== false && args.context?.presentUserConfirmation?.actionId !== args.actionId
      && (args.defaultUiConfirmation ?? policy?.uiConfirmationForInput?.(args.input)
        ?? (policy?.uiConfirmation === 'policy'
          || policy?.uiConfirmation !== 'direct' && args.spec.irreversible === true
          || args.defaultSafety === 'danger' || args.defaultConfirmation === true))));
  const presentUserRequest = defaultsPersonClassActionToAsk(args.context, args.spec, args.input);
  const computerAction = args.spec.approvalPolicy?.computerConsent === true;
  const computerConsent = computerAction && args.computerConsentGranted === true
    && args.context?.authority !== 'present_user' && args.context?.bypassApprovals !== true;
  const explicitComputerApproval = settings?.actions?.[args.actionId]?.approvalRequiredSurfaces
    .some(surface => surface === args.context?.surface) === true;
  const hasPolicyContext = Boolean(settings || args.approvedOperation || args.context?.externalActionCredential);
  // The person's exact completed review answers Ask, including a saved preference.
  // The executor withholds this admission when a new child consequence needs review.
  const requiredByPolicy = args.reviewAdmitted === true || ownUiInvocation
    ? false
    : args.requiredByPolicy === true ? true : computerConsent
    ? explicitComputerApproval
    : args.defaultConfirmation === true
    ? hasPolicyContext ? isApprovalRequiredByActionsSettings(policyActionId, settings ?? { v: 1, actions: {} }, args.context,
      args.defaultSafety, args.defaultConfirmation, args.input, args.defaultUiConfirmation, true, args.approvedOperation, args.approvalScope) : true
    : typeof args.requiredByPolicy === 'boolean'
    ? args.requiredByPolicy
    : args.approvalOwner === 'receiver'
    ? false
    : hasPolicyContext
      ? isApprovalRequiredByActionsSettings(policyActionId, settings ?? { v: 1, actions: {} }, args.context, args.defaultSafety, args.defaultConfirmation, args.input, args.defaultUiConfirmation, undefined, args.approvedOperation, args.approvalScope)
      : presentUserRequest || (args.defaultSafety !== undefined || args.defaultUiConfirmation !== undefined
        ? requiresDefaultApprovalFloor(args.actionId, args.context, args.defaultSafety, args.input)
        : resolveUnwiredApprovalDefault(args.actionId, args.context, args.input));
  // Approval replay answers the admitted operation once; a profile is never a new authority.
  const required = !isApprovalAction(args.actionId)
    && (args.inputRequired || !ownUiInvocation && preparedReviewRequired || (args.context?.bypassApprovals === true
      ? false
      : requiredByPolicy || (!ownUiInvocation && profileControlRequired)));

  // The public Action API reports a created approval artifact to its caller;
  // it cannot retain an HTTP or server-relay request as the blocking waiter.
  // UI ingress has the same lifecycle shape, including an automation-narrowed
  // Account carrier: its mounted continuation follows the Artifact and consumes
  // the replayed typed result,
  // while the original invocation returns immediately. CLI commands likewise
  // need the Artifact id before exiting, rather than a silent daemon HTTP
  // waiter whose response expires before a human can discover the approval.
  // Private inputs keep the exact invocation. A live-only result stays there
  // only for the original person; automated durable-input requests defer so
  // the deciding person receives the fresh result on their approval screen.
  // Keep required-result metadata for replay/settlement. Durable Agent/MCP
  // requests also return the Artifact unless this host retains live custody.
  // Explicit proposal creation returns an Artifact and has no target invocation to retain.
  const originalPersonOwnsLiveResult = args.explicitApprovalRequest !== true && !!args.context
    && (isPresentUserHostInvocation(args.context)
    || isHomeAdmittedPresentUserHostInvocation(args.context, args.actionId));
  const custodyStaysOnLiveInvocation = args.spec.approvalInputCustody === 'live_only'
    || args.spec.approvalResultCustody === 'live_only' && originalPersonOwnsLiveResult;
  // A mounted Settings field already owns an exact declaration/target intent.
  // Retain that same closure with the incumbent human waiter; Artifact replay
  // cannot restore a host-private field assertion. Other UI/CLI callers keep
  // their existing deferred custody.
  const retainPluginSettingsFieldIntent = args.context?.surface === 'ui'
    && (!args.context.actionCaller || args.context.actionCaller.kind === 'host')
    && typeof args.context.isPluginSettingsIntentCurrent === 'function'
    && args.spec.safety === 'danger'
    && args.spec.approvalPolicy?.retainUiFieldIntent === true;
  // A mounted native read retains interest, not the Machine's replay authority.
  // Its durable operands/result still belong to the exact daemon. The original
  // host waits for that recorded receipt and can withdraw its abandoned intent.
  const retainedNativeRead = args.retainHostOperationApproval === true
    && args.context?.surface === 'ui' && (!args.context.actionCaller || args.context.actionCaller.kind === 'host')
    && args.spec.sideEffectClass === 'read' && !custodyStaysOnLiveInvocation
    && resolveActionExecutionPlacementForInput(args.spec, args.input, args.context.actionCaller, args.context.surface) === 'machine'
    // The Resource observation cannot be reconstructed by detached Artifact
    // replay. Only its executor-proved live invocation retains that callback.
    && !(args.actionId === 'machines.services.logs.read' && args.context.machineServiceLogsResource);
  const retainsLiveInvocation = custodyStaysOnLiveInvocation || retainPluginSettingsFieldIntent
    || args.retainHostOperationApproval === true && !retainedNativeRead;
  const flow = args.inputRequired || preparedReviewRequired ? 'deferred' : required || args.explicitApprovalRequest ? retainsLiveInvocation ? 'blocking' : 'deferred'
    : resolveActionApprovalFlow(args.spec.approval);

  return {
    required: required === true,
    ...(uiConfirmationRequired ? { uiConfirmationRequired: true as const } : {}),
    ...(args.inputRequired ? { inputRequired: true as const } : {}),
    flow,
    result: args.inputRequired || preparedReviewRequired ? 'required' : args.spec.approval.result,
    ...(profile ? { profile } : {}),
  };
}
