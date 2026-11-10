import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';


import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../../rpc/errors.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';

const SessionIdZodSchema = asProtocolZod(SessionIdSchema);

const SourceDataEncryptionKeyBase64Schema = lazyZodSchema(() => z.string().check(z.refine((value) => (
  readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_V1_BYTES
  && encodeBase64(decodeBase64(value, 'base64')) === value
), { message: `Expected canonical Base64 of exactly ${ENCRYPTED_DATA_KEY_V1_BYTES} bytes` })));

export const SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1 = 'session.follow.sourceKey.prepare' as const;
export const SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1 = 'SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTED' as const;

export const SessionFollowSourceKeyPrepareAuthorizationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SESSION_FOLLOW_SOURCE_KEY_PREPARE_AUTHORIZATION_KIND_V1),
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
  localInputId: z.optional(PendingLocalIdSchema),
}).check(z.superRefine((value, context) => {
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
})));
export type SessionFollowSourceKeyPrepareAuthorizationV1 = z.infer<typeof SessionFollowSourceKeyPrepareAuthorizationV1Schema>;

export const SessionFollowSourceKeyPrepareRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
  localInputId: z.optional(PendingLocalIdSchema),
  sourceDataEncryptionKeyBase64: SourceDataEncryptionKeyBase64Schema,
}).check(z.superRefine((value, context) => {
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
})));
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
  localInputId?: string;
}>): Readonly<{
  authorization: SessionFollowSourceKeyPrepareAuthorizationV1;
  request: SessionFollowSourceKeyPrepareRequestV1;
}> {
  const relation = {
    sourceSessionId: params.sourceSessionId,
    destinationSessionId: params.destinationSessionId,
    ...(params.localInputId !== undefined ? { localInputId: params.localInputId } : {}),
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

export const SessionFollowSourceKeyPrepareResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  outcome: z.literal('installed'),
}));
export type SessionFollowSourceKeyPrepareResponseV1 = z.infer<typeof SessionFollowSourceKeyPrepareResponseV1Schema>;

export const SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_REASONS_V1 = Object.freeze([
  'source_key_unavailable',
  'runner_unreachable',
  'runner_key_unavailable',
  'unsupported',
] as const);
export const SessionFollowSourceKeyPreparationWaitingReasonV1Schema = lazyZodSchema(() => z.enum(
  SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_REASONS_V1,
));
export type SessionFollowSourceKeyPreparationWaitingReasonV1 = z.infer<
  typeof SessionFollowSourceKeyPreparationWaitingReasonV1Schema
>;

/** Diagnostic branch only: never includes native errors, content, or authority. */
export const SessionFollowSourceKeyPreparationWaitingCauseV1Schema = lazyZodSchema(() => z.enum([
  'credentials_unavailable',
  'action_context_unavailable',
  'preparation_exception',
  'server_features_exception',
  'source_transport_exception',
  'destination_transport_exception',
  'source_transport_unavailable',
  'destination_transport_unavailable',
  'source_key_exception',
  'source_key_unavailable',
  'home_identity_unavailable',
  'destination_machine_exception',
  'destination_machine_unresolved',
  'destination_machine_missing',
  'rpc_method_unavailable',
  'machine_content_key_unavailable',
  'machine_content_mode_mismatch',
  'machine_target_not_current',
  'machine_rpc_failed',
  'machine_rpc_invalid_response',
]));
export type SessionFollowSourceKeyPreparationWaitingCauseV1 = z.infer<
  typeof SessionFollowSourceKeyPreparationWaitingCauseV1Schema
>;

/** Host-visible outcome after the durable Follow edge has already committed. */
export const SessionFollowSourceKeyPreparationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_needed') }),
  z.strictObject({ kind: z.literal('prepared') }),
  z.strictObject({
    kind: z.literal('waiting'),
    reason: SessionFollowSourceKeyPreparationWaitingReasonV1Schema,
    cause: z.optional(SessionFollowSourceKeyPreparationWaitingCauseV1Schema),
  }),
]));
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
    cause?: SessionFollowSourceKeyPreparationWaitingCauseV1;
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
      ...(preparation.cause ? { cause: preparation.cause } : {}),
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
  if (code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return { kind: 'waiting', reason: 'unsupported', cause: 'rpc_method_unavailable' };
  if (code === 'machine_kind_mismatch') return { kind: 'not_needed' };
  if (code === 'machine_content_key_unavailable' || code === 'machine_content_mode_mismatch') {
    return { kind: 'waiting', reason: 'runner_key_unavailable', cause: code };
  }
  return { kind: 'waiting', reason: 'runner_unreachable',
    cause: code === 'machine_target_not_current' ? code : 'machine_rpc_failed' };
}

export function decodeSessionFollowSourceDataEncryptionKeyV1(value: string): Uint8Array {
  return decodeBase64(SourceDataEncryptionKeyBase64Schema.parse(value), 'base64');
}
