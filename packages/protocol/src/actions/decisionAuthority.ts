import { evaluateApiTokenGrantV1, type ApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import type { ActionRequiredAuthority } from './metadata.js';
import type { ActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { isPresentUserSettingWriteV1 } from './accountSettingDeclarations.js';

export const DECISION_ACTION_IDS = ['approval.request.decide', 'session.permission.respond'] as const;
export const TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS = ['session.user_action.answer'] as const;

export function isAutomationApprovalRequestSurface(surface: string | null | undefined): boolean {
  return surface === 'agent' || surface === 'mcp' || surface === 'plugin';
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

/** Execution authority is separate from who may decide a requested approval. */
export function requiresPresentUserExecutionAuthorityForActionInputV1(
  spec: Pick<ActionSpec, 'id' | 'requiredAuthority'>,
  input?: unknown,
): boolean {
  return spec.requiredAuthority === 'present_user'
    || isPresentUserSettingWriteV1(spec.id, input)
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
}>): { ok: true } | { ok: false; errorCode: 'present_user_required' } {
  // Host Agent/MCP permission answers reach the shared, user-waivable approval
  // policy. External credentials retain the opt-in approve authority; changing
  // this Action's minimum authority must not widen token or terminal access.
  if (input.spec.id === 'session.permission.respond') {
    return canCredentialDecideV1(input)
      || ((input.surface === 'agent' || input.surface === 'mcp') && !input.hasExternalCredential && !input.grant)
      ? { ok: true }
      : { ok: false, errorCode: 'present_user_required' };
  }
  if (!requiresPresentUserExecutionAuthorityForActionInputV1(input.spec, input.actionInput) || input.authority === 'present_user') return { ok: true };
  // Admission here permits requesting consent, never automatic execution.
  // The approval owner enforces a mandatory floor, including persisted waivers.
  if (isAutomationApprovalRequestSurface(input.surface) && !input.hasExternalCredential && !input.grant
    && canRequestPresentUserApprovalForActionInputV1(input.spec, input.actionInput)) return { ok: true };
  if ((DECISION_ACTION_IDS as readonly string[]).includes(input.spec.id) && canCredentialDecideV1(input)) return { ok: true };
  if (input.grant && (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(input.spec.id)
    && evaluateApiTokenGrantV1({ grant: { ...input.grant, targets: null }, actionId: input.spec.id }).ok) return { ok: true };
  return { ok: false, errorCode: 'present_user_required' };
}
