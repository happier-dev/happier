import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ACTION_INVOKE_ACTION_ID_V1, ActionIdSchema } from './actionIds.js';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { formatQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRuleChangeActionId } from './actionPolicyActionIds.js';
import { normalizeActionSettingsActionId } from './actionSettings.js';
import {
  buildSessionApprovalConsentsHeaderV1, loadSessionApprovalConsentsV1, readSessionApprovalConsentModeV1,
  serializeSessionApprovalConsentsBodyV1, setSessionApprovalConsentRowV1,
  type BoundSessionApprovalConsentsV1, type SessionApprovalConsentFailureV1 as Failure,
  type SessionApprovalConsentModeChangeV1, type SessionApprovalConsentRowV1, type SessionApprovalConsentsStoreV1,
} from './sessionApprovalConsentsV1.js';

/*
 * Writers of the Session consent record. This module reads Action specs, so only hosts and the
 * policy executors import it; spec families and the composer import the leaf record module.
 */
const fail = (errorCode: string): Failure => ({ ok: false, errorCode, error: errorCode });

/**
 * Whether the ladder answers this Action's Ask, so a Session row can change it. Actions the
 * policy owner decides elsewhere stay out: approval controls and decisions, approval-rule
 * changes (decided on Account settings, Q6) and the per-plugin capture waiver.
 */
export function isSessionApprovalConsentEligibleV1(actionId: string): boolean {
  if (normalizeActionSettingsActionId(actionId) !== actionId) return false;
  if (isApprovalRuleChangeActionId(actionId)) return false;
  const builtIn = ActionIdSchema.safeParse(actionId);
  if (!builtIn.success) return true;
  const policy = getActionSpec(builtIn.data).approvalPolicy;
  return policy?.control !== true && policy?.pluginCaptureWaiver !== true;
}

/**
 * The policy id a stored approval request's Session row would key on (`profileActionId ?? actionId`):
 * a contributed Action by its qualified id, never the invoke carrier. Null when no Session row can
 * change this Action's Ask, so the approval sheet offers none.
 */
export function readSessionApprovalConsentActionIdV1(
  request: Readonly<{ actionId: string; actionArgs?: unknown }>,
): string | null {
  let actionId: string = request.actionId;
  if (actionId === ACTION_INVOKE_ACTION_ID_V1) {
    const invocation = ActionInvokeInputSchema.safeParse(request.actionArgs);
    if (!invocation.success) return null;
    actionId = formatQualifiedPluginActionId(invocation.data.action);
  }
  return isSessionApprovalConsentEligibleV1(actionId) ? actionId : null;
}

/** One person-authored row edit, saved without a second confirmation (the edit is the approval). */
export async function changeSessionApprovalConsentV1(
  store: SessionApprovalConsentsStoreV1,
  input: Readonly<{ sessionId: string }> & SessionApprovalConsentModeChangeV1,
  signal?: AbortSignal,
): Promise<
  Failure | Readonly<{ ok: true; consents: BoundSessionApprovalConsentsV1 }>
> {
  if (!isSessionApprovalConsentEligibleV1(input.actionId))
    return fail('session_approval_consent_unsupported');
  const current = await loadSessionApprovalConsentsV1(
    store,
    input.sessionId,
    signal,
  );
  const rows = setSessionApprovalConsentRowV1(current?.rows ?? [], input);
  if (sameStrictJsonValue(rows, current?.rows ?? []))
    return { ok: true, consents: { sessionId: input.sessionId, rows } };
  const header = buildSessionApprovalConsentsHeaderV1(input.sessionId);
  if (!current) {
    await store.create({
      header,
      body: serializeSessionApprovalConsentsBodyV1(input.sessionId, rows),
      signal,
    });
    return { ok: true, consents: { sessionId: input.sessionId, rows } };
  }
  const updated = await store.update({
    artifactId: current.artifactId,
    expectedRevision: current.revision,
    header,
    body: serializeSessionApprovalConsentsBodyV1(input.sessionId, rows),
    signal,
  });
  if (!updated.ok)
    return updated.errorCode === 'version_mismatch'
      ? fail('currentness_conflict')
      : updated;
  return { ok: true, consents: { sessionId: input.sessionId, rows } };
}

/**
 * Continue after a failed resume: the person's client moves (never copies) the source Session's
 * record to the child it just created. The server admits the re-bind only onto a Session the same
 * Account owns.
 */
export async function moveSessionApprovalConsentsV1(
  store: SessionApprovalConsentsStoreV1,
  input: Readonly<{ fromSessionId: string; toSessionId: string }>,
  signal?: AbortSignal,
): Promise<Failure | Readonly<{ ok: true; moved: boolean }>> {
  if (input.fromSessionId === input.toSessionId)
    return fail('invalid_parameters');
  const current = await loadSessionApprovalConsentsV1(
    store,
    input.fromSessionId,
    signal,
  );
  if (!current || current.rows.length === 0) return { ok: true, moved: false };
  const updated = await store.update({
    artifactId: current.artifactId,
    expectedRevision: current.revision,
    header: buildSessionApprovalConsentsHeaderV1(input.toSessionId),
    body: serializeSessionApprovalConsentsBodyV1(input.toSessionId, current.rows),
    signal,
  });
  if (!updated.ok)
    return updated.errorCode === 'version_mismatch'
      ? fail('currentness_conflict')
      : updated;
  return { ok: true, moved: true };
}

type SessionPolicyRequest = import('./actionPolicyActionFamily.js').ActionPolicyGetInput
  | import('./actionPolicyActionFamily.js').ActionPolicySetInput | import('./actionPolicyActionFamily.js').ActionPolicyResetInput;
type SessionPolicyResult = import('./actionPolicyActionFamily.js').ActionPolicySetResult
  | Readonly<{ session: { sessionId: string }; rows: SessionApprovalConsentRowV1[] }>;

/**
 * The policy Actions' Session target, shared by every host. Returns undefined for any other
 * target, which stays with the Account-settings owner. An agent may list and read; a write
 * reaches it only after the policy Action's own Ask, decided on Account settings (Q6).
 */
export async function executeSessionApprovalConsentPolicyV1(store: SessionApprovalConsentsStoreV1,
  actionId: 'actions.policy.get' | 'actions.policy.set' | 'actions.policy.reset', requested: SessionPolicyRequest,
  signal?: AbortSignal): Promise<SessionPolicyResult | Failure | undefined> {
  if ('sessionConsentsMove' in requested) {
    if (actionId !== 'actions.policy.set') return fail('invalid_parameters');
    const moved = await moveSessionApprovalConsentsV1(store, requested.sessionConsentsMove, signal);
    return moved.ok ? { sessionConsentsMove: requested.sessionConsentsMove, moved: moved.moved } : moved;
  }
  if (!('session' in requested)) return undefined;
  const sessionId = requested.session.sessionId;
  if (!('actionId' in requested)) {
    const current = await loadSessionApprovalConsentsV1(store, sessionId, signal);
    return { session: { sessionId }, rows: [...current?.rows ?? []] };
  }
  const target = { actionId: requested.actionId, audience: requested.audience,
    ...(requested.scope ? { scope: requested.scope } : {}) };
  if (actionId === 'actions.policy.get') {
    const current = await loadSessionApprovalConsentsV1(store, sessionId, signal);
    return { ...target, session: { sessionId }, mode: readSessionApprovalConsentModeV1(current?.rows ?? [], target) };
  }
  const mode = actionId === 'actions.policy.set' && 'mode' in requested ? requested.mode : 'default';
  const changed = await changeSessionApprovalConsentV1(store, { sessionId, ...target, mode }, signal);
  return changed.ok ? { ...target, session: { sessionId }, mode: readSessionApprovalConsentModeV1(changed.consents.rows, target) } : changed;
}
