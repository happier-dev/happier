import { z } from 'zod';

import { ConnectedServiceIdSchema } from '../../connect/connectedServiceBindings.js';
import { ProviderCredentialFormatKindV1Schema } from '../credentials/v1.js';
import {
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderCompatibilityEvidenceV1Schema,
  ProviderWireProtocolSchema,
} from '../capabilities/v1.js';
import {
  normalizeProviderCredentialHeaderName,
  normalizeProviderQueryParameterName,
} from '../safety/index.js';

export const ModelSelectionApplyPolicySchema = z.enum(['live', 'next_prompt', 'restart_session', 'unsupported']);
export type ModelSelectionApplyPolicy = z.infer<typeof ModelSelectionApplyPolicySchema>;

function canonicalTransportNameSchema(normalize: (value: string) => string) {
  return z.string().transform((value, ctx) => {
    try {
      return normalize(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid credential transport support name' });
      return z.NEVER;
    }
  });
}

const AgentCredentialHeaderSupportNameSchema = canonicalTransportNameSchema(
  normalizeProviderCredentialHeaderName,
);
const AgentCredentialQuerySupportNameSchema = canonicalTransportNameSchema(
  normalizeProviderQueryParameterName,
);

export const AgentCredentialTransportSupportV1Schema = z.object({
  protocol: ProviderWireProtocolSchema,
  destination: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('httpHeader'),
      names: z.union([z.literal('anyValidated'), z.array(AgentCredentialHeaderSupportNameSchema).min(1).max(32)]),
      formats: z.array(ProviderCredentialFormatKindV1Schema).min(1).max(3),
    }).strict(),
    z.object({
      kind: z.literal('queryParam'),
      names: z.union([z.literal('anyValidated'), z.array(AgentCredentialQuerySupportNameSchema).min(1).max(32)]),
      formats: z.array(ProviderCredentialFormatKindV1Schema).min(1).max(3),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (Array.isArray(value.destination.names)) {
    const names = value.destination.kind === 'httpHeader'
      ? value.destination.names.map((name) => name.toLowerCase())
      : value.destination.names;
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['destination', 'names'], message: 'Transport names must be unique under destination name semantics' });
  }
  if (new Set(value.destination.formats).size !== value.destination.formats.length) {
    ctx.addIssue({ code: 'custom', path: ['destination', 'formats'], message: 'Transport formats must be unique' });
  }
});
export type AgentCredentialTransportSupportV1 = z.infer<typeof AgentCredentialTransportSupportV1Schema>;

export const AgentProviderRequirementsV1Schema = z.object({
  acceptsProtocols: z.array(ProviderWireProtocolSchema).min(1).max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
  required: z.object({
    streaming: z.literal(true).optional(),
    toolRoundTrips: z.literal(true).optional(),
    statefulResponses: z.literal(true).optional(),
    reasoningControls: z.literal(true).optional(),
  }).strict(),
  credentialSupport: z.object({
    supportsNoAuth: z.boolean(),
    /**
     * Narrows `supportsNoAuth` to the protocols the Agent's driver can actually
     * dispatch without an Authorization header. Absent means every accepted
     * protocol. An Agent whose only credential-free driver speaks one wire
     * protocol declares that protocol here rather than advertising blanket
     * no-auth support and fabricating a placeholder credential at launch.
     */
    noAuthProtocols: z.array(ProviderWireProtocolSchema)
      .min(1)
      .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)
      .optional(),
    apiKeyTransports: z.array(AgentCredentialTransportSupportV1Schema).max(32),
  }).strict(),
  authIsolation: z.object({
    suppressConnectedServiceIds: z.array(ConnectedServiceIdSchema).max(32),
    ownedEnvKeys: z.array(z.string().min(1).max(256).regex(/^[A-Z_][A-Z0-9_]*$/u)).max(64),
  }).strict(),
  materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
  applyPolicy: ModelSelectionApplyPolicySchema,
  supportsFreeformModelIds: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.acceptsProtocols).size !== value.acceptsProtocols.length) {
    ctx.addIssue({ code: 'custom', path: ['acceptsProtocols'], message: 'Accepted protocols must be unique' });
  }
  if (new Set(value.authIsolation.suppressConnectedServiceIds).size !== value.authIsolation.suppressConnectedServiceIds.length) {
    ctx.addIssue({ code: 'custom', path: ['authIsolation', 'suppressConnectedServiceIds'], message: 'Suppressed service ids must be unique' });
  }
  if (new Set(value.authIsolation.ownedEnvKeys).size !== value.authIsolation.ownedEnvKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['authIsolation', 'ownedEnvKeys'], message: 'Owned environment keys must be unique' });
  }
  const noAuthProtocols = value.credentialSupport.noAuthProtocols;
  if (noAuthProtocols) {
    if (!value.credentialSupport.supportsNoAuth) {
      ctx.addIssue({ code: 'custom', path: ['credentialSupport', 'noAuthProtocols'], message: 'No-auth protocols require no-auth support' });
    }
    if (new Set(noAuthProtocols).size !== noAuthProtocols.length) {
      ctx.addIssue({ code: 'custom', path: ['credentialSupport', 'noAuthProtocols'], message: 'No-auth protocols must be unique' });
    }
    noAuthProtocols.forEach((protocol, index) => {
      if (!value.acceptsProtocols.includes(protocol)) {
        ctx.addIssue({ code: 'custom', path: ['credentialSupport', 'noAuthProtocols', index], message: 'No-auth protocol is not accepted by this Agent' });
      }
    });
  }
});

/**
 * The single decision for "can this Agent drive this wire protocol with no
 * credential at all". Compatibility acceptance, reason codes and the candidate
 * projection all consume it so one declaration decides selection.
 */
export function agentSupportsNoAuthForProtocolV1(
  agent: Readonly<{ credentialSupport: Readonly<{
    supportsNoAuth: boolean;
    noAuthProtocols?: readonly z.infer<typeof ProviderWireProtocolSchema>[];
  }> }>,
  protocol: z.infer<typeof ProviderWireProtocolSchema>,
): boolean {
  if (!agent.credentialSupport.supportsNoAuth) return false;
  const scoped = agent.credentialSupport.noAuthProtocols;
  return scoped === undefined || scoped.includes(protocol);
}
export type AgentProviderRequirementsV1 = z.infer<typeof AgentProviderRequirementsV1Schema>;

export const PROVIDER_COMPATIBILITY_REASON_CODES_V1 = [
  'no_compatible_protocol',
  'no_auth_unsupported',
  'credential_transport_unavailable',
  'optional_credential_no_auth_unsupported',
  'capability_streaming_unsupported',
  'capability_streaming_unknown',
  'capability_toolRoundTrips_unsupported',
  'capability_toolRoundTrips_unknown',
  'capability_statefulResponses_unsupported',
  'capability_statefulResponses_unknown',
  'capability_reasoningControls_unsupported',
  'capability_reasoningControls_unknown',
  'model_required_for_capability_resolution',
  'model_capability_toolRoundTrips_unsupported',
  'model_capability_toolRoundTrips_unknown',
  'model_capability_reasoningControls_unsupported',
  'model_capability_reasoningControls_unknown',
  'compatibility_override_incompatible',
  'compatibility_override_experimental',
  'compatibility_evidence_missing',
  'model_capability_evidence_required',
  'agent_external_providers_unsupported',
  'adapter_contract_invalid',
] as const;

export const ProviderCompatibilityReasonCodeV1Schema = z.enum(PROVIDER_COMPATIBILITY_REASON_CODES_V1);
export type ProviderCompatibilityReasonCodeV1 = z.infer<typeof ProviderCompatibilityReasonCodeV1Schema>;

export const ProviderBindingCompatibilityV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    selectedProtocol: ProviderWireProtocolSchema,
    evidence: ProviderCompatibilityEvidenceV1Schema,
  }).strict(),
  z.object({
    status: z.literal('experimental'),
    selectedProtocol: ProviderWireProtocolSchema,
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).min(1),
    confirmationScope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('connection') }).strict(),
      z.object({ kind: z.literal('model'), modelId: z.string().trim().min(1).max(512) }).strict(),
    ]),
    evidence: ProviderCompatibilityEvidenceV1Schema.optional(),
  }).strict(),
  z.object({
    status: z.literal('incompatible'),
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).min(1),
  }).strict(),
]);
export type ProviderBindingCompatibilityV1 = z.infer<typeof ProviderBindingCompatibilityV1Schema>;
