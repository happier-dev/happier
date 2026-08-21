import type { PendingRequestedActionV1 } from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';

import { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import type { Credentials } from '@/persistence';
import {
  encryptSessionPayload,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

/**
 * The single owner of "seal one user message and put it into durable Pending
 * custody".
 *
 * It exists because two callers need exactly this and nothing else: the
 * `happier session send` service, and the same-Session Agent transition, which
 * must admit the user's exact message after cutover without a running runtime
 * to accept it. Duplicating the record shape would duplicate two subtle
 * contracts — the `source: 'ui'` rule below, and the unconditional sealing
 * determinism that lets a retry reconcile instead of conflict.
 *
 * Sealing determinism is independent of `pendingAdmissionMode`. The message
 * owner reconciles a re-enqueue by comparing stored content, so a re-seal that
 * differs by one random nonce byte is refused as a conflict and the admission
 * never resolves. Both callers retry the same `localId` with the same text after
 * a lost acknowledgement, and neither wants non-reproducible ciphertext for a
 * fixed `localId`, so every admission seals deterministically by `localId`.
 * `pendingAdmissionMode` carries only its delivery meaning — "do not deliver if
 * any queued user input already exists" — which the continuation nudge needs and
 * the user's own prompt must never inherit.
 *
 * It deliberately does NOT resume, wake, or wait: custody first, lifecycle
 * second is the predecessor's ordering invariant, and each caller owns the
 * lifecycle step that follows.
 */

export type SessionUserMessageAdmissionResult =
  /** The row is in durable Pending custody. */
  | Readonly<{ status: 'admitted' }>
  /** The server declined to queue it (delivery-mode condition), with no error. */
  | Readonly<{ status: 'suppressed' }>
  /**
   * The server already has this exact localId in the terminal transcript. The
   * message is durably present; starting a runtime now would create work
   * without pending custody.
   */
  | Readonly<{ status: 'already_terminal' }>
  /** The acknowledgement was not confirmed. Custody is genuinely unknown. */
  | Readonly<{ status: 'unconfirmed'; message: string }>;

export function buildSessionUserMessageRecord(params: Readonly<{
  text: string;
  permissionIntent: PermissionIntent;
  modelId?: string | null;
  /**
   * Structured input metadata from the canonical user-message request
   * (mentions, attachments, …), already sanitized by its owner. Canonical
   * fields below always win so provenance cannot be spoofed by a caller.
   */
  meta?: Readonly<Record<string, unknown>>;
}>): Readonly<{ role: 'user'; content: { type: 'text'; text: string }; meta: Record<string, unknown> }> {
  const modelId = typeof params.modelId === 'string' ? params.modelId : null;
  return {
    role: 'user',
    content: { type: 'text', text: params.text },
    meta: {
      ...(params.meta ?? {}),
      sentFrom: 'cli',
      // Important: `source: 'cli'` is reserved for CLI-authored transcript traffic that
      // the running agent runtime should treat as "self-sent" (e.g. local provider echoes).
      // A user-authored prompt is user intent and must be delivered to the runtime
      // queue even when it is committed by the daemon.
      source: 'ui',
      permissionMode: params.permissionIntent,
      ...(modelId && modelId !== 'default' ? { model: modelId } : {}),
    },
  };
}

export async function admitSessionUserMessageToPendingQueue(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  localId: string;
  text: string;
  permissionIntent: PermissionIntent;
  modelId?: string | null;
  meta?: Readonly<Record<string, unknown>>;
  requestedAction?: PendingRequestedActionV1;
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
}>): Promise<SessionUserMessageAdmissionResult> {
  const record = buildSessionUserMessageRecord({
    text: params.text,
    permissionIntent: params.permissionIntent,
    ...(params.modelId === undefined ? {} : { modelId: params.modelId }),
    ...(params.meta ? { meta: params.meta } : {}),
  });

  const content =
    params.mode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({
          t: 'encrypted',
          c: encryptSessionPayload({
            ctx: params.ctx,
            payload: record,
            idempotencyKey: params.localId,
          }),
        } as const);

  const requestedAction = params.requestedAction ?? { v: 1, kind: 'steer_if_active' as const };

  let enqueueResult: Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>;
  try {
    enqueueResult = await enqueuePendingQueueV2MessageViaHttp({
      token: params.credentials.token,
      sessionId: params.sessionId,
      body: content.t === 'encrypted'
        ? {
            localId: params.localId,
            ciphertext: content.c,
            messageRole: 'user',
            requestedAction,
            ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
          }
        : {
            localId: params.localId,
            content,
            messageRole: 'user',
            requestedAction,
            ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
          },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return { status: 'unconfirmed', message: message || 'Pending enqueue acknowledgement was not confirmed' };
  }

  if (enqueueResult?.suppressed === true) return { status: 'suppressed' };
  if (enqueueResult?.terminal === true) return { status: 'already_terminal' };
  return { status: 'admitted' };
}
