import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { z } from 'zod/mini';

import { AccountDisplayProfileV1Schema } from '../../account/accountDisplayProfileV1.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';

/**
 * The sanitized authenticated-reader projection of one accepted human Session
 * message's actor.
 *
 * It carries the exact admitted Account identity plus that Account's current
 * neutral display profile and, when a resource owner supplies it, a current/former
 * presentation relationship. That relationship is diagnostic display state only:
 * never the raw admission receipt, admitted `sessionRelationship`, grant source,
 * access level, or authorization evidence. Historical authorship never changes
 * when grant topology changes.
 *
 * `profile: null` is the expected shape after Home Account deletion: the
 * immutable receipt still proves who authored the message.
 */
export const SessionMessageAccountActorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  accountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(191)),
  profile: z.nullable(AccountDisplayProfileV1Schema),
  accessibility: z.optional(z.enum(['current', 'former'])),
}));

export type SessionMessageAccountActorV1 = z.infer<typeof SessionMessageAccountActorV1Schema>;

export function parseSessionMessageAccountActorV1(
  value: unknown,
): SessionMessageAccountActorV1 | null {
  const parsed = SessionMessageAccountActorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The sole receipt -> author-Account-id derivation.
 *
 * Persistence writers use it to fill the derived `SessionMessage.authorAccountId`
 * query projection and read projectors use it to resolve the wire actor, so a
 * stored column can never disagree with the receipt about who authored a row.
 * Only a valid V1 authenticated-Account receipt on a `messageRole: 'user'` row
 * yields an id; machine, legacy, malformed, unknown-version, and non-user rows
 * yield `null` rather than a guess.
 */
export function deriveSessionMessageAuthorAccountIdV1(params: Readonly<{
  messageRole: unknown;
  inputAdmissionReceipt: unknown;
}>, mode: 'input' | 'stored' = 'input'): string | null {
  const role = SessionMessageRoleSchema.safeParse(params.messageRole);
  if (!role.success || role.data !== 'user') return null;
  const receipt = (mode === 'stored' ? createStoredReadSchema(SessionInputAdmissionReceiptV1Schema)
    : SessionInputAdmissionReceiptV1Schema).safeParse(params.inputAdmissionReceipt);
  if (!receipt.success || receipt.data.issuer !== 'authenticatedAccount') return null;
  return receipt.data.actorAccountId;
}
