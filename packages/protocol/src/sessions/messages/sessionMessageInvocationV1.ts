import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionTargetV1Schema, ActionSessionAddressV1Schema, normalizeSessionTargetV1 } from '../../actions/sessionTargetV1.js';
import { ActionSessionFanoutResultV1Schema } from '../../actions/sessionTargetV1.js';
import { SessionMessageSendResultV1Schema } from './sessionInputAdmission.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { CoordinationMessageRefV1Schema } from '../../discussions/references.js';
import type { ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../../actions/actionExecutionResult.js';
import type { SessionTargetV1 } from '../../actions/sessionTargetV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64 } from '../../crypto/base64.js';

/** Presentation only. Input/reply custody remains on each original receiver input. */
export const SessionMessageInvocationImmediateV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['accepted', 'alreadyAccepted', 'held', 'rejected', 'outcomeUnknown', 'replied', 'failed', 'cancelled']),
  code: z.optional(z.string()),
  outcome: z.optional(z.enum(['answer', 'pass', 'failed', 'cancelled', 'terminal_no_result', 'declined'])),
  resultRef: z.optional(CoordinationMessageRefV1Schema),
}));
export const SessionMessageInvocationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), localId: PendingLocalIdSchema,
  reply: z.enum(['none', 'wait', 'return']),
  target: SessionTargetV1Schema,
  targets: z.array(z.strictObject({ target: ActionSessionAddressV1Schema, localId: z.optional(PendingLocalIdSchema),
    immediate: SessionMessageInvocationImmediateV1Schema })),
  /** Failure before a selector could establish any concrete recipient. */
  resolutionError: z.optional(z.string()),
}));
export type SessionMessageInvocationV1 = z.infer<typeof SessionMessageInvocationV1Schema>;
export const SESSION_MESSAGE_INVOCATION_SIDECAR_V1 = 'sessionMessageInvocationV1' as const;

/** The same submit identity, namespaced so a self-target input cannot collide with its source entry. */
export function deriveSessionMessageInvocationLocalIdV1(localId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(['happier.session-message-invocation.v1', PendingLocalIdSchema.parse(localId)]));
  return `invocation-v1:${encodeBase64(sha256(bytes), 'base64url')}`;
}

/** Strict sidecar admission on the existing additive informational-message event. */
export function readSessionMessageInvocationV1(event: unknown): SessionMessageInvocationV1 | null {
  if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'message'
    || !(SESSION_MESSAGE_INVOCATION_SIDECAR_V1 in event)) return null;
  const parsed = SessionMessageInvocationV1Schema.safeParse(event[SESSION_MESSAGE_INVOCATION_SIDECAR_V1]);
  return parsed.success ? parsed.data : null;
}

/** Capture the already-resolved Action result; never expand a selector while reading history. */
export function projectSessionMessageInvocationV1(input: Readonly<{
  serverId: string; localId: string; target: SessionTargetV1;
  requestLocalId?: string;
  reply: SessionMessageInvocationV1['reply']; result: ActionExecuteResult;
}>): SessionMessageInvocationV1 {
  const fanout = input.result.ok ? ActionSessionFanoutResultV1Schema.safeParse(input.result.result) : null;
  const normalizedTarget = normalizeSessionTargetV1(input.target);
  const leaves = fanout?.success ? fanout.data.results : typeof normalizedTarget === 'string'
    ? [{ target: { serverId: input.serverId, sessionId: normalizedTarget }, result: input.result }] : [];
  return SessionMessageInvocationV1Schema.parse({ v: 1, localId: input.localId, reply: input.reply, target: input.target,
    targets: leaves.map(leaf => {
      const sent = leaf.result.ok ? SessionMessageSendResultV1Schema.safeParse(leaf.result.result) : null;
      if (!sent?.success) return { target: leaf.target, ...(input.requestLocalId ? { localId: input.requestLocalId } : {}),
        immediate: { status: !leaf.result.ok && isActionOutcomeUnknownErrorCodeV1(leaf.result.errorCode) ? 'outcomeUnknown' : 'rejected',
          code: !leaf.result.ok ? leaf.result.errorCode ?? 'action_failed' : 'unavailable' } };
      const result = sent.data;
      const outcome = result.status === 'replied' ? result.outcome : undefined;
      return { target: leaf.target, ...('localId' in result ? { localId: result.localId }
        : input.requestLocalId ? { localId: input.requestLocalId } : {}),
        immediate: { status: result.status, ...('code' in result ? { code: result.code } : {}),
          ...(outcome ? { outcome: outcome.kind } : {}),
          ...(outcome && 'messageRef' in outcome ? { resultRef: outcome.messageRef } :
            outcome && 'publicationRef' in outcome ? { resultRef: outcome.publicationRef } : {}) } };
    }), ...(!leaves.length && !input.result.ok ? { resolutionError: input.result.errorCode ?? 'action_failed' } : {}) });
}
