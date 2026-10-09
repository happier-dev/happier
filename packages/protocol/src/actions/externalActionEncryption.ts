import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountApiTokenEncryptionAccessV1Schema, AccountApiTokenSummaryV1Schema } from '../auth/accountApiTokens.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES, ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES, ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES } from '../crypto/accountScopedCipherEnvelope.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
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
const ApiTokenBindingSchema = lazyZodSchema(() => z.object({
  serverIdentityId: AccountApiTokenEncryptionAccessV1Schema.shape.serverIdentityId,
  accountId: ExternalActionApiTokenServerPrincipalV1Schema.shape.accountId,
  credentialId: AccountApiTokenSummaryV1Schema.shape.tokenId,
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema,
}).strict());
const AccountBindingSchema = lazyZodSchema(() => z.object({ ...BindingRoutingShape(),
  // Ciphertext retains the signed credential kind and epoch, never a PAT-shaped alias or human upgrade.
  authentication: z.union([ExternalActionAccountAuthenticationV1Schema.omit({ evidence: true }),
    ExternalActionTerminalAuthenticationV1Schema.omit({ evidence: true })]),
}).strict());
const BindingSchema = lazyZodSchema(() => z.union([ApiTokenBindingSchema, AccountBindingSchema]));
export type ExternalActionEncryptionBindingV2 = Readonly<z.infer<typeof BindingSchema>>;

const requestShape = () => ({
  v: z.literal(2), direction: z.literal('request'), input: StrictJsonValueSchema,
});
const RequestSchema = lazyZodSchema(() => z.union([
  ApiTokenBindingSchema.extend(requestShape()).strict(), AccountBindingSchema.extend(requestShape()).strict(),
]));
const responseShape = () => ({
  v: z.literal(2), direction: z.literal('response'),
  executedMachineId: ExternalActionTargetV1Schema.options[0].shape.machineId,
  requestPayloadDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine((value) => (
    encodeBase64(decodeBase64(value, 'base64url'), 'base64url') === value
  )),
  execution: ExternalActionExecutionResultV1Schema,
});
const ResponseSchema = lazyZodSchema(() => z.union([
  ApiTokenBindingSchema.extend(responseShape()).strict(), AccountBindingSchema.extend(responseShape()).strict(),
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
  managedAdmission?: ExternalActionRequestEnvelopeV2['managedAdmission'];
  sessionSpawnAdmission?: ExternalActionRequestEnvelopeV2['sessionSpawnAdmission'];
}>): ExternalActionRequestEnvelopeV2 {
  const payload = RequestSchema.parse({ ...params.binding, v: 2, direction: 'request', input: params.input });
  if (params.material.type !== 'dataKey' || params.material.machineKey.length !== 32) throw new TypeError('Invalid external Action material');
  if (!isExternalActionRequestWithinLimit({ v: 1, requestId: payload.requestId, target: payload.target, input: payload.input })) {
    throw new RangeError('External Action request exceeds its decoded limit');
  }
  const envelope: ExternalActionRequestEnvelopeV2 = { v: 2, requestId: payload.requestId, target: payload.target,
    payload: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ ...params, kind, payload }) },
    ...(params.managedAdmission ? { managedAdmission: params.managedAdmission } : {}),
    ...(params.sessionSpawnAdmission ? { sessionSpawnAdmission: params.sessionSpawnAdmission } : {}) };
  if (!isExternalActionRequestWithinLimit(envelope)) {
    throw new RangeError('External Action request exceeds its protected wire limit');
  }
  return envelope;
}

/** No error details from unauthenticated plaintext may cross this boundary. */
export function openExternalActionRequestV2(params: Readonly<{
  envelope: unknown; binding: ExternalActionEncryptionBindingV2; material: Material;
}>): Readonly<{ input: z.infer<typeof StrictJsonValueSchema> }> | null {
  try {
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse(params.envelope);
    if (envelope.requestId !== params.binding.requestId || !envelope.target
      || !externalActionTargetsEqualV1(envelope.target, params.binding.target) || !isExternalActionRequestWithinLimit(envelope)) return null;
    const decoded = RequestSchema.safeParse(open(
      envelope.payload.c,
      params.material,
      EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
    ));
    if (!decoded.success || !matches(decoded.data, params.binding)) return null;
    return isExternalActionRequestWithinLimit({ v: 1, requestId: decoded.data.requestId,
      target: decoded.data.target, input: decoded.data.input }) ? { input: decoded.data.input } : null;
  } catch { return null; }
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
