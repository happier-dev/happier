import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../auth/authToken.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { IrohEndpointDescriptorV1Schema, IrohEndpointIdV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { DirectRouteGrantSignatureV2Schema } from '../machines/peer/mediation/directRouteGrantV2.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { TeamCredentialSourceBindingV1Schema } from '../teams/credentials/sourceBindingV1.js';
import { TeamCredentialUsageLimitDenialV1Schema } from '../teams/credentials/usageV1.js';
import { ProviderWireProtocolSchema } from './capabilities/v1.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderLocalIdSchema } from './ids.js';
import { ProviderConnectionSecurityFingerprintV1Schema, ProviderManagedRuntimeBindingFingerprintV1Schema } from './fingerprints.js';

export const PROVIDER_BROKER_ROUTE_AUDIENCE_V1 = 'happier-provider-broker-route-v1' as const;
export const PROVIDER_BROKER_OPEN_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/open' as const;
export const PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/admit' as const;
export const PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/models/authorize' as const;
/** Home-owned Runner readiness admission route, with the same `:resourceId`
 * param the route registrar binds. One template so the daemon client and the
 * route registrar cannot drift. */
export const PROVIDER_BROKER_READINESS_AUTHORIZE_HTTP_PATH_V1 = '/v1/teams/credential-resources/:resourceId/broker/readiness/authorize' as const;
/** Native machine.rs bounds HTTP headers at 16 KiB and generates a 32-byte
 * capability encoded as 64 hex characters. Reserve exactly the two mandatory
 * ASCII header lines, not a separate policy quota. Native ingress still owns
 * the total budget including the request line and all other headers.
 */
const BROKER_AUTHORITY_HEADER_OVERHEAD_BYTES =
  'Authorization: Bearer \r\nX-Happier-Machine-Local-Capability: \r\n'.length + 64;
export const PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES = 16 * 1024 - BROKER_AUTHORITY_HEADER_OVERHEAD_BYTES;

const IdentitySchema = lazyZodSchema(() => z.string().min(1));
export const ProviderBrokerConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: IdentitySchema }).strict(),
  z.object({ kind: z.literal('execution_run'), executionRunId: IdentitySchema }).strict(),
]));

/**
 * Exact managed Provider application selected by the Session/Run owner.
 * Credential-resource source identity and purpose bindings remain separate:
 * the target daemon resolves those only from current Home admission.
 */
export const ProviderBrokerApplicationBindingV1Schema = lazyZodSchema(() => z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
  endpointTemplateId: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
}).strict());

/** Dedicated, recursively closed machine/1 authority. Mutable request policy is
 * deliberately absent: current Home admission owns it for every Provider call.
 *
 * The resource revision is intentionally absent too. It is a mutable policy
 * fact the Home rechecks online, against the revision each request presents, on
 * every open and every request; signing it would stale an otherwise active
 * Session-open or Run claim after a harmless resource edit without improving
 * revocation (`04-private-iroh-broker-transport.md:272`).
 *
 * The model id is absent for the same reason: it is a current request fact
 * (`04-private-iroh-broker-transport.md:270`). One open serves every model the
 * resource currently allows; the broker's request-policy owner evaluates each
 * request's model against the resource's current allowlist.
 */
export const ProviderBrokerRouteGrantPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  grantId: IdentitySchema,
  aud: z.literal(PROVIDER_BROKER_ROUTE_AUDIENCE_V1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  teamId: IdentitySchema,
  resourceId: IdentitySchema,
  sourceRevision: z.string().trim().min(1).max(512),
  /** Home-computed original resource placement, without disclosing a Pool id.
   * Unlike policy revisions or membership, relocation ends this authority. */
  brokerPlacementFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** Epoch of the exact signed opening credential. Home rechecks revocation on every request. */
  initiatorTokenEpoch: z.number().int().nonnegative(),
  initiator: z.object({ accountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }).strict(),
  target: z.object({ custodianAccountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }).strict(),
  consumer: ProviderBrokerConsumerV1Schema,
  executionRunOccurrenceId: IdentitySchema.optional(),
  application: ProviderBrokerApplicationBindingV1Schema,
  /** Immutable provenance: the authentication evidence of the exact credential
   * that opened this operation, verified by the Home when it signed the open.
   * It is not an authorization decision. Every request re-evaluates it against
   * the Team's current policy and the evidence's current identity/connection
   * state, so revoking or restricting ends the next request on an existing
   * stream (`04-private-iroh-broker-transport.md` §5.6). Absent when the
   * credential carried no evidence. Same carrier as the resource-test relay
   * binding's `verifiedCredentialEvidence`. */
  verifiedCredentialEvidence: AuthTokenAuthenticationEvidenceSnapshotV1Schema.optional(),
}).strict().superRefine((payload, context) => {
  if (payload.expiresAt <= payload.issuedAt) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow issue time' });
  }
  if (payload.initiator.accountId === payload.target.custodianAccountId) {
    context.addIssue({ code: 'custom', path: ['target', 'custodianAccountId'], message: 'Broker Accounts must be distinct' });
  }
  if (payload.initiator.machineId === payload.target.machineId) {
    context.addIssue({ code: 'custom', path: ['target', 'machineId'], message: 'Broker Machines must be distinct' });
  }
  if (payload.initiator.endpointId === payload.target.endpointId) {
    context.addIssue({ code: 'custom', path: ['target', 'endpointId'], message: 'Broker endpoints must be distinct' });
  }
  if ((payload.consumer.kind === 'execution_run') !== (payload.executionRunOccurrenceId !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['executionRunOccurrenceId'],
      message: 'Execution-run grants must bind exactly one current occurrence',
    });
  }
}));

export const SignedProviderBrokerRouteGrantV1Schema = lazyZodSchema(() => z.object({
  payload: ProviderBrokerRouteGrantPayloadV1Schema,
  signature: DirectRouteGrantSignatureV2Schema,
}).strict().superRefine((authority, context) => {
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(authority));
  if (Math.ceil(bytes.byteLength * 8 / 6) > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES) {
    context.addIssue({ code: 'custom', message: 'Encoded broker authority exceeds the native HTTP header budget' });
  }
}));

export const IrohProviderBrokerHandshakeV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('provider_broker'),
  authority: SignedProviderBrokerRouteGrantV1Schema,
}).strict());

export const ProviderBrokerOpenRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  resourceId: IdentitySchema,
  expectedResourceRevision: z.number().int().nonnegative(),
  modelId: z.string().trim().min(1).max(512),
  sourceRevision: z.string().trim().min(1).max(512),
  initiatorMachineId: IdentitySchema,
  consumer: ProviderBrokerConsumerV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  /** A previously Home-signed open may be presented only to reauthorize its
   * exact target for another carrier handshake. The Home verifies and
   * revalidates every current resource/source/Machine fact before re-signing. */
  refreshAuthority: SignedProviderBrokerRouteGrantV1Schema.optional(),
}).strict());

export const ProviderBrokerRequestFactsV1Schema = lazyZodSchema(() => z.object({
  generation: z.boolean(),
  routeKind: z.enum([
    'openai_responses',
    'openai_chat_completions',
    'anthropic_messages',
  ]),
  modelId: z.string(),
  reasoningEffort: z.string().nullable(),
}).strict());

export const ProviderBrokerRequestAdmissionV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  authority: SignedProviderBrokerRouteGrantV1Schema,
  expectedResourceRevision: z.number().int().nonnegative(),
  sourceMemberKey: z.string().trim().min(1).max(512),
  requestId: IdentitySchema,
  requestFacts: ProviderBrokerRequestFactsV1Schema,
}).strict());

/** Metadata authorization has no request id or inference facts because it
 * cannot reserve allowance, record usage, or acquire Provider credentials. */
export const ProviderBrokerModelCatalogAuthorizationV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  authority: SignedProviderBrokerRouteGrantV1Schema,
  expectedResourceRevision: z.number().int().nonnegative(),
}).strict());

export const ProviderBrokerAdmissionFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'resource_forbidden',
  'resource_unavailable',
  'resource_changed',
  'session_not_active',
  'operation_not_current',
  'execution_run_not_found',
  'execution_run_terminal',
  'execution_run_authority_unavailable',
  'broker_unavailable',
  'update_required',
  'team_credential_usage_limit',
  'token_limit_unavailable',
  'cost_limit_unavailable',
  'duplicate_request',
]));

const ProviderBrokerAdmissionFailureV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  reasonCode: ProviderBrokerAdmissionFailureCodeV1Schema,
  /** Present only for an exhausted Team-resource ceiling. It intentionally
   * excludes limit, audience and member identities. */
  usageLimit: TeamCredentialUsageLimitDenialV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.usageLimit && value.reasonCode !== 'team_credential_usage_limit') {
    context.addIssue({ code: 'custom', path: ['usageLimit'], message: 'usageLimit requires an exhausted Team credential limit' });
  }
}));

/**
 * Typed body of a broker application refusal (HTTP 403 on the private
 * loopback endpoint). It carries the same closed admission vocabulary and the
 * recipient-safe limit facts so the worker can raise one typed Session runtime
 * issue instead of an anonymous provider error; identities beyond the resource
 * the requester already selected are deliberately absent.
 */
export const ProviderBrokerRefusalV1Schema = lazyZodSchema(() => z.object({
  error: z.object({
    type: z.literal('happier_provider_broker_error'),
    code: ProviderBrokerAdmissionFailureCodeV1Schema,
    resourceId: IdentitySchema,
    usageLimit: TeamCredentialUsageLimitDenialV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.usageLimit && value.code !== 'team_credential_usage_limit') {
      context.addIssue({ code: 'custom', path: ['usageLimit'], message: 'usageLimit requires an exhausted Team credential limit' });
    }
  }),
}).strict());
export type ProviderBrokerRefusalV1 = z.infer<typeof ProviderBrokerRefusalV1Schema>;

export const ProviderBrokerOpenResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    authority: SignedProviderBrokerRouteGrantV1Schema,
    target: z.object({
      custodianAccountId: IdentitySchema,
      brokerMachineId: IdentitySchema,
      endpointId: IrohEndpointIdV1Schema,
      endpointRevision: z.number().int().nonnegative(),
      endpoint: IrohEndpointDescriptorV1Schema,
    }).strict().superRefine((target, context) => {
      if (target.endpoint.endpointId !== target.endpointId) {
        context.addIssue({ code: 'custom', path: ['endpoint', 'endpointId'], message: 'Descriptor identity must match the broker target endpoint' });
      }
    }),
  }).strict(),
  ProviderBrokerAdmissionFailureV1Schema,
]));

export const ProviderBrokerRequestAdmissionResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    resourceId: IdentitySchema,
    brokerMachineId: IdentitySchema,
    source: TeamCredentialSourceBindingV1Schema,
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('session'), sessionId: IdentitySchema }).strict(),
      z.object({ kind: z.literal('execution_run'), executionRunId: IdentitySchema }).strict(),
    ]),
    usageEventId: IdentitySchema.nullable(),
  }).strict(),
  ProviderBrokerAdmissionFailureV1Schema,
]));

export const ProviderBrokerModelCatalogAuthorizationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  ProviderBrokerAdmissionFailureV1Schema,
]));

export type ProviderBrokerConsumerV1 = z.infer<typeof ProviderBrokerConsumerV1Schema>;
export type ProviderBrokerApplicationBindingV1 = z.infer<typeof ProviderBrokerApplicationBindingV1Schema>;
/** The one admission-failure vocabulary for broker open and per-request admission. */
export type ProviderBrokerAdmissionFailureCodeV1 = z.infer<typeof ProviderBrokerAdmissionFailureCodeV1Schema>;
export type ProviderBrokerRouteGrantPayloadV1 = z.infer<typeof ProviderBrokerRouteGrantPayloadV1Schema>;
export type SignedProviderBrokerRouteGrantV1 = z.infer<typeof SignedProviderBrokerRouteGrantV1Schema>;
export type IrohProviderBrokerHandshakeV1 = z.infer<typeof IrohProviderBrokerHandshakeV1Schema>;
export type ProviderBrokerOpenRequestV1 = z.infer<typeof ProviderBrokerOpenRequestV1Schema>;
export type ProviderBrokerRequestFactsV1 = z.infer<typeof ProviderBrokerRequestFactsV1Schema>;
export type ProviderBrokerRequestAdmissionV1 = z.infer<typeof ProviderBrokerRequestAdmissionV1Schema>;
export type ProviderBrokerModelCatalogAuthorizationV1 = z.infer<typeof ProviderBrokerModelCatalogAuthorizationV1Schema>;
export type ProviderBrokerOpenResponseV1 = z.infer<typeof ProviderBrokerOpenResponseV1Schema>;
export type ProviderBrokerRequestAdmissionResponseV1 = z.infer<typeof ProviderBrokerRequestAdmissionResponseV1Schema>;
export type ProviderBrokerModelCatalogAuthorizationResponseV1 = z.infer<typeof ProviderBrokerModelCatalogAuthorizationResponseV1Schema>;

export function createProviderBrokerRouteGrantSigningInputV1(payload: ProviderBrokerRouteGrantPayloadV1): string {
  return createCanonicalJsonSigningInput(ProviderBrokerRouteGrantPayloadV1Schema.parse(payload));
}

export function encodeProviderBrokerAuthorityV1(authority: SignedProviderBrokerRouteGrantV1): string {
  const parsed = SignedProviderBrokerRouteGrantV1Schema.parse(authority);
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(parsed)), 'base64url');
}

/** Accept only the compact signed envelope, never a Bearer prefix or handshake. */
export function decodeProviderBrokerAuthorityV1(encoded: string): SignedProviderBrokerRouteGrantV1 | null {
  if (encoded.length > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const bytes = decodeBase64(encoded, 'base64url');
    if (encodeBase64(bytes, 'base64url') !== encoded) return null;
    const parsed = SignedProviderBrokerRouteGrantV1Schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Epoch 2 adds personal connection authority. Epoch 1 remains the closed Team
 * authority: a personal connection can never be reinterpreted as a resource. */
export const PROVIDER_BROKER_ROUTE_AUDIENCE_V2 = 'happier-provider-broker-route-v2' as const;
export const PROVIDER_BROKER_ACCOUNT_OPEN_HTTP_PATH_V2 = '/v2/providers/broker/open' as const;
export const PROVIDER_BROKER_ACCOUNT_ADMIT_HTTP_PATH_V2 = '/v2/providers/broker/admit' as const;

export const ProviderBrokerAccountSourceV2Schema = lazyZodSchema(() => z.object({
  kind: z.literal('account_connection'),
  connectionId: ProviderConnectionIdSchema,
  expectedConnectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.transform((value): string => value),
  expectedManagedRuntimeBindingFingerprint: ProviderManagedRuntimeBindingFingerprintV1Schema,
}).strict());

export const ProviderBrokerRouteGrantPayloadV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  grantId: IdentitySchema,
  aud: z.literal(PROVIDER_BROKER_ROUTE_AUDIENCE_V2),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  homeId: IdentitySchema,
  accountId: IdentitySchema,
  source: ProviderBrokerAccountSourceV2Schema,
  initiatorTokenEpoch: z.number().int().nonnegative(),
  initiator: z.object({ accountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }).strict(),
  target: z.object({ custodianAccountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }).strict(),
  consumer: ProviderBrokerConsumerV1Schema,
  executionRunOccurrenceId: IdentitySchema.optional(),
  application: ProviderBrokerApplicationBindingV1Schema,
}).strict().superRefine((payload, context) => {
  if (payload.expiresAt <= payload.issuedAt) context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow issue time' });
  if (payload.initiator.accountId !== payload.accountId || payload.target.custodianAccountId !== payload.accountId) {
    context.addIssue({ code: 'custom', path: ['accountId'], message: 'Personal broker authority is confined to one Account' });
  }
  if (payload.initiator.machineId === payload.target.machineId || payload.initiator.endpointId === payload.target.endpointId) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'A hub route must connect distinct Machines and endpoints' });
  }
  if ((payload.consumer.kind === 'execution_run') !== (payload.executionRunOccurrenceId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['executionRunOccurrenceId'], message: 'Execution-run grants bind one current occurrence' });
  }
}));

export const SignedProviderBrokerRouteGrantV2Schema = lazyZodSchema(() => z.object({
  payload: ProviderBrokerRouteGrantPayloadV2Schema,
  signature: DirectRouteGrantSignatureV2Schema,
}).strict().superRefine((authority, context) => {
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(authority));
  if (Math.ceil(bytes.byteLength * 8 / 6) > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES) {
    context.addIssue({ code: 'custom', message: 'Encoded broker authority exceeds the native HTTP header budget' });
  }
}));
export const IrohProviderBrokerHandshakeV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2), kind: z.literal('provider_broker'), authority: SignedProviderBrokerRouteGrantV2Schema,
  // An unsigned intent may only narrow the signed authority to retirement.
  intent: z.literal('release').optional(),
}).strict());
export const IrohProviderBrokerHandshakeSchema = lazyZodSchema(() => z.union([
  IrohProviderBrokerHandshakeV1Schema, IrohProviderBrokerHandshakeV2Schema,
]));
export const ProviderBrokerAccountOpenRequestV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2), source: ProviderBrokerAccountSourceV2Schema,
  initiatorMachineId: IdentitySchema, targetMachineId: IdentitySchema,
  consumer: ProviderBrokerConsumerV1Schema, application: ProviderBrokerApplicationBindingV1Schema,
  refreshAuthority: SignedProviderBrokerRouteGrantV2Schema.optional(),
}).strict().superRefine((request, context) => {
  if (request.initiatorMachineId === request.targetMachineId) {
    context.addIssue({ code: 'custom', path: ['targetMachineId'], message: 'Personal hub requests require distinct Machines' });
  }
}));
export const ProviderBrokerAccountOpenResponseV2Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true), authority: SignedProviderBrokerRouteGrantV2Schema,
    target: z.object({
      custodianAccountId: IdentitySchema, brokerMachineId: IdentitySchema,
      endpointId: IrohEndpointIdV1Schema, endpointRevision: z.number().int().nonnegative(), endpoint: IrohEndpointDescriptorV1Schema,
    }).strict().superRefine((target, context) => {
      if (target.endpoint.endpointId !== target.endpointId) context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Descriptor identity must match target' });
    }),
  }).strict(),
  ProviderBrokerAdmissionFailureV1Schema,
]));
export const ProviderBrokerAccountAdmissionV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2), authority: SignedProviderBrokerRouteGrantV2Schema,
}).strict());
export const ProviderBrokerAccountAdmissionResponseV2Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(), ProviderBrokerAdmissionFailureV1Schema,
]));
export type ProviderBrokerRouteGrantPayloadV2 = z.infer<typeof ProviderBrokerRouteGrantPayloadV2Schema>;
export type SignedProviderBrokerRouteGrantV2 = z.infer<typeof SignedProviderBrokerRouteGrantV2Schema>;
export type IrohProviderBrokerHandshakeV2 = z.infer<typeof IrohProviderBrokerHandshakeV2Schema>;
export type IrohProviderBrokerHandshake = z.infer<typeof IrohProviderBrokerHandshakeSchema>;
export type ProviderBrokerAccountOpenRequestV2 = z.infer<typeof ProviderBrokerAccountOpenRequestV2Schema>;
export type ProviderBrokerAccountOpenResponseV2 = z.infer<typeof ProviderBrokerAccountOpenResponseV2Schema>;
export type ProviderBrokerAccountAdmissionV2 = z.infer<typeof ProviderBrokerAccountAdmissionV2Schema>;
export type ProviderBrokerAccountAdmissionResponseV2 = z.infer<typeof ProviderBrokerAccountAdmissionResponseV2Schema>;

export function createProviderBrokerRouteGrantSigningInputV2(payload: ProviderBrokerRouteGrantPayloadV2): string {
  return createCanonicalJsonSigningInput(ProviderBrokerRouteGrantPayloadV2Schema.parse(payload));
}
export function encodeProviderBrokerAuthorityV2(authority: SignedProviderBrokerRouteGrantV2): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(SignedProviderBrokerRouteGrantV2Schema.parse(authority))), 'base64url');
}
