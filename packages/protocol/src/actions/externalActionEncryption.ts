import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { AccountApiTokenEncryptionAccessV1Schema, AccountApiTokenSummaryV1Schema } from '../auth/accountApiTokens.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES, ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES, ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES } from '../crypto/accountScopedCipherEnvelope.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { ActionExecuteResult } from './actionExecutionResult.js';
import {
  ExternalActionActionIdV1Schema, ExternalActionRequestIdV1Schema,
  ExternalActionTargetV1Schema, ExternalActionApiTokenServerPrincipalV1Schema,
  ExternalActionAccountAuthenticationV1Schema, ExternalActionTerminalAuthenticationV1Schema,
  ExternalActionExecutionResultV1Schema, ExternalActionRequestEnvelopeV2Schema,
  ExternalActionResponseEnvelopeV2Schema, EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  prepareExternalActionResponseEnvelopeV1, isExternalActionRequestWithinLimit,
  externalActionTargetsEqualV1,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  projectExternalActionPendingResetStartAdmissionV1,
  projectExternalActionPendingResetStartSessionDigestV1,
  projectExternalActionRunNowIdempotencyKeyV1,
  projectExternalActionManagedAdmissionV1,
  type ExternalActionRequestEnvelopeV2, type ExternalActionResponseEnvelopeV2,
  type PreparedExternalActionResponseEnvelope,
} from './externalActionApi.js';

/** Identity/routing objects are closed; opaque domain JSON retains its own schema. */
const BindingRoutingShape = () => ({
  serverIdentityId: AccountApiTokenEncryptionAccessV1Schema.shape.serverIdentityId,
  accountId: ExternalActionApiTokenServerPrincipalV1Schema.shape.accountId,
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema,
});
const ApiTokenBindingSchema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: AccountApiTokenEncryptionAccessV1Schema.shape.serverIdentityId,
  accountId: ExternalActionApiTokenServerPrincipalV1Schema.shape.accountId,
  credentialId: AccountApiTokenSummaryV1Schema.shape.tokenId,
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema,
}));
const AccountBindingSchema = lazyZodSchema(() => z.strictObject({ ...BindingRoutingShape(),
  // Ciphertext retains the signed credential kind and epoch, never a PAT-shaped alias or human upgrade.
  authentication: z.union([z.omit(ExternalActionAccountAuthenticationV1Schema, { evidence: true }),
    z.omit(ExternalActionTerminalAuthenticationV1Schema, { evidence: true })]),
}));
const BindingSchema = lazyZodSchema(() => z.union([ApiTokenBindingSchema, AccountBindingSchema]));
export type ExternalActionEncryptionBindingV2 = Readonly<z.infer<typeof BindingSchema>>;

const requestShape = () => ({
  v: z.literal(2), direction: z.literal('request'), input: StrictJsonValueSchema,
});
const RequestSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ApiTokenBindingSchema, requestShape())), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AccountBindingSchema, requestShape())),
]));
const responseShape = () => ({
  v: z.literal(2), direction: z.literal('response'),
  executedMachineId: ExternalActionTargetV1Schema._zod.def.options[0].shape.machineId,
  requestPayloadDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u), z.refine((value) => (
    encodeBase64(decodeBase64(value, 'base64url'), 'base64url') === value
  ))),
  execution: ExternalActionExecutionResultV1Schema,
});
const ResponseSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ApiTokenBindingSchema, responseShape())), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AccountBindingSchema, responseShape())),
]));

type Material = Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
type SealOptions = Readonly<{ material: Material; randomBytes: (length: number) => Uint8Array }>;
const kind = 'external_action_transport' as const;

function matches(actual: ExternalActionEncryptionBindingV2, expected: ExternalActionEncryptionBindingV2): boolean {
  return actual.serverIdentityId === expected.serverIdentityId
    && actual.accountId === expected.accountId
    && ('authentication' in actual
      ? 'authentication' in expected && actual.authentication.kind === expected.authentication.kind
        && actual.authentication.tokenEpoch === expected.authentication.tokenEpoch
      : 'credentialId' in expected && actual.credentialId === expected.credentialId)
    && actual.actionId === expected.actionId && actual.requestId === expected.requestId
    && externalActionTargetsEqualV1(actual.target, expected.target);
}

function open(ciphertext: string, material: Material, maximumPlaintextBytes: number): unknown {
  if (material.type !== 'dataKey' || material.machineKey.length !== 32) return null;
  const bytes = decodeBase64(ciphertext, 'base64');
  if (bytes.length > maximumPlaintextBytes
    + ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    || encodeBase64(bytes, 'base64') !== ciphertext) return null;
  const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
  return opened?.format === 'account_scoped_v1' && opened.kindTag === 'canonical' ? opened.value : null;
}

export function sealExternalActionRequestV2(params: SealOptions & Readonly<{
  binding: ExternalActionEncryptionBindingV2; input: unknown;
  sessionSpawnAdmission?: ExternalActionRequestEnvelopeV2['sessionSpawnAdmission'];
  pluginInvocation?: ExternalActionRequestEnvelopeV2['pluginInvocation'];
}>): ExternalActionRequestEnvelopeV2 {
  const payload = RequestSchema.parse({ ...params.binding, v: 2, direction: 'request', input: params.input });
  if (params.material.type !== 'dataKey' || params.material.machineKey.length !== 32) throw new TypeError('Invalid external Action material');
  if (!isExternalActionRequestWithinLimit({ v: 1, requestId: payload.requestId, target: payload.target, input: payload.input })) {
    throw new RangeError('External Action request exceeds its decoded limit');
  }
  const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(payload.actionId, payload.input);
  // Every encrypted producer needs the same Home-readable compute projection.
  // Agent instructions remain exclusively inside the sealed Action input.
  const managedAdmission = projectExternalActionManagedAdmissionV1(payload.actionId, payload.input);
  const envelope: ExternalActionRequestEnvelopeV2 = { v: 2, requestId: payload.requestId, target: payload.target,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    payload: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ ...params, kind, payload }) },
    ...(managedAdmission ? { managedAdmission } : {}),
    ...(params.sessionSpawnAdmission ? { sessionSpawnAdmission: params.sessionSpawnAdmission } : {}),
    ...(params.pluginInvocation ? { pluginInvocation: params.pluginInvocation } : {}),
    ...(payload.actionId === 'session.pending.resetStart.set'
      ? { pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(payload.input) } : {}) };
  if (envelope.pendingResetStartAdmission && payload.target.kind === 'session'
    && projectExternalActionPendingResetStartSessionDigestV1(payload.target.sessionId) !== envelope.pendingResetStartAdmission.sessionDigest) throw new TypeError('Reset admission target mismatch');
  if (!isExternalActionRequestWithinLimit(envelope)) {
    throw new RangeError('External Action request exceeds its protected wire limit');
  }
  return ExternalActionRequestEnvelopeV2Schema.parse(envelope);
}

/** No error details from unauthenticated plaintext may cross this boundary. */
export function openExternalActionRequestV2(params: Readonly<{
  envelope: unknown; binding: ExternalActionEncryptionBindingV2; material: Material;
  /** Host-local phase witness; never part of the transport response or opened content. */
  onFailure?: (failure: Readonly<{
    phase: 'envelope_parse' | 'envelope_binding' | 'ciphertext_open' | 'plaintext_parse'
      | 'plaintext_binding' | 'reset_admission' | 'managed_admission' | 'plaintext_limit';
    error?: unknown;
  }>) => void;
}>): Readonly<{ input: z.infer<typeof StrictJsonValueSchema> }> | null {
  let phase: Parameters<NonNullable<typeof params.onFailure>>[0]['phase'] = 'envelope_parse';
  const refused = (error?: unknown): null => {
    // Observability must not change cryptographic admission, even if a host's
    // diagnostic sink itself fails. No decoded value is sent to the witness.
    try { params.onFailure?.({ phase, ...(error === undefined ? {} : { error }) }); } catch { /* Best-effort witness. */ }
    return null;
  };
  try {
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse(params.envelope);
    phase = 'envelope_binding';
    if (envelope.requestId !== params.binding.requestId || !envelope.target
      || !externalActionTargetsEqualV1(envelope.target, params.binding.target) || !isExternalActionRequestWithinLimit(envelope)) return refused();
    phase = 'ciphertext_open';
    const plaintext = open(
      envelope.payload.c,
      params.material,
      EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
    );
    if (plaintext === null) return refused();
    phase = 'plaintext_parse';
    const decoded = RequestSchema.safeParse(plaintext);
    if (!decoded.success) return refused(decoded.error);
    phase = 'plaintext_binding';
    if (!matches(decoded.data, params.binding)) return refused();
    phase = 'managed_admission';
    const managedAdmission = projectExternalActionManagedAdmissionV1(decoded.data.actionId, decoded.data.input);
    if ((managedAdmission && managedAdmission.actionId !== 'machines.managed.acquire'
      || envelope.managedAdmission && envelope.managedAdmission.actionId !== 'machines.managed.acquire')
      && !sameStrictJsonValue(managedAdmission, envelope.managedAdmission)) return refused();
    phase = 'reset_admission';
    if (decoded.data.actionId === 'session.pending.resetStart.set') {
      const admission = projectExternalActionPendingResetStartAdmissionV1(decoded.data.input);
      if (!envelope.pendingResetStartAdmission || decoded.data.target.kind === 'session'
        && projectExternalActionPendingResetStartSessionDigestV1(decoded.data.target.sessionId) !== admission.sessionDigest
        || !sameStrictJsonValue(admission, envelope.pendingResetStartAdmission)) return refused();
    } else if (envelope.pendingResetStartAdmission) return refused();
    phase = 'plaintext_limit';
    return isExternalActionRequestWithinLimit({ v: 1, requestId: decoded.data.requestId,
      target: decoded.data.target, input: decoded.data.input }) ? { input: decoded.data.input } : refused();
  } catch (error) { return refused(error); }
}

/** Applies the existing result projection/ceiling once, then seals the complete outcome. */
export function prepareExternalActionResponseV2(params: SealOptions & Readonly<{
  binding: ExternalActionEncryptionBindingV2; request: ExternalActionRequestEnvelopeV2;
  executedMachineId: string; execution: unknown;
}>): PreparedExternalActionResponseEnvelope & Readonly<{ response: ExternalActionResponseEnvelopeV2 }> {
  const projected = prepareExternalActionResponseEnvelopeV1({ v: 1, actionId: params.binding.actionId,
    requestId: params.binding.requestId, execution: params.execution });
  const payload = ResponseSchema.parse({ ...params.binding, v: 2, direction: 'response',
    executedMachineId: params.executedMachineId,
    requestPayloadDigest: computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [params.request.payload.c]),
    execution: projected.response.execution });
  const response: ExternalActionResponseEnvelopeV2 = { v: 2, actionId: payload.actionId, requestId: payload.requestId,
    payload: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ ...params, kind, payload }) } };
  const body = JSON.stringify(response);
  return { response, body, byteLength: new TextEncoder().encode(body).byteLength };
}

export function openExternalActionResponseV2(params: Readonly<{
  envelope: unknown; binding: ExternalActionEncryptionBindingV2;
  request: ExternalActionRequestEnvelopeV2; material: Material;
}>): ActionExecuteResult | null {
  try {
    const envelope = ExternalActionResponseEnvelopeV2Schema.parse(params.envelope);
    if (envelope.actionId !== params.binding.actionId || envelope.requestId !== params.binding.requestId) return null;
    const decoded = ResponseSchema.safeParse(open(
      envelope.payload.c,
      params.material,
      EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
    ));
    if (!decoded.success || !matches(decoded.data, params.binding)
      || !StrictJsonValueSchema.safeParse(decoded.data).success
      || decoded.data.requestPayloadDigest !== computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [params.request.payload.c])
      || (params.binding.target.kind === 'machine' && decoded.data.executedMachineId !== params.binding.target.machineId)) return null;
    if (measureExternalActionResponseEnvelopeUtf8BytesV1({ v: 1, actionId: decoded.data.actionId,
      requestId: decoded.data.requestId, execution: decoded.data.execution }) > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) return null;
    return decoded.data.execution;
  } catch { return null; }
}
