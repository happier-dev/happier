import { ActionExecuteResultSchema, ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../connect/connectedServiceUxDiagnostics.js';

import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../auth/authToken.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { IrohEndpointDescriptorV1Schema, IrohEndpointIdV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { DirectRouteGrantSignatureV2Schema } from '../machines/peer/mediation/directRouteGrantV2.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { TeamCredentialActionOperationConsumerV1Schema } from '../teams/credentials/actionOperationV1.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { TeamCredentialSourceBindingV1Schema } from '../teams/credentials/sourceBindingV1.js';
import { TeamCredentialUsageLimitDenialV1Schema } from '../teams/credentials/usageV1.js';
import { ProviderWireProtocolSchema } from './capabilities/v1.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderLocalIdSchema } from './ids.js';
import { ProviderConnectionSecurityFingerprintV1Schema, ProviderManagedRuntimeBindingFingerprintV1Schema } from './fingerprints.js';

export const PROVIDER_BROKER_ROUTE_AUDIENCE_V1 = 'happier-provider-broker-route-v1' as const;
export const PROVIDER_BROKER_OPEN_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/open' as const;
export const PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/admit' as const;
export const PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1 = '/v1/teams/credential-resources/broker/models/authorize' as const;
/** Private broker wire metadata; these never carry upstream credentials. */
export const PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER = 'x-happier-provider-broker-close-request-id' as const;
export const PROVIDER_BROKER_ENDPOINT_PATH_HEADER = 'x-happier-provider-endpoint-path' as const;
export const PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER = 'x-happier-provider-broker-error-code' as const;
export const PROVIDER_BROKER_MODEL_ID_HEADER = 'x-happier-provider-model-id' as const;
export const PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER = 'x-happier-provider-broker-limit-metric' as const;
export const PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER = 'x-happier-provider-broker-limit-remaining' as const;
export const PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER = 'x-happier-provider-broker-limit-resets-at' as const;
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

const IdentitySchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const runtimeConsumerVariants = [
  lazyZodSchema(() => z.strictObject({ kind: z.literal('session'), sessionId: IdentitySchema })),
  lazyZodSchema(() => z.strictObject({ kind: z.literal('execution_run'), executionRunId: IdentitySchema })),
] as const;
/** The canonical consumer vocabulary; model-only contracts use its runtime subset. */
export const ProviderBrokerConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ...runtimeConsumerVariants, TeamCredentialActionOperationConsumerV1Schema,
]));
export const ProviderBrokerRuntimeConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', runtimeConsumerVariants));
export type ProviderBrokerRuntimeConsumerV1 = z.infer<typeof ProviderBrokerRuntimeConsumerV1Schema>;

/**
 * Exact executable Provider source application. External clients need no
 * consuming Agent. Worker authorities additionally require the target below.
 * Source credentials and purpose bindings still resolve from Home admission.
 */
export const ProviderBrokerSourceApplicationBindingV1Schema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: z.optional(ProviderAgentTargetKeySchema),
  implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
  endpointTemplateId: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
}));
export type ProviderBrokerSourceApplicationBindingV1 = z.infer<typeof ProviderBrokerSourceApplicationBindingV1Schema>;

/** Session and Run authorities additionally bind the consuming Agent. */
export const ProviderBrokerApplicationBindingV1Schema = lazyZodSchema(() => z.extend(ProviderBrokerSourceApplicationBindingV1Schema, {
  agentTargetKey: ProviderAgentTargetKeySchema,
}));

/** Dedicated, recursively closed machine/1 authority. The Home admits the
 * requested resource policy and model when the broker job opens or refreshes.
 * The resource revision is bound inside the opaque job fingerprint below;
 * current-resource lookup ends the admitted job after a revision change.
 */
export const ProviderBrokerRouteGrantPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  grantId: IdentitySchema,
  aud: z.literal(PROVIDER_BROKER_ROUTE_AUDIENCE_V1),
  issuedAt: z.number().check(z.int(), z.nonnegative()),
  expiresAt: z.number().check(z.int(), z.positive()),
  teamId: IdentitySchema,
  resourceId: IdentitySchema,
  sourceRevision: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  /** Home-computed opaque job fingerprint binding placement and the admitted
   * resource revision, without disclosing a Pool id. */
  brokerPlacementFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  /** Epoch of the exact signed opening credential. Home rechecks revocation on every request. */
  initiatorTokenEpoch: z.number().check(z.int(), z.nonnegative()),
  initiator: z.strictObject({ accountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
  target: z.strictObject({ custodianAccountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
  consumer: ProviderBrokerRuntimeConsumerV1Schema,
  executionRunOccurrenceId: z.optional(IdentitySchema),
  application: ProviderBrokerApplicationBindingV1Schema,
  /** Immutable provenance: authentication evidence verified when the Home
   * admitted this job. Absent when the credential carried no evidence. Same
   * carrier as the resource-test relay binding's `verifiedCredentialEvidence`. */
  verifiedCredentialEvidence: z.optional(AuthTokenAuthenticationEvidenceSnapshotV1Schema),
}).check(z.superRefine((payload, context) => {
  if (payload.expiresAt <= payload.issuedAt) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow issue time' });
  }
  if (payload.initiator.accountId === payload.target.custodianAccountId) {
    context.addIssue({ code: 'custom', path: ['target', 'custodianAccountId'], message: 'Broker Accounts must be distinct' });
  }
  if ((payload.initiator.machineId === payload.target.machineId) !== (payload.initiator.endpointId === payload.target.endpointId)) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Broker Machine and endpoint identities must agree' });
  }
  if ((payload.consumer.kind === 'execution_run') !== (payload.executionRunOccurrenceId !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['executionRunOccurrenceId'],
      message: 'Execution-run grants must bind exactly one current occurrence',
    });
  }
})));

export const SignedProviderBrokerRouteGrantV1Schema = lazyZodSchema(() => z.strictObject({
  payload: ProviderBrokerRouteGrantPayloadV1Schema,
  signature: DirectRouteGrantSignatureV2Schema,
}).check(z.superRefine((authority, context) => {
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(authority));
  if (Math.ceil(bytes.byteLength * 8 / 6) > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES) {
    context.addIssue({ code: 'custom', message: 'Encoded broker authority exceeds the native HTTP header budget' });
  }
})));

export const IrohProviderBrokerHandshakeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('provider_broker'),
  authority: SignedProviderBrokerRouteGrantV1Schema,
}));

export const ProviderBrokerOpenRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  resourceId: IdentitySchema,
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  modelId: z.string().check(z.trim(), z.minLength(1)),
  sourceRevision: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  initiatorMachineId: IdentitySchema,
  consumer: ProviderBrokerRuntimeConsumerV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  /** A previously Home-signed open may be presented only to reauthorize its
   * exact target for another carrier handshake. The Home verifies and
   * revalidates every current resource/source/Machine fact before re-signing. */
  refreshAuthority: z.optional(SignedProviderBrokerRouteGrantV1Schema),
}));

export const ProviderBrokerRequestFactsV1Schema = lazyZodSchema(() => z.strictObject({
  generation: z.boolean(),
  routeKind: z.enum([
    'openai_responses',
    'openai_chat_completions',
    'anthropic_messages',
  ]),
  modelId: z.string(),
  reasoningEffort: z.nullable(z.string()),
}));

export const ProviderBrokerRequestAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authority: SignedProviderBrokerRouteGrantV1Schema,
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  sourceMemberKey: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  requestId: IdentitySchema,
  requestFacts: ProviderBrokerRequestFactsV1Schema,
}));

/** Metadata authorization has no request id or inference facts because it
 * cannot reserve allowance, record usage, or acquire Provider credentials. */
export const ProviderBrokerModelCatalogAuthorizationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authority: SignedProviderBrokerRouteGrantV1Schema,
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
}));

export const ProviderBrokerAdmissionFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
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

/** Closed source prerequisites safe for requester diagnostics; never raw exception text. */
export const ProviderBrokerSourceOpenFailureReasonV1Schema = lazyZodSchema(() => z.enum([
  'broker_machine_mismatch',
  'request_cancelled',
  'application_unavailable',
  'source_protocol_mismatch',
  'account_snapshot_unavailable',
  'provider_catalog_unavailable',
  'endpoint_resolution_unavailable',
  'endpoint_selection_unavailable',
  'activation_occurrence_unavailable',
  'source_selection_unavailable',
  'resource_not_current',
  'purpose_binding_unavailable',
  'source_currentness_unknown',
  'source_not_current',
  'projection_not_current',
  'managed_custody_unavailable',
]));
export type ProviderBrokerSourceOpenFailureReasonV1 = z.infer<typeof ProviderBrokerSourceOpenFailureReasonV1Schema>;

const ProviderBrokerAdmissionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  reasonCode: ProviderBrokerAdmissionFailureCodeV1Schema,
  sourceOpenFailureReason: z.optional(ProviderBrokerSourceOpenFailureReasonV1Schema),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  /** Present only for an exhausted Team-resource ceiling. It intentionally
   * excludes limit, audience and member identities. */
  usageLimit: z.optional(TeamCredentialUsageLimitDenialV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.usageLimit && value.reasonCode !== 'team_credential_usage_limit') {
    context.addIssue({ code: 'custom', path: ['usageLimit'], message: 'usageLimit requires an exhausted Team credential limit' });
  }
})));

/**
 * Typed body of a broker application refusal (HTTP 403 on the private
 * loopback endpoint). It carries the same closed admission vocabulary and the
 * recipient-safe limit facts so the worker can raise one typed Session runtime
 * issue instead of an anonymous provider error; identities beyond the resource
 * the requester already selected are deliberately absent.
 */
export const ProviderBrokerRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.strictObject({
    type: z.literal('happier_provider_broker_error'),
    code: ProviderBrokerAdmissionFailureCodeV1Schema,
    resourceId: IdentitySchema,
    usageLimit: z.optional(TeamCredentialUsageLimitDenialV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.usageLimit && value.code !== 'team_credential_usage_limit') {
      context.addIssue({ code: 'custom', path: ['usageLimit'], message: 'usageLimit requires an exhausted Team credential limit' });
    }
  })),
}));
export type ProviderBrokerRefusalV1 = z.infer<typeof ProviderBrokerRefusalV1Schema>;

export const ProviderBrokerOpenTargetV1Schema = lazyZodSchema(() => z.strictObject({
      custodianAccountId: IdentitySchema,
      brokerMachineId: IdentitySchema,
      endpointId: IrohEndpointIdV1Schema,
      endpointRevision: z.number().check(z.int(), z.nonnegative()),
      endpoint: IrohEndpointDescriptorV1Schema,
    }).check(z.superRefine((target, context) => {
      if (target.endpoint.endpointId !== target.endpointId) {
        context.addIssue({ code: 'custom', path: ['endpoint', 'endpointId'], message: 'Descriptor identity must match the broker target endpoint' });
      }
    })));

export const ProviderBrokerOpenResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    authority: SignedProviderBrokerRouteGrantV1Schema,
    target: ProviderBrokerOpenTargetV1Schema,
  }),
  ProviderBrokerAdmissionFailureV1Schema,
]));

export const ProviderBrokerRequestAdmissionResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    resourceId: IdentitySchema,
    brokerMachineId: IdentitySchema,
    source: TeamCredentialSourceBindingV1Schema,
    operation: ProviderBrokerConsumerV1Schema,
    usageEventId: z.nullable(IdentitySchema),
  }),
  ProviderBrokerAdmissionFailureV1Schema,
]));

export const ProviderBrokerModelCatalogAuthorizationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
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

export const ProviderBrokerAccountSourceV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account_connection'),
  connectionId: ProviderConnectionIdSchema,
  expectedConnectionSecurityFingerprint: z.pipe(ProviderConnectionSecurityFingerprintV1Schema, z.transform((value): string => value)),
  expectedManagedRuntimeBindingFingerprint: ProviderManagedRuntimeBindingFingerprintV1Schema,
}));

export const ProviderBrokerRouteGrantPayloadV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  grantId: IdentitySchema,
  aud: z.literal(PROVIDER_BROKER_ROUTE_AUDIENCE_V2),
  issuedAt: z.number().check(z.int(), z.nonnegative()),
  expiresAt: z.number().check(z.int(), z.positive()),
  homeId: IdentitySchema,
  accountId: IdentitySchema,
  source: ProviderBrokerAccountSourceV2Schema,
  initiatorTokenEpoch: z.number().check(z.int(), z.nonnegative()),
  initiator: z.strictObject({ accountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
  target: z.strictObject({ custodianAccountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
  consumer: ProviderBrokerRuntimeConsumerV1Schema,
  executionRunOccurrenceId: z.optional(IdentitySchema),
  application: ProviderBrokerApplicationBindingV1Schema,
}).check(z.superRefine((payload, context) => {
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
})));

export const SignedProviderBrokerRouteGrantV2Schema = lazyZodSchema(() => z.strictObject({
  payload: ProviderBrokerRouteGrantPayloadV2Schema,
  signature: DirectRouteGrantSignatureV2Schema,
}).check(z.superRefine((authority, context) => {
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(authority));
  if (Math.ceil(bytes.byteLength * 8 / 6) > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES) {
    context.addIssue({ code: 'custom', message: 'Encoded broker authority exceeds the native HTTP header budget' });
  }
})));
export const IrohProviderBrokerHandshakeV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), kind: z.literal('provider_broker'), authority: SignedProviderBrokerRouteGrantV2Schema,
  // An unsigned intent may only narrow the signed authority to retirement.
  intent: z.optional(z.literal('release')),
}));
export const IrohProviderBrokerHandshakeSchema = lazyZodSchema(() => z.union([
  IrohProviderBrokerHandshakeV1Schema, IrohProviderBrokerHandshakeV2Schema, IrohProviderBrokerActionHandshakeV3Schema,
]));
export const ProviderBrokerAccountOpenRequestV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), source: ProviderBrokerAccountSourceV2Schema,
  initiatorMachineId: IdentitySchema, targetMachineId: IdentitySchema,
  consumer: ProviderBrokerRuntimeConsumerV1Schema, application: ProviderBrokerApplicationBindingV1Schema,
  refreshAuthority: z.optional(SignedProviderBrokerRouteGrantV2Schema),
}).check(z.superRefine((request, context) => {
  if (request.initiatorMachineId === request.targetMachineId) {
    context.addIssue({ code: 'custom', path: ['targetMachineId'], message: 'Personal hub requests require distinct Machines' });
  }
})));
export const ProviderBrokerAccountOpenResponseV2Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true), authority: SignedProviderBrokerRouteGrantV2Schema,
    target: z.strictObject({
      custodianAccountId: IdentitySchema, brokerMachineId: IdentitySchema,
      endpointId: IrohEndpointIdV1Schema, endpointRevision: z.number().check(z.int(), z.nonnegative()), endpoint: IrohEndpointDescriptorV1Schema,
    }).check(z.superRefine((target, context) => {
      if (target.endpoint.endpointId !== target.endpointId) context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Descriptor identity must match target' });
    })),
  }),
  ProviderBrokerAdmissionFailureV1Schema,
]));
export const ProviderBrokerAccountAdmissionV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), authority: SignedProviderBrokerRouteGrantV2Schema,
}));
export const ProviderBrokerAccountAdmissionResponseV2Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }), ProviderBrokerAdmissionFailureV1Schema,
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

/** Finite declared Actions use their own closed authority epoch, with no model
 * application or credential disclosure. Existing inference epochs retain their
 * exact shapes. The source is the Home-admitted snapshot for this finite job. */
export const PROVIDER_BROKER_ACTION_ROUTE_AUDIENCE_V3 = 'happier-provider-broker-action-v3' as const;
export const PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3 = '/v1/_happier/provider-broker/action' as const;
export const ProviderBrokerActionOpenRequestV3Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(3),
  resourceId: IdentitySchema,
  initiatorMachineId: IdentitySchema,
  consumer: TeamCredentialActionOperationConsumerV1Schema,
  inputDigest: IdentitySchema,
}));
export const ProviderBrokerActionRouteGrantPayloadV3Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(3), grantId: IdentitySchema, aud: z.literal(PROVIDER_BROKER_ACTION_ROUTE_AUDIENCE_V3),
  issuedAt: z.number().check(z.int(), z.nonnegative()), expiresAt: z.number().check(z.int(), z.positive()),
  teamId: IdentitySchema, resourceId: IdentitySchema, source: TeamCredentialSourceBindingV1Schema,
  consumer: TeamCredentialActionOperationConsumerV1Schema,
  inputDigest: IdentitySchema,
  declaration: z.strictObject({ version: z.string().check(z.trim(), z.minLength(1)), manifestDigestSha256: PluginUiArtifactDigestV1Schema }),
  initiator: z.strictObject({ accountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
  target: z.strictObject({ custodianAccountId: IdentitySchema, machineId: IdentitySchema, endpointId: IrohEndpointIdV1Schema }),
}).check(z.superRefine((payload, context) => {
  if (payload.expiresAt <= payload.issuedAt) context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow issue time' });
  if (payload.initiator.accountId === payload.target.custodianAccountId) context.addIssue({ code: 'custom', path: ['target'], message: 'Broker Accounts must be distinct' });
  if ((payload.initiator.machineId === payload.target.machineId) !== (payload.initiator.endpointId === payload.target.endpointId)) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Broker Machine and endpoint identities must agree' });
  }
})));
export const SignedProviderBrokerActionRouteGrantV3Schema = lazyZodSchema(() => z.strictObject({
  payload: ProviderBrokerActionRouteGrantPayloadV3Schema, signature: DirectRouteGrantSignatureV2Schema,
}).check(z.superRefine((authority, context) => {
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(authority));
  if (Math.ceil(bytes.byteLength * 8 / 6) > PROVIDER_BROKER_AUTHORITY_MAX_ENCODED_BYTES) {
    context.addIssue({ code: 'custom', message: 'Encoded broker authority exceeds the native HTTP header budget' });
  }
})));
export const IrohProviderBrokerActionHandshakeV3Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(3), kind: z.literal('provider_broker'), authority: SignedProviderBrokerActionRouteGrantV3Schema,
}));
export const ProviderBrokerActionOpenResponseV3Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), authority: SignedProviderBrokerActionRouteGrantV3Schema,
    target: ProviderBrokerOpenTargetV1Schema }),
  ProviderBrokerAdmissionFailureV1Schema,
]));
export const ProviderBrokerActionAdmissionV3Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(3), authority: SignedProviderBrokerActionRouteGrantV3Schema,
}));
export const ProviderBrokerActionAdmissionResponseV3Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }), ProviderBrokerAdmissionFailureV1Schema,
]));
export const ProviderBrokerActionExecuteRequestV3Schema = lazyZodSchema(() => z.strictObject({ input: StrictJsonValueSchema }));
export const ProviderBrokerActionExecuteResponseV3Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), execution: ActionExecuteResultSchema }), ProviderBrokerAdmissionFailureV1Schema,
]));
export type ProviderBrokerActionOpenRequestV3 = z.infer<typeof ProviderBrokerActionOpenRequestV3Schema>;
export type SignedProviderBrokerActionRouteGrantV3 = z.infer<typeof SignedProviderBrokerActionRouteGrantV3Schema>;
export type ProviderBrokerActionOpenResponseV3 = z.infer<typeof ProviderBrokerActionOpenResponseV3Schema>;
export type ProviderBrokerActionExecuteResponseV3 = z.infer<typeof ProviderBrokerActionExecuteResponseV3Schema>;
export type ProviderBrokerActionAdmissionResponseV3 = z.infer<typeof ProviderBrokerActionAdmissionResponseV3Schema>;
export function createProviderBrokerActionRouteGrantSigningInputV3(payload: SignedProviderBrokerActionRouteGrantV3['payload']): string {
  return createCanonicalJsonSigningInput(ProviderBrokerActionRouteGrantPayloadV3Schema.parse(payload));
}
