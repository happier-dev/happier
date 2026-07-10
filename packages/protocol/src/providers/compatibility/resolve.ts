import { ProviderEndpointTemplateV1Schema, type ProviderEndpointTemplateV1 } from '../contributions/v1.js';
import {
  ProviderApiKeyCredentialRequirementV1Schema,
  type ProviderApiKeyCredentialRequirementV1,
  type ProviderCredentialTransportV1,
} from '../credentials/v1.js';
import { providerCredentialFormatKind } from '../credentials/v1.js';
import { ProviderCompatibilityOverrideV1Schema, type ProviderCompatibilityOverrideV1 } from '../capabilities/v1.js';
import { ProviderModelDescriptorV1Schema, type ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import { ProviderAgentTargetKeySchema } from '../ids.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import {
  AgentProviderRequirementsV1Schema,
  type AgentProviderRequirementsV1,
  type ProviderBindingCompatibilityV1,
} from './v1.js';

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

function credentialReasons(
  credential: ProviderApiKeyCredentialRequirementV1 | undefined,
  agent: AgentProviderRequirementsV1,
  protocol: ProviderEndpointTemplateV1['protocol'],
): string[] {
  if (!credential) return agent.credentialSupport.supportsNoAuth ? [] : ['no_auth_unsupported'];
  const matches = credential.transports.filter((transport) => matchesTransport(transport, agent, protocol));
  if (matches.length !== 1) return ['credential_transport_unavailable'];
  if (credential.required === false && !agent.credentialSupport.supportsNoAuth) return ['optional_credential_no_auth_unsupported'];
  return [];
}

export type ResolveProviderBindingCompatibilityInputV1 = Readonly<{
  agentTargetKey: string;
  endpoints: readonly ProviderEndpointTemplateV1[];
  credential: ProviderApiKeyCredentialRequirementV1 | undefined;
  agent: AgentProviderRequirementsV1;
  model?: ProviderModelDescriptorV1;
  compatibilityOverrides?: Readonly<Record<string, ProviderCompatibilityOverrideV1>>;
}>;

export function resolveProviderBindingCompatibilityV1(
  params: ResolveProviderBindingCompatibilityInputV1,
): ProviderBindingCompatibilityV1 {
  const agentTargetKey = ProviderAgentTargetKeySchema.parse(params.agentTargetKey);
  const compatibilityOverride = readOwnRecordValue(params.compatibilityOverrides, agentTargetKey);
  const needsExactModel = Boolean(params.agent.required.toolRoundTrips || params.agent.required.reasoningControls);
  if (needsExactModel && !params.model) {
    return { status: 'incompatible', reasons: ['model_required_for_capability_resolution'] };
  }
  const candidates: Array<ProviderBindingCompatibilityV1 & { rank: number }> = [];
  const incompatibilityReasons: string[] = [];

  params.agent.acceptsProtocols.forEach((protocol, rank) => {
    const endpoint = params.endpoints.find((candidate) => candidate.protocol === protocol);
    if (!endpoint) return;
    const reasons = credentialReasons(params.credential, params.agent, protocol);
    let modelScoped = false;
    for (const capability of Object.keys(params.agent.required) as Array<keyof typeof params.agent.required>) {
      if (!params.agent.required[capability]) continue;
      const endpointSupport = endpoint.capabilities[capability];
      if (endpointSupport === 'unsupported') reasons.push(`capability_${capability}_unsupported`);
      if (endpointSupport === 'unknown') reasons.push(`capability_${capability}_unknown`);
      if (capability === 'toolRoundTrips' || capability === 'reasoningControls') {
        const modelSupport = params.model?.capabilities?.[capability];
        if (endpointSupport !== 'unsupported' && modelSupport !== 'supported') {
          if (modelSupport === 'unsupported') reasons.push(`model_capability_${capability}_unsupported`);
          else reasons.push(`model_capability_${capability}_unknown`);
          modelScoped = true;
        }
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    const hard = uniqueReasons.filter((reason) => reason.includes('unsupported') || reason.includes('unavailable'));
    if (compatibilityOverride?.status === 'incompatible') {
      hard.push('compatibility_override_incompatible');
    }
    if (hard.length > 0) {
      incompatibilityReasons.push(...hard);
      return;
    }
    const experimentalReasons = compatibilityOverride?.status === 'experimental'
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

function positiveAdapterVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('Adapter version must be a positive integer');
  return value;
}

function normalizeAgentCompatibilityFacts(agent: AgentProviderRequirementsV1) {
  const parsed = AgentProviderRequirementsV1Schema.parse(agent);
  const apiKeyTransports = parsed.credentialSupport.apiKeyTransports.map((transport) => ({
    protocol: transport.protocol,
    destination: {
      ...transport.destination,
      names: transport.destination.names === 'anyValidated'
        ? 'anyValidated' as const
        : [...transport.destination.names]
          .map((name) => transport.destination.kind === 'httpHeader' ? name.toLowerCase() : name)
          .sort(),
      formats: [...transport.destination.formats].sort(),
    },
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    acceptsProtocols: parsed.acceptsProtocols,
    required: parsed.required,
    credentialSupport: { supportsNoAuth: parsed.credentialSupport.supportsNoAuth, apiKeyTransports },
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
  const rawCompatibilityOverride = readOwnRecordValue(params.compatibilityOverrides, agentTargetKey);
  const compatibilityOverride = rawCompatibilityOverride === undefined
    ? undefined
    : ProviderCompatibilityOverrideV1Schema.parse(rawCompatibilityOverride);
  const compatibilityOverrides = compatibilityOverride === undefined
    ? undefined
    : { [agentTargetKey]: compatibilityOverride };
  const result = resolveProviderBindingCompatibilityV1({
    agentTargetKey,
    endpoints,
    credential,
    agent,
    ...(model ? { model } : {}),
    ...(compatibilityOverrides ? { compatibilityOverrides } : {}),
  });
  const selectedRuntimeTransport = result.status === 'incompatible' || credential === undefined
    ? null
    : credential.transports.find((transport) => matchesTransport(transport, agent, result.selectedProtocol)) ?? null;
  const compatibilityFingerprint = createProviderFingerprintV1('compatibility', {
    agentTargetKey,
    adapterVersion,
    agent: normalizeAgentCompatibilityFacts(agent),
    endpoints: endpoints.map((endpoint) => ({
      protocol: endpoint.protocol,
      capabilities: endpoint.capabilities,
    })).sort((a, b) => a.protocol.localeCompare(b.protocol)),
    credentialRequired: credential?.required ?? null,
    selectedRuntimeTransport: selectedRuntimeTransport === null ? null : {
      protocol: result.status === 'incompatible' ? null : result.selectedProtocol,
      destination: selectedRuntimeTransport.destination,
    },
    model: model ? { id: model.id, capabilities: model.capabilities ?? null } : null,
    compatibilityOverride: compatibilityOverride ?? null,
    result,
  });
  return { result, compatibilityFingerprint };
}
