import { ProviderEndpointTemplateV1Schema, type ProviderEndpointTemplateV1 } from '../contributions/v1.js';
import {
  ProviderApiKeyCredentialRequirementV1Schema,
  type ProviderApiKeyCredentialRequirementV1,
  type ProviderCredentialTransportV1,
} from '../credentials/v1.js';
import { providerCredentialFormatKind } from '../credentials/v1.js';
import {
  PROVIDER_CAPABILITY_KEYS,
  ProviderCompatibilityOverridesV1Schema,
  type ProviderCompatibilityOverrideV1,
} from '../capabilities/v1.js';
import { ProviderModelDescriptorV1Schema, type ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import { ProviderAgentTargetKeySchema } from '../ids.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';
import {
  agentSupportsNoAuthForProtocolV1,
  AgentProviderRequirementsV1Schema,
  type AgentProviderRequirementsV1,
  type ProviderBindingCompatibilityV1,
  type ProviderCompatibilityReasonCodeV1,
} from './v1.js';

export type { AgentProviderRequirementsV1 } from './v1.js';

const CAPABILITY_REASON_CODES = {
  streaming: {
    unsupported: 'capability_streaming_unsupported',
    unknown: 'capability_streaming_unknown',
  },
  toolRoundTrips: {
    unsupported: 'capability_toolRoundTrips_unsupported',
    unknown: 'capability_toolRoundTrips_unknown',
  },
  statefulResponses: {
    unsupported: 'capability_statefulResponses_unsupported',
    unknown: 'capability_statefulResponses_unknown',
  },
  reasoningControls: {
    unsupported: 'capability_reasoningControls_unsupported',
    unknown: 'capability_reasoningControls_unknown',
  },
} as const satisfies Record<keyof AgentProviderRequirementsV1['required'], Readonly<{
  unsupported: ProviderCompatibilityReasonCodeV1;
  unknown: ProviderCompatibilityReasonCodeV1;
}>>;

const MODEL_CAPABILITY_REASON_CODES = {
  toolRoundTrips: {
    unsupported: 'model_capability_toolRoundTrips_unsupported',
    unknown: 'model_capability_toolRoundTrips_unknown',
  },
  reasoningControls: {
    unsupported: 'model_capability_reasoningControls_unsupported',
    unknown: 'model_capability_reasoningControls_unknown',
  },
} as const satisfies Record<'toolRoundTrips' | 'reasoningControls', Readonly<{
  unsupported: ProviderCompatibilityReasonCodeV1;
  unknown: ProviderCompatibilityReasonCodeV1;
}>>;

function matchesTransport(
  transport: ProviderCredentialTransportV1,
  agent: AgentProviderRequirementsV1,
  protocol: ProviderEndpointTemplateV1['protocol'],
): boolean {
  const format = providerCredentialFormatKind(transport.destination.format);
  return transport.uses.includes('runtime')
    && transport.protocols.includes(protocol)
    && agent.credentialSupport.apiKeyTransports.some((support) => {
      if (support.protocol !== protocol || support.destination.kind !== transport.destination.kind) return false;
      const names = support.destination.names;
      const nameMatches = names === 'anyValidated'
        || names.some((name) => support.destination.kind === 'httpHeader'
          ? name.toLowerCase() === transport.destination.name.toLowerCase()
          : name === transport.destination.name);
      return nameMatches && support.destination.formats.includes(format);
    });
}

/**
 * The single canonical choice of the runtime credential transport a given Agent
 * will actually use for a wire protocol. Compatibility acceptance, compatibility
 * fingerprinting and host spawn materialization all consume this, so the
 * transport described by a compatibility result is the transport bound at
 * launch. Throws when the declaration is ambiguous rather than picking one.
 */
export function selectProviderRuntimeCredentialTransportV1(input: Readonly<{
  transports: readonly ProviderCredentialTransportV1[];
  agent: AgentProviderRequirementsV1;
  protocol: ProviderEndpointTemplateV1['protocol'];
}>): ProviderCredentialTransportV1 | null {
  const matches = input.transports.filter((transport) =>
    matchesTransport(transport, input.agent, input.protocol));
  if (matches.length > 1) {
    throw new TypeError('Multiple runtime credential transports match the selected agent protocol');
  }
  return matches[0] ?? null;
}

function credentialReasons(
  credential: ProviderApiKeyCredentialRequirementV1 | undefined,
  agent: AgentProviderRequirementsV1,
  protocol: ProviderEndpointTemplateV1['protocol'],
): ProviderCompatibilityReasonCodeV1[] {
  const supportsNoAuth = agentSupportsNoAuthForProtocolV1(agent, protocol);
  if (!credential) return supportsNoAuth ? [] : ['no_auth_unsupported'];
  const selected = selectProviderRuntimeCredentialTransportV1({
    transports: credential.transports,
    agent,
    protocol,
  });
  if (!selected) return ['credential_transport_unavailable'];
  if (credential.required === false && !supportsNoAuth) return ['optional_credential_no_auth_unsupported'];
  return [];
}

export type ResolveProviderBindingCompatibilityInputV1 = Readonly<{
  agentTargetKey: string;
  endpoints: readonly ProviderEndpointTemplateV1[];
  credential: ProviderApiKeyCredentialRequirementV1 | undefined;
  agent: AgentProviderRequirementsV1;
  model?: ProviderModelDescriptorV1;
  compatibilityOverrides?: readonly ProviderCompatibilityOverrideV1[];
}>;

function findCompatibilityOverride(
  overrides: readonly ProviderCompatibilityOverrideV1[],
  agentTargetKey: string,
  protocol: ProviderEndpointTemplateV1['protocol'],
): ProviderCompatibilityOverrideV1 | undefined {
  return overrides.find((override) =>
    override.agentTargetKey === agentTargetKey && override.protocol === protocol);
}

function resolveProviderBindingCompatibilityV1(
  params: ResolveProviderBindingCompatibilityInputV1,
): ProviderBindingCompatibilityV1 {
  const agentTargetKey = ProviderAgentTargetKeySchema.parse(params.agentTargetKey);
  const compatibilityOverrides = params.compatibilityOverrides ?? [];
  const hasProtocolIntersection = params.agent.acceptsProtocols.some((protocol) =>
    params.endpoints.some((endpoint) => endpoint.protocol === protocol));
  if (!hasProtocolIntersection) {
    return { status: 'incompatible', reasons: ['no_compatible_protocol'] };
  }
  const candidates: Array<ProviderBindingCompatibilityV1 & { rank: number }> = [];
  const incompatibilityReasons: ProviderCompatibilityReasonCodeV1[] = [];

  params.agent.acceptsProtocols.forEach((protocol, rank) => {
    const endpoint = params.endpoints.find((candidate) => candidate.protocol === protocol);
    if (!endpoint) return;
    const compatibilityOverride = findCompatibilityOverride(
      compatibilityOverrides,
      agentTargetKey,
      protocol,
    );
    const reasons = credentialReasons(params.credential, params.agent, protocol);
    let modelScoped = false;
    for (const capability of Object.keys(params.agent.required) as Array<keyof typeof params.agent.required>) {
      if (!params.agent.required[capability]) continue;
      const endpointSupport = endpoint.capabilities[capability];
      if (endpointSupport === 'unsupported') {
        reasons.push(CAPABILITY_REASON_CODES[capability].unsupported);
        continue;
      }
      if (endpointSupport === 'unknown') reasons.push(CAPABILITY_REASON_CODES[capability].unknown);
      if (capability === 'toolRoundTrips' || capability === 'reasoningControls') {
        if (!params.model) {
          reasons.push('model_required_for_capability_resolution');
          continue;
        }
        const modelSupport = params.model?.capabilities?.[capability];
        if (modelSupport !== 'supported') {
          if (modelSupport === 'unsupported') reasons.push(MODEL_CAPABILITY_REASON_CODES[capability].unsupported);
          else reasons.push(MODEL_CAPABILITY_REASON_CODES[capability].unknown);
          modelScoped = true;
        }
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    const hard = uniqueReasons.filter((reason) =>
      reason.includes('unsupported')
      || reason.includes('unavailable')
      || reason === 'model_required_for_capability_resolution');
    if (compatibilityOverride?.status === 'incompatible') {
      hard.push('compatibility_override_incompatible');
    }
    if (hard.length > 0) {
      incompatibilityReasons.push(...hard);
      return;
    }
    const experimentalReasons: ProviderCompatibilityReasonCodeV1[] = compatibilityOverride?.status === 'experimental'
      ? [...uniqueReasons, 'compatibility_override_experimental']
      : uniqueReasons;
    if (experimentalReasons.length > 0) {
      candidates.push({
        status: 'experimental',
        selectedProtocol: protocol,
        reasons: [...new Set(experimentalReasons)],
        confirmationScope: modelScoped && params.model
          ? { kind: 'model', modelId: params.model.id }
          : { kind: 'connection' },
        ...(compatibilityOverride?.evidence ? { evidence: compatibilityOverride.evidence } : {}),
        rank,
      });
      return;
    }
    if (compatibilityOverride?.status === 'verified' && compatibilityOverride.evidence) {
      candidates.push({ status: 'verified', selectedProtocol: protocol, evidence: compatibilityOverride.evidence, rank });
      return;
    }
    candidates.push({
      status: 'experimental',
      selectedProtocol: protocol,
      reasons: ['compatibility_evidence_missing'],
      confirmationScope: { kind: 'connection' },
      rank,
    });
  });

  const verified = candidates.find((candidate) => candidate.status === 'verified');
  if (verified) {
    const { rank: _rank, ...result } = verified;
    return result;
  }
  const experimental = candidates.find((candidate) => candidate.status === 'experimental');
  if (experimental) {
    const { rank: _rank, ...result } = experimental;
    return result;
  }
  return {
    status: 'incompatible',
    reasons: incompatibilityReasons.length > 0 ? [...new Set(incompatibilityReasons)] : ['no_compatible_protocol'],
  };
}

export function projectProviderBindingCompatibilityForConnectionV1(
  result: ProviderBindingCompatibilityV1,
): Readonly<{
  status: 'verified' | 'experimental' | 'incompatible';
  reasons: readonly ProviderCompatibilityReasonCodeV1[];
}> {
  if (result.status === 'verified') return { status: 'verified', reasons: [] };
  if (result.status === 'experimental') return { status: 'experimental', reasons: result.reasons };
  if (result.reasons.every((reason) => reason === 'model_required_for_capability_resolution')) {
    return { status: 'experimental', reasons: ['model_capability_evidence_required'] };
  }
  return { status: 'incompatible', reasons: result.reasons };
}

function positiveAdapterVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('Adapter version must be a positive integer');
  return value;
}

function normalizeCompatibilityOverrides(
  input: readonly ProviderCompatibilityOverrideV1[] | undefined,
): readonly ProviderCompatibilityOverrideV1[] {
  return ProviderCompatibilityOverridesV1Schema.parse(input ?? []);
}

function candidateCredentialProjection(
  credential: ProviderApiKeyCredentialRequirementV1 | undefined,
  agent: AgentProviderRequirementsV1,
  protocol: ProviderEndpointTemplateV1['protocol'],
) {
  const supportsNoAuth = agentSupportsNoAuthForProtocolV1(agent, protocol);
  if (!credential) return { kind: 'none' as const, supportsNoAuth };
  const runtimeMatches = credential.transports
    .filter((transport) => matchesTransport(transport, agent, protocol))
    .map((transport) => ({ destination: transport.destination }))
    .sort((left, right) => compareProviderCanonicalStringsV1(JSON.stringify(left), JSON.stringify(right)));
  return {
    kind: 'apiKey' as const,
    required: credential.required,
    supportsNoAuth: credential.required === false ? supportsNoAuth : null,
    runtimeMatches,
  };
}

export function resolveProviderBindingCompatibilityWithFingerprintV1(
  params: ResolveProviderBindingCompatibilityInputV1 & Readonly<{
    adapterVersion: number;
  }>,
): Readonly<{
  result: ProviderBindingCompatibilityV1;
  compatibilityFingerprint: string;
}> {
  if ('result' in params) throw new TypeError('Compatibility result is derived by the canonical resolver');
  const agentTargetKey = ProviderAgentTargetKeySchema.parse(params.agentTargetKey);
  const adapterVersion = positiveAdapterVersion(params.adapterVersion);
  const endpoints = params.endpoints.map((endpoint) => ProviderEndpointTemplateV1Schema.parse(endpoint));
  if (new Set(endpoints.map((endpoint) => endpoint.protocol)).size !== endpoints.length) {
    throw new TypeError('Compatibility inputs require at most one endpoint per protocol');
  }
  const credential = params.credential === undefined
    ? undefined
    : ProviderApiKeyCredentialRequirementV1Schema.parse(params.credential);
  const agent = AgentProviderRequirementsV1Schema.parse(params.agent);
  const model = params.model === undefined ? undefined : ProviderModelDescriptorV1Schema.parse(params.model);
  const compatibilityOverrides = normalizeCompatibilityOverrides(params.compatibilityOverrides);
  const result = resolveProviderBindingCompatibilityV1({
    agentTargetKey,
    endpoints,
    credential,
    agent,
    ...(model ? { model } : {}),
    compatibilityOverrides,
  });
  const requiredCapabilities = PROVIDER_CAPABILITY_KEYS.filter((capability) => agent.required[capability]);
  const modelSensitiveRequiredCapabilities = requiredCapabilities.filter(
    (capability): capability is 'toolRoundTrips' | 'reasoningControls' =>
      capability === 'toolRoundTrips' || capability === 'reasoningControls',
  );
  const modelSensitiveCapabilities = modelSensitiveRequiredCapabilities.filter((capability) =>
    agent.acceptsProtocols.some((protocol) => {
      const endpoint = endpoints.find((candidate) => candidate.protocol === protocol);
      return endpoint !== undefined && endpoint.capabilities[capability] !== 'unsupported';
    }));
  const candidateFacts = agent.acceptsProtocols.flatMap((protocol) => {
    const endpoint = endpoints.find((candidate) => candidate.protocol === protocol);
    if (!endpoint) return [];
    const compatibilityOverride = findCompatibilityOverride(compatibilityOverrides, agentTargetKey, protocol);
    return [{
      protocol,
      capabilities: Object.fromEntries(requiredCapabilities.map((capability) => [
        capability,
        endpoint.capabilities[capability],
      ])),
      credential: candidateCredentialProjection(credential, agent, protocol),
      compatibilityOverride: compatibilityOverride === undefined ? null : {
        status: compatibilityOverride.status,
        evidence: compatibilityOverride.evidence ?? null,
      },
    }];
  });
  const compatibilityFingerprint = createProviderFingerprintV1('compatibility', {
    adapterVersion,
    requiredCapabilities,
    candidates: candidateFacts,
    model: modelSensitiveCapabilities.length === 0 ? null : {
      id: model?.id ?? null,
      capabilities: Object.fromEntries(modelSensitiveCapabilities.map((capability) => [
        capability,
        model?.capabilities?.[capability] ?? null,
      ])),
    },
    result,
  });
  return { result, compatibilityFingerprint };
}
