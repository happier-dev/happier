import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { evaluateApiTokenGrantV1, type ApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import type { ActionRequiredAuthority } from './metadata.js';
import type { ActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { HandoffWorkspaceActionV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { readRecord } from '../inputs/inputRecords.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { isProjectSetupTrustRequestV1 } from './projectActionFamily.js';

/** Safe Session relocation can contain an explicitly chosen workspace-writing effect. */
export function isActionWorkspaceWriteV1(
  spec: Pick<ActionSpec, 'id' | 'workspaceWrite'>,
  actionInput?: unknown,
): boolean {
  if (spec.workspaceWrite) return true;
  if (spec.id !== 'session.handoff') return false;
  const action = HandoffWorkspaceActionV1Schema.safeParse(readRecord(actionInput).workspaceAction);
  return action.success && (action.data.kind === 'copy_once' || action.data.kind === 'create_relationship');
}

/** The same hands-off ceiling governs an Action and its host-private effect phases. */
export function resolveWorkspaceWriteActionAdmissionV1(input: Readonly<{
  spec: Pick<ActionSpec, 'id' | 'workspaceWrite'>;
  actionInput?: unknown;
  workspaceWrites?: 'allow' | 'deny';
  currentWorkspaceWrites?: 'allow' | 'deny';
  agentCaller: boolean;
}>): { ok: true } | { ok: false; errorCode: 'workspace_write_denied' | 'workspace_write_escalation_denied' } {
  const workspaceWrites = input.workspaceWrites === 'deny' || input.currentWorkspaceWrites === 'deny'
    ? 'deny' : input.currentWorkspaceWrites ?? input.workspaceWrites;
  if (workspaceWrites === 'deny' && isActionWorkspaceWriteV1(input.spec, input.actionInput)) {
    return { ok: false, errorCode: 'workspace_write_denied' };
  }
  if (input.agentCaller && workspaceWrites !== 'allow' && isRoleActionIdV1(input.spec.id)
    && readRecord(input.actionInput).workspaceWrites === 'allow') {
    return { ok: false, errorCode: 'workspace_write_escalation_denied' };
  }
  return { ok: true };
}

export const DECISION_ACTION_IDS = ['approval.request.decide', 'session.permission.respond'] as const;
export const TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS = ['session.user_action.answer'] as const;

function isLegacyWorkflowConversionInputV1(spec: Pick<ActionSpec, 'id'> | undefined, input: unknown): boolean {
  return spec?.id === 'workflow.trigger.update' && readRecord(input).confirmLegacyConversion === true;
}

function isSessionMessageHumanReturnInputV1(spec: Pick<ActionSpec, 'id'> | undefined, input: unknown): boolean {
  const data = readRecord(input);
  return spec?.id === 'session.message.send' && data.reply === 'return' && typeof data.returnToSessionId === 'string';
}

export function isAutomationApprovalRequestSurface(
  surface: string | null | undefined,
  spec?: Pick<ActionSpec, 'id'>,
  input?: unknown,
): boolean {
  // Voice may propose a person-bound return, never supply that authority.
  // Agent/Plugin input retains its separate causal Session origin instead.
  if (isSessionMessageHumanReturnInputV1(spec, input)) return surface === 'voice';
  // Voice can propose the person's source disclosure through the ordinary
  // approval owner. It never supplies present-person execution authority.
  if (surface === 'voice' && spec?.id === 'discussion.second_opinion.start') return true;
  // Spoken answers are proposals for the person's existing approval flow.
  // Pass-up still requires the authenticated manager at the question owner.
  if (surface === 'voice' && spec?.id === 'session.user_action.answer') return readRecord(input).disposition !== 'pass_up';
  return surface === 'agent' || surface === 'mcp' || surface === 'plugin'
    || (surface === 'cli' && (isLegacyWorkflowConversionInputV1(spec, input)
      || isProjectSetupTrustRequestV1(spec?.id ?? '', input)));
}

/** Exact admitted operands, including their domain revision, bound by the approval owner. */
export function computeActionInputApprovalDigestV1(actionId: ActionId, input: unknown,
  sessionTargetsV1?: import('./sessionTargetV1.js').ActionResolvedSessionTargetsV1): string {
  // Native schema outputs may retain optional undefined members that transport omits.
  const parts = [actionId, createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(input))];
  // A many-capable operand retains its selector; its already-resolved target
  // snapshot is part of this operation, not another selection or authority.
  if (sessionTargetsV1) parts.push(createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(sessionTargetsV1)));
  return computeCanonicalDomainSeparatedDigest('action.present-user-approval.v1', parts);
}

/** Requestability follows the Action owner, not a second mutation allowlist. */
export function canRequestPresentUserApprovalForActionInputV1(
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority' | 'approvalInputCustody'>,
  input?: unknown,
): boolean {
  return !(DECISION_ACTION_IDS as readonly string[]).includes(spec.id)
    && requiresPresentUserExecutionAuthorityForActionInputV1(spec, input);
}

export function canCredentialDecideV1(input: Readonly<{ authority: ActionRequiredAuthority; grant: ApiTokenGrantV1 | null }>): boolean {
  return input.authority === 'present_user' || input.grant?.approve === true;
}

/** Public creation shares one authority and disclosure classification. */
export function isPublicLinkCreationActionV1(actionId: string): boolean {
  return actionId === 'artifact.public_link.create' || actionId === 'session.public_link.create';
}

/** Execution authority is separate from who may decide a requested approval. */
export function requiresPresentUserExecutionAuthorityForActionInputV1(
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority'>,
  input?: unknown,
): boolean {
  return spec.requiredAuthority === 'present_user'
    || isProjectSetupTrustRequestV1(spec.id, input)
    || isPublicLinkCreationActionV1(spec.id)
    || isLegacyWorkflowConversionInputV1(spec, input)
    || isSessionMessageHumanReturnInputV1(spec, input)
    || (spec.id === 'session.open' && typeof input === 'object' && input !== null
      && 'approvedNewDirectoryCreation' in input && input.approvedNewDirectoryCreation === true);
}

/** Agent-callable control/recovery requests remain human-decided, including rejection. */
const HUMAN_DECIDED_SURFACE_ACTION_IDS = [
  'browser.control.takeControl', 'browser.control.handBack',
  'computer.targets.list', 'computer.target.select',
  'computer.control.interrupt', 'computer.control.handBack',
  'computer.permissions.openSettings', 'browser.sandbox.install',
] as const satisfies readonly ActionId[];

export function requiresPresentUserDecisionForActionInputV1(
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority'>,
  input?: unknown,
  decision: 'approve' | 'reject' = 'approve',
): boolean {
  return (HUMAN_DECIDED_SURFACE_ACTION_IDS as readonly string[]).includes(spec.id)
    || (decision === 'approve' && requiresPresentUserExecutionAuthorityForActionInputV1(spec, input));
}

/** Decisions are opt-in; they never grant token, security, trust or policy authority. */
export function resolveCredentialActionAdmissionV1(input: Readonly<{
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority' | 'approvalInputCustody'>;
  authority: ActionRequiredAuthority;
  grant: ApiTokenGrantV1 | null;
  surface?: string | null;
  hasExternalCredential?: boolean;
  actionInput?: unknown;
  /** Host-stamped native Realtime input restriction, never a grant or Action input. */
  nativeRealtimeInput?: true;
  /** Host-validated current Session question origin; eligibility remains with the receiving question owner. */
  hasSessionQuestionAnswerOrigin?: boolean;
}>): { ok: true } | { ok: false; errorCode: 'present_user_required' } {
  if (input.nativeRealtimeInput && (
    (DECISION_ACTION_IDS as readonly string[]).includes(input.spec.id)
    || input.spec.id === 'execution.run.permission.respond'
    || input.spec.id === 'session.permission.remote.respond'
  )) return { ok: false, errorCode: 'present_user_required' };
  if (input.spec.id === 'session.user_action.answer' && input.hasSessionQuestionAnswerOrigin
    && !input.hasExternalCredential && !input.grant) return { ok: true };
  // Host Agent/MCP decisions reach the shared, user-waivable approval
  // policy, including the authenticated Home mint before a local surface is
  // known. External credentials retain their separate opt-in approve authority.
  if (input.spec.id === 'session.permission.respond' || input.spec.id === 'approval.request.decide') {
    return canCredentialDecideV1(input)
      || (input.surface !== 'api' && !input.hasExternalCredential && !input.grant)
      ? { ok: true }
      : { ok: false, errorCode: 'present_user_required' };
  }
  if (!requiresPresentUserExecutionAuthorityForActionInputV1(input.spec, input.actionInput) || input.authority === 'present_user') return { ok: true };
  // Admission here permits requesting consent, never automatic execution.
  // Approval defaults are user-waivable. The executor still proves human
  // authority before preparation/effects when no approval proposal is requested.
  if (isAutomationApprovalRequestSurface(input.surface, input.spec, input.actionInput) && !input.hasExternalCredential && !input.grant
    && canRequestPresentUserApprovalForActionInputV1(input.spec, input.actionInput)) return { ok: true };
  if ((DECISION_ACTION_IDS as readonly string[]).includes(input.spec.id) && canCredentialDecideV1(input)) return { ok: true };
  if (input.grant && (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(input.spec.id)
    && evaluateApiTokenGrantV1({ grant: { ...input.grant, targets: null }, actionId: input.spec.id }).ok) return { ok: true };
  return { ok: false, errorCode: 'present_user_required' };
}
