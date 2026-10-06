import { z } from 'zod';


import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../../rpc/errors.js';

const SessionIdZodSchema = asProtocolZod(SessionIdSchema);

const SourceDataEncryptionKeyBase64Schema = z.string().refine((value) => (
  readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_V1_BYTES
  && encodeBase64(decodeBase64(value, 'base64')) === value
), { message: `Expected canonical Base64 of exactly ${ENCRYPTED_DATA_KEY_V1_BYTES} bytes` });

export const SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1 = 'session.follow.sourceKey.prepare' as const;
export const SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1 = 'SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTED' as const;

export const SessionFollowSourceKeyPrepareAuthorizationV1Schema = z.object({
  kind: z.literal(SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1),
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
});
export type SessionFollowSourceKeyPrepareAuthorizationV1 = z.infer<typeof SessionFollowSourceKeyPrepareAuthorizationV1Schema>;

export const SessionFollowSourceKeyPrepareRequestV1Schema = z.object({
  v: z.literal(1),
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
  sourceDataEncryptionKeyBase64: SourceDataEncryptionKeyBase64Schema,
}).strict().superRefine((value, context) => {
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
});
export type SessionFollowSourceKeyPrepareRequestV1 = z.infer<typeof SessionFollowSourceKeyPrepareRequestV1Schema>;

/**
 * The one construction of a Follow source-key preparation call, shared by every
 * host that sends the DEK (UI and CLI alike). The authorization literal and the
 * encrypted body carry the same source/destination tuple, and building them in
 * two places is how they drift.
 */
export function buildSessionFollowSourceKeyPrepareRequestV1(params: Readonly<{
  sourceSessionId: string;
  destinationSessionId: string;
  sourceDataEncryptionKeyBase64: string;
}>): Readonly<{
  authorization: SessionFollowSourceKeyPrepareAuthorizationV1;
  request: SessionFollowSourceKeyPrepareRequestV1;
}> {
  const relation = {
    sourceSessionId: params.sourceSessionId,
    destinationSessionId: params.destinationSessionId,
  };
  return {
    authorization: SessionFollowSourceKeyPrepareAuthorizationV1Schema.parse({
      kind: SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1,
      ...relation,
    }),
    request: SessionFollowSourceKeyPrepareRequestV1Schema.parse({
      v: 1,
      ...relation,
      sourceDataEncryptionKeyBase64: params.sourceDataEncryptionKeyBase64,
    }),
  };
}

export const SessionFollowSourceKeyPrepareResponseV1Schema = z.object({
  v: z.literal(1),
  outcome: z.literal('installed'),
}).strict();
export type SessionFollowSourceKeyPrepareResponseV1 = z.infer<typeof SessionFollowSourceKeyPrepareResponseV1Schema>;

export const SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_REASONS_V1 = Object.freeze([
  'source_key_unavailable',
  'runner_unreachable',
  'runner_key_unavailable',
  'unsupported',
] as const);
export const SessionFollowSourceKeyPreparationWaitingReasonV1Schema = z.enum(
  SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_REASONS_V1,
);
export type SessionFollowSourceKeyPreparationWaitingReasonV1 = z.infer<
  typeof SessionFollowSourceKeyPreparationWaitingReasonV1Schema
>;

/** Host-visible outcome after the durable Follow edge has already committed. */
export const SessionFollowSourceKeyPreparationResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_needed') }).strict(),
  z.object({ kind: z.literal('prepared') }).strict(),
  z.object({
    kind: z.literal('waiting'),
    reason: SessionFollowSourceKeyPreparationWaitingReasonV1Schema,
  }).strict(),
]);
export type SessionFollowSourceKeyPreparationResultV1 = z.infer<
  typeof SessionFollowSourceKeyPreparationResultV1Schema
>;

export const SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1 =
  'session_follow_source_key_preparation_waiting' as const;

/**
 * Preserves the independent edge commit while making incomplete private-key
 * preparation explicit to Action/MCP callers. The success payload remains the
 * strict authoring DTO; partial completion uses the existing Action failure
 * envelope and includes the committed projection needed for safe retry UX.
 */
export function projectSessionFollowSourceKeyPreparationAfterSetV1<
  TCommitted extends Readonly<{ source: unknown }>,
>(
  committed: TCommitted,
  preparation: SessionFollowSourceKeyPreparationResultV1,
): TCommitted | Readonly<{
  ok: false;
  errorCode: typeof SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1;
  error: typeof SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1;
  details: Readonly<{
    status: 'waiting';
    reason: SessionFollowSourceKeyPreparationWaitingReasonV1;
    edgeCommitted: true;
    source: TCommitted['source'];
  }>;
}> {
  if (preparation.kind !== 'waiting') return committed;
  return {
    ok: false,
    errorCode: SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1,
    error: SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1,
    details: {
      status: 'waiting',
      reason: preparation.reason,
      edgeCommitted: true,
      source: committed.source,
    },
  };
}

function readPreparationFailureCode(error: unknown): string | undefined {
  const rpcCode = readRpcErrorCode(error);
  if (rpcCode) return rpcCode;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The one classification of a failed Runner key preparation, shared by every
 * host that sends the DEK (UI and CLI alike). The RPC-level "method not
 * available" code and the exact-Machine transport's `code`s are the whole
 * vocabulary; anything else is an unreachable Runner. Hosts keep their own
 * pre-checks (plain source, persistent destination, a live Machine store)
 * because they hold different evidence before the call.
 */
export function resolveSessionFollowSourceKeyPreparationFailureV1(
  error: unknown,
): SessionFollowSourceKeyPreparationResultV1 {
  const code = readPreparationFailureCode(error);
  if (code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return { kind: 'waiting', reason: 'unsupported' };
  if (code === 'machine_kind_mismatch') return { kind: 'not_needed' };
  if (code === 'machine_content_key_unavailable' || code === 'machine_content_mode_mismatch') {
    return { kind: 'waiting', reason: 'runner_key_unavailable' };
  }
  return { kind: 'waiting', reason: 'runner_unreachable' };
}

export function decodeSessionFollowSourceDataEncryptionKeyV1(value: string): Uint8Array {
  return decodeBase64(SourceDataEncryptionKeyBase64Schema.parse(value), 'base64');
}
