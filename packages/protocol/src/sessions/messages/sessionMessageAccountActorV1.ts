import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { AccountDisplayProfileV1Schema } from '../../account/accountDisplayProfileV1.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';

/**
 * The sanitized authenticated-reader projection of one accepted human Session
 * message's actor.
 *
 * It carries the exact admitted Account identity plus that Account's current
 * neutral display profile — never the raw admission receipt, the admitted
 * `sessionRelationship`, the grant source, or any access fact. Historical
 * authorship must not change when grant topology changes, so admission
 * relationship is deliberately absent.
 *
 * `profile: null` is the expected shape after Home Account deletion: the
 * immutable receipt still proves who authored the message.
 */
export const SessionMessageAccountActorV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  accountId: z.string().trim().min(1).max(191),
  profile: AccountDisplayProfileV1Schema.nullable(),
}).strict());

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
}>): string | null {
  const role = SessionMessageRoleSchema.safeParse(params.messageRole);
  if (!role.success || role.data !== 'user') return null;
  const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(params.inputAdmissionReceipt);
  if (!receipt.success || receipt.data.issuer !== 'authenticatedAccount') return null;
  return receipt.data.actorAccountId;
}
