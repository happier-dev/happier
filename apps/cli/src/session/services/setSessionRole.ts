import { randomUUID } from 'node:crypto';
import {
  applySessionRoleChangeV1ToMetadata,
  planSessionRoleChangeV1,
  type PendingRequestedActionV1,
  type AssignableSessionRole,
  type SessionRoleSetActionResultV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

import { sendSessionMessage } from './sendSessionMessage';
import { SESSION_MESSAGE_SEND_DEFAULT_TIMEOUT_MS } from './sessionMessageSendBudget';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

/** Queue behind any in-flight turn so the provider reads it on its next normal turn. */
const ROLE_INSTRUCTION_REQUESTED_ACTION: PendingRequestedActionV1 = { v: 1, kind: 'enqueue' };

/**
 * Account settings of the CLI's own server/account, which is the account of every session it
 * can address. Unavailable settings are null so callers fail closed instead of guessing.
 */
export async function readSessionRoleAccountSettings(credentials: Credentials): Promise<unknown | null> {
  try {
    const context = await bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    return context.settings ?? null;
  } catch {
    return null;
  }
}

/**
 * Session-agent role change for an existing session: the same protocol plan, CAS write, visible
 * instruction, idempotent id, and truthful result as the UI menu. Never changes permissions,
 * model, control, ownership, provenance, or placement.
 */
export async function setSessionRole(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  role: AssignableSessionRole | null;
  /** Caller correlation id, recorded on the assignment; identity only for an explicit resume. */
  actionRequestId?: string;
  /** Action resume: resolve this request's retained current change only, never write a new one. */
  resume?: boolean;
}>): Promise<SessionRoleSetActionResultV1> {
  const actionRequestId = params.actionRequestId?.trim() || undefined;
  const resume = params.resume === true && Boolean(actionRequestId);
  // A resume delivers the persisted snapshot, so it needs no current profile.
  const settings = params.role && !resume ? await readSessionRoleAccountSettings(params.credentials) : null;
  if (params.role && !resume && settings === null) {
    return { ok: false, errorCode: 'role_profiles_unavailable', error: 'account_role_profiles_unavailable', roleSaved: false };
  }
  const planned = planSessionRoleChangeV1({
    role: params.role,
    settings,
    changeId: randomUUID(),
    at: Date.now(),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(resume ? { resumeExistingAssignment: true } : {}),
  });
  if (planned === null) {
    return { ok: false, errorCode: 'role_profiles_unavailable', error: 'session_role_profile_not_found', roleSaved: false };
  }
  // A resume delivers the snapshot already persisted for its request, never a recomputed one.
  let plan: typeof planned | null = planned;

  const updated = await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) => {
      const applied = applySessionRoleChangeV1ToMetadata(metadata, planned, { resume, ...(actionRequestId ? { actionRequestId } : {}) });
      plan = applied.plan;
      return applied.metadata;
    },
  }).catch((error: unknown) => ({ ok: false as const, code: error instanceof Error ? error.message : 'metadata_update_failed' }));
  if (!updated.ok) {
    return { ok: false, errorCode: 'role_update_failed', error: updated.code, roleSaved: false };
  }
  if (plan === null) {
    return { ok: false, errorCode: 'role_change_not_current', error: 'role_change_not_current', roleSaved: false };
  }
  const delivered = plan;

  const sent = await sendSessionMessage({
    credentials: params.credentials,
    idOrPrefix: updated.sessionId,
    message: delivered.message,
    localId: delivered.localId,
    requestedAction: ROLE_INSTRUCTION_REQUESTED_ACTION,
    wait: false,
    timeoutMs: SESSION_MESSAGE_SEND_DEFAULT_TIMEOUT_MS,
  }).catch((error: unknown) => ({ ok: false as const, code: error instanceof Error ? error.message : 'delivery_failed' }));
  if (!sent.ok) {
    return {
      ok: false,
      errorCode: 'role_instruction_not_delivered',
      error: 'code' in sent && typeof sent.code === 'string' ? sent.code : 'delivery_failed',
      roleSaved: true,
      sessionId: updated.sessionId,
      role: params.role,
      instruction: { localId: delivered.localId, message: delivered.message },
    };
  }
  return {
    ok: true,
    sessionId: updated.sessionId,
    role: params.role,
    action: params.role ? 'assigned' : 'cleared',
    instructionLocalId: delivered.localId,
  };
}
