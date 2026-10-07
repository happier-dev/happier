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
import { getActionSpec, type ActionSpec, type ActionSurfaces } from './actionSpecs.js';
import { readWidgetActionSurfaceV1, readWidgetActionDestinationV1 } from '../widgets/actionsV1.js';

export type ActionApprovalRoutingDecision = Readonly<{
  required: boolean;
  flow: ActionApprovalFlow;
  result: ActionApprovalResult;
}>;

export type ResolveActionApprovalRoutingArgs = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  input?: unknown;
  settings?: ActionsSettingsV1 | null;
  context?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation' | 'bypassApprovals' | 'actionCaller'> | null;
  requiredByPolicy?: boolean;
  /** Host-proved contextual classification; overrides cannot waive mandatory Agent trigger approval. */
  defaultSafety?: ActionSpec['safety'];
  /** Fresh computer-owner consent, never a caller-authored grant. */
  computerConsentGranted?: boolean;
}>;

function isApprovalAction(actionId: ActionId): boolean {
  return actionId === 'approval.request.list'
    || actionId === 'approval.request.get'
    || actionId === 'approval.request.create'
    || actionId === 'approval.request.decide';
}

/**
 * Non-danger egress-sensitive leaves that must reach human consent on `agent` even though
 * their `safety` is `'safe'`. These capture page/region/element pixels or summaries that egress to
 * the composer/agent turn (or expose/copy public URLs), so the agent-initiated forms are
 * approval-floored.
 *
 * RESERVED for non-danger egress leaves ONLY. Mutating/navigating/danger actions must NOT be added
 * here — they are classified `safety: 'danger'` in the actionSpecs danger SSOT and are picked up
 * automatically by the danger-floor derivation below. Keeping that split preserves the single
 * source of truth (CON-2: do not hand-add browser verbs to this const).
 *
 * Annotation `start`/`cancel` + `attachComment`/`attachStroke`/`attachStyleIntent` are local
 * UI-state edits with no page egress and stay unprompted.
 */
export const EGRESS_SENSITIVE_AGENT_FLOOR = [
  'artifact.public_link.audit',
  'computer.targets.list',
  'computer.capture',
  'computer.query',
  'browser.context.capturePage',
  'browser.context.captureScreenshot',
  'browser.context.captureSelectedElement',
  'browser.context.captureNetworkSummary',
  'browser.context.captureConsoleSummary',
  'browser.context.annotation.captureRegion',
  'browser.context.annotation.captureElement',
  'browser.context.attachToComposer',
  'browser.context.attachToAgentTurn',
  'browser.recording.attachToComposer',
  'localServices.publicPreview.status',
  'localServices.publicPreview.copyUrl',
] as const satisfies readonly ActionId[];

/** Safe authority transitions still require a human decision by default on the agent surface. */
export const SURFACE_AUTHORITY_AGENT_FLOOR = [
  'session.permission.respond',
  'computer.permissions.openSettings',
  'browser.control.takeControl',
  'browser.control.handBack',
  'computer.target.select',
  'computer.control.interrupt',
  'computer.control.handBack',
] as const satisfies readonly ActionId[];

// FIN 03 §5.4/§5.7: scoped removal is direct after own/led Session or exact
// originating-trigger admission. Its danger metadata still fails ambiguous callers closed.
const SCOPED_SESSION_TRIGGER_APPROVAL_EXEMPT_ACTION_ID = 'session.trigger.remove' satisfies ActionId;

/**
 * The danger floor, DERIVED from the actionSpecs danger SSOT: every action that is both
 * `safety: 'danger'` and surfaced on `agent` requires human consent by default when
 * initiated through the agent surface, except the approved scoped Session-trigger removal.
 * Marking any other `agent` action as `safety: 'danger'` floors it automatically
 * (CON-1/CON-2/CON-3).
 *
 * This intentionally uses the full action catalog, not only `RUNTIME_ACTION_IDS_V1`: LIVE-1 caught
 * `prompt_doc.update`, a dangerous Session agent prompt-library action that still needs the same
 * consent floor even though it is not part of the runtime-action family.
 */
const DERIVED_DANGER_AGENT_FLOOR_IDS: readonly ActionId[] = ACTION_IDS.filter(
  (id) => {
    const spec = getActionSpec(id);
    return spec.safety === 'danger' && spec.surfaces.agent === true
      && id !== SCOPED_SESSION_TRIGGER_APPROVAL_EXEMPT_ACTION_ID;
  },
);

/**
 * The effective agent-initiated approval floor: the derived danger floor UNIONED with the
 * non-danger egress floor. Excluding the approved scoped-removal exception, the
 * danger ∩ agent subset is contained in the floor, which also includes safe egress.
 *
 * Per FINALIZATION-PLAN §4.2 / §12.8 / §15-Δ1 / §16-Δ1 this is a SURFACE-KEYED default — NOT a
 * global `RESULT_REQUIRED_APPROVAL_ACTION_IDS` addition (that set is a blocking-result contract,
 * not a human-approval gate). Human approval is decided here, via the persisted
 * surface-keyed ActionsSettings policy: dangerous exposed Actions prompt by default on every
 * user-configurable surface except scoped removal, while non-danger egress forms remain agent-gated.
 *
 * Persisted overrides may require or explicitly waive default confirmation on a known surface;
 * Agent Workflow trigger writes retain the mandatory rule below.
 * Missing or malformed policy retains this default. Egress redaction is independent.
 *
 * Note: `network.intercept` (named in §4.2) is a plugin GRANT capability, not an ActionSpec id,
 * so it is gated by the durable plugin-grants store (§12.2), not by this approval policy.
 */
export const AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS: readonly ActionId[] = [
  ...DERIVED_DANGER_AGENT_FLOOR_IDS,
  ...EGRESS_SENSITIVE_AGENT_FLOOR,
  ...SURFACE_AUTHORITY_AGENT_FLOOR,
];

/**
 * Dangerous Actions are confirmation-floored on every user-configurable surface
 * where the Action is actually exposed. This is separate from the agent egress
 * floor above: safe capture/egress Actions remain agent-only, while destructive
 * Actions keep the same default-on, user-overridable confirmation contract for
 * UI, CLI, MCP, API, plugin, voice, and Agent callers.
 */
const DANGEROUS_ACTION_APPROVAL_REQUIRED_ACTION_ID_SET: ReadonlySet<ActionId> = new Set(
  ACTION_IDS.filter((id) => getActionSpec(id).safety === 'danger'),
);

const AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_ID_SET: ReadonlySet<ActionId> = new Set(
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
);

/**
 * Dangerous Actions whose product-UI invocation has no direct present-user
 * confirmation host of its own, so their confirmation IS this policy's default:
 * required on the present-user UI too, and waivable only through Actions
 * settings. The present-user UI suppression below assumes a UI-local host; these
 * rows do not have one, and must not grow one (no picker-local prompt, no
 * domain approval resolver).
 *
 * - `session.responsibility.set`: teams-lane-04/11-responsible-assignment.md
 *   §7.1 — "Dangerous mutation confirmation is required by default and may be
 *   explicitly disabled by the user in the canonical Actions policy."
 * - Shared Board edits, definition edits/deletion and frozen snapshot publication:
 *   widgets-platform §4 — the same configurable policy owns their UI approval.
 */
const PRESENT_USER_UI_POLICY_CONFIRMED_ACTION_ID_SET: ReadonlySet<ActionId> = new Set<ActionId>([
  'session.responsibility.set',
  'session.reports_to.set',
  'session.board.item.upsert',
  'session.board.layout.update',
  'widgets.definition.update',
  'widgets.definition.delete',
  'widgets.snapshot.post',
]);

function usesPresentUserUiPolicyConfirmation(actionId: ActionId, input: unknown): boolean {
  if (PRESENT_USER_UI_POLICY_CONFIRMED_ACTION_ID_SET.has(actionId)) return true;
  if (!actionId.startsWith('widgets.instance.') || getActionSpec(actionId).safety !== 'danger') return false;
  const surface = readWidgetActionSurfaceV1(input);
  const destination = actionId === 'widgets.instance.move' ? readWidgetActionDestinationV1(input) : null;
  // Missing target facts cannot establish that a write is only personal. The
  // executor supplies admitted input; Home/Companion inherit their safe owner policy.
  return !surface || surface.owner.kind === 'sessionBoard' || destination?.owner.kind === 'sessionBoard';
}

type ActionSurfaceKey = keyof ActionSurfaces;
type NonAgentActionSurfaceKey = Exclude<ActionSurfaceKey, 'agent'>;

const NON_AGENT_ACTION_SURFACE_KEY_RECORD = {
  ui: true,
  voice: true,
  mcp: true,
  cli: true,
  rpc: true,
  api: true,
  plugin: true,
} satisfies Record<NonAgentActionSurfaceKey, true>;

const NON_AGENT_ACTION_SURFACE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(NON_AGENT_ACTION_SURFACE_KEY_RECORD),
);

type ApprovalSurfaceResolution =
  | Readonly<{ kind: 'agent'; surface: 'agent' }>
  | Readonly<{ kind: 'non_agent'; surface: NonAgentActionSurfaceKey }>
  | Readonly<{ kind: 'ambiguous' }>;

function resolveApprovalSurface(
  ctx?: Pick<ActionExecutorContext, 'surface'> | null,
): ApprovalSurfaceResolution {
  const surface: unknown = ctx?.surface ?? null;
  if (surface === 'agent') return { kind: 'agent', surface };
  if (typeof surface === 'string' && NON_AGENT_ACTION_SURFACE_KEYS.has(surface)) {
    return { kind: 'non_agent', surface: surface as NonAgentActionSurfaceKey };
  }
  return { kind: 'ambiguous' };
}

/**
 * The single fail-closed surface test shared by every agent trust-boundary decision: the caller
 * is the agent, or the surface could not be resolved and is therefore treated as the agent.
 * Only an explicitly recognised non-agent surface (`ui`/`voice`/`mcp`/`cli`/`rpc`/`api`/`plugin`)
 * escapes it.
 */
function isAgentOrUnresolvedSurface(
  ctx?: Pick<ActionExecutorContext, 'surface'> | null,
): boolean {
  const surface = resolveApprovalSurface(ctx);
  return surface.kind === 'agent' || surface.kind === 'ambiguous';
}

/** Account-level trigger writes always require human approval for agent callers (FIN 03 §5.4). */
function requiresWorkflowTriggerAgentApproval(
  actionId: ActionSettingsActionId,
  ctx?: Pick<ActionExecutorContext, 'surface'> | null,
): boolean {
  return isAgentOrUnresolvedSurface(ctx) && (actionId === 'workflow.trigger.add'
    || actionId === 'workflow.trigger.update' || actionId === 'workflow.trigger.remove');
}

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
  return AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_ID_SET.has(actionId);
}

function requiresDefaultApprovalFloor(
  actionId: ActionId,
  ctx?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation'> | null,
  defaultSafety?: ActionSpec['safety'],
  input?: unknown,
): boolean {
  const surface = resolveApprovalSurface(ctx);
  if (actionId === 'capture.view') return true;
  // Permission answers share the Agent default on MCP too; persisted surface
  // waivers remain resolved by the same ActionsSettings owner above this floor.
  if (actionId === 'session.permission.respond' && surface.kind === 'non_agent' && surface.surface === 'mcp') return true;
  // Scoped removal is dangerous metadata, but its own/led Session policy owns
  // admission (FIN 03 §5.4/§5.7); it does not acquire the Account trigger approval floor.
  if (actionId === SCOPED_SESSION_TRIGGER_APPROVAL_EXEMPT_ACTION_ID && surface.kind !== 'ambiguous') return false;
  // UI owns a direct present-user confirmation host for its ordinary dangerous
  // Actions, except the rows whose confirmation is this policy's own default.
  // CLI suppresses the duplicate default only when its host records a completed
  // confirmation for this exact Action. Explicit settings are evaluated first
  // and still win.
  if (
    surface.kind === 'non_agent'
    && (
      (surface.surface === 'ui' && !usesPresentUserUiPolicyConfirmation(actionId, input))
      || (surface.surface === 'cli' && ctx?.presentUserConfirmation?.actionId === actionId)
    )
    && ctx?.authority === 'present_user'
  ) {
    return false;
  }
  if (defaultSafety === 'danger' || (defaultSafety === undefined && DANGEROUS_ACTION_APPROVAL_REQUIRED_ACTION_ID_SET.has(actionId))) {
    if (surface.kind === 'ambiguous') return true;
    // RPC is an internal transport surface; it has no human confirmation host.
    if (surface.surface !== 'rpc') {
      return getActionSpec(actionId).surfaces[surface.surface] === true;
    }
  }
  return isAgentOrUnresolvedSurface(ctx) && (defaultSafety === undefined
    ? isAgentInitiatedApprovalRequiredByDefault(actionId)
    : [...EGRESS_SENSITIVE_AGENT_FLOOR, ...SURFACE_AUTHORITY_AGENT_FLOOR].some((id) => id === actionId));
}

/**
 * Generic approvals policy resolution rooted in persisted ActionsSettings.
 *
 * Notes:
 * - This answers “should this action be routed through approvals on this surface?”
 * - It does not decide enablement (use `isActionEnabledByActionsSettings` separately).
 * - Missing/unknown surfaces fail closed by applying the danger/egress floor. Known exposed
 *   surfaces use the dangerous default unless a persisted waiver explicitly opts out.
 * - Agent Workflow trigger writes require approval independently of that default policy.
 */
export function isApprovalRequiredByActionsSettings(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: Pick<ActionExecutorContext, 'surface' | 'authority' | 'presentUserConfirmation' | 'actionCaller'> | null,
  defaultSafety?: ActionSpec['safety'],
  /** Contributed Action manifest default, resolved by its shared admission owner. */
  contributedApprovalDefault?: boolean,
  input?: unknown,
): boolean {
  const requestActionId = ActionIdSchema.safeParse(actionId);
  if (isAutomationApprovalRequestSurface(ctx?.surface) && requestActionId.success
    && canRequestPresentUserApprovalForActionInputV1(getActionSpec(requestActionId.data), input)) return true;
  if (requiresWorkflowTriggerAgentApproval(actionId, ctx)) return true;
  const surface = resolveApprovalSurface(ctx);
  const rawSurface = ctx?.surface;
  const override: ActionSettingsOverride | undefined = settings.actions?.[actionId];
  const required = Array.isArray(override?.approvalRequiredSurfaces) ? override.approvalRequiredSurfaces : [];
  if (typeof rawSurface === 'string' && required.some((requiredSurface) => requiredSurface === rawSurface)) return true;
  if (actionId === 'capture.view') {
    return ctx?.surface !== 'plugin' || ctx.actionCaller?.kind !== 'plugin'
      || settings.pluginHostCaptureApprovalWaived?.includes(ctx.actionCaller.pluginId) !== true;
  }
  const waived = Array.isArray(settings.approvalWaivedSurfaces?.[actionId])
    ? settings.approvalWaivedSurfaces[actionId]
    : [];
  if (surface.kind !== 'ambiguous' && waived.includes(surface.surface)) return false;

  const builtInActionId = ActionIdSchema.safeParse(actionId);
  return builtInActionId.success
    ? requiresDefaultApprovalFloor(builtInActionId.data, ctx, defaultSafety, input)
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
  const presentUserRequest = isAutomationApprovalRequestSurface(args.context?.surface)
    && canRequestPresentUserApprovalForActionInputV1(args.spec, args.input);
  const computerAction = args.actionId === 'computer.capture' || args.actionId === 'computer.query' || args.actionId === 'computer.input';
  const computerConsent = computerAction && args.computerConsentGranted === true
    && args.context?.authority !== 'present_user' && args.context?.bypassApprovals !== true;
  const explicitComputerApproval = args.settings?.actions?.[args.actionId]?.approvalRequiredSurfaces
    .some(surface => surface === args.context?.surface) === true;
  const requiredByPolicy = computerConsent
    ? explicitComputerApproval
    : typeof args.requiredByPolicy === 'boolean'
    ? args.requiredByPolicy
    : args.settings
      ? isApprovalRequiredByActionsSettings(args.actionId, args.settings, args.context, args.defaultSafety, undefined, args.input)
      : args.defaultSafety !== undefined
        ? requiresDefaultApprovalFloor(args.actionId, args.context, args.defaultSafety, args.input)
        : resolveUnwiredApprovalDefault(args.actionId, args.context, args.input);
  // Only the incumbent host-stamped approved replay bypass avoids creating a
  // second request. A waived setting or a bare policy false is not that proof.
  const required = !isApprovalAction(args.actionId)
    && ((args.context?.bypassApprovals !== true && (
      requiresWorkflowTriggerAgentApproval(args.actionId, args.context)
      || presentUserRequest
    )) || requiredByPolicy);

  // The public Action API reports a created approval artifact to its caller;
  // it cannot retain an HTTP or server-relay request as the blocking waiter.
  // The present-user UI ordinarily has the same lifecycle shape: its mounted
  // continuation follows the Artifact and consumes the replayed typed result,
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
  const mustReturnApprovalCustody = !custodyStaysOnLiveInvocation
    && (
      args.context?.surface === 'api'
      || args.context?.surface === 'cli'
      || (
        args.context?.surface === 'ui'
        && args.context?.authority === 'present_user'
      )
    );
  const flow = required && (mustReturnApprovalCustody
    || (presentUserRequest && args.spec.approvalInputCustody !== 'live_only'))
    ? 'deferred'
    : resolveActionApprovalFlow(args.spec.approval);

  return {
    required,
    flow,
    result: args.spec.approval.result,
  };
}
