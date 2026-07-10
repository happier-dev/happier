import { describe, expect, it } from 'vitest';

import { resolveProviderBindingCompatibilityV1 } from './resolve.js';

const baseEndpoint = {
  id: 'responses',
  protocol: 'openai-responses',
  baseUrl: 'https://example.test/v1',
  capabilities: {
    streaming: 'supported',
    toolRoundTrips: 'unknown',
    statefulResponses: 'unsupported',
    reasoningControls: 'unknown',
  },
} as const;

const baseRequirements = {
  acceptsProtocols: ['openai-responses'],
  required: { streaming: true, toolRoundTrips: true },
  credentialSupport: {
    supportsNoAuth: true,
    apiKeyTransports: [{
      protocol: 'openai-responses',
      destination: { kind: 'httpHeader', names: ['Authorization'], formats: ['bearer'] },
    }],
  },
  authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['OPENAI_API_KEY'] },
  materialization: 'engineConfig',
  applyPolicy: 'restart_session',
  supportsFreeformModelIds: false,
} as const;

const evidence = {
  sourceUrls: ['https://docs.example.test/compatibility'],
  verifiedAt: '2026-07-10',
  testIds: ['providers.real-session'],
} as const;

describe('resolveProviderBindingCompatibilityV1', () => {
  it('returns experimental for unknown required model capability and scopes confirmation to the model', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex',
      endpoints: [baseEndpoint],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A' },
    });
    expect(result.status).toBe('experimental');
    expect(result.selectedProtocol).toBe('openai-responses');
    expect(result.confirmationScope).toEqual({ kind: 'model', modelId: 'model-a' });
  });

  it('returns incompatible before secrets when a runtime credential transport cannot be materialized', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex',
      endpoints: [baseEndpoint],
      credential: {
        kind: 'apiKey', slotId: 'apiKey', required: true,
        transports: [{
          id: 'api-key', protocols: ['openai-responses'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
        }],
      },
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A' },
    });
    expect(result.status).toBe('incompatible');
    expect(result.reasons).toContain('credential_transport_unavailable');
  });

  it('chooses the first verified protocol even when an earlier candidate is experimental', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:multi',
      endpoints: [
        { ...baseEndpoint, id: 'responses' },
        { ...baseEndpoint, id: 'chat', protocol: 'openai-chat', capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } },
      ],
      credential: undefined,
      agent: { ...baseRequirements, acceptsProtocols: ['openai-responses', 'openai-chat'] },
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: { 'agent:multi': { status: 'verified', reason: 'Real lifecycle verified', evidence } },
    });
    expect(result.status).toBe('verified');
    expect(result.selectedProtocol).toBe('openai-chat');
  });

  it('applies evidence-bearing agent overrides and never emits verified without evidence', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex',
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: { 'agent:codex': { status: 'verified', reason: 'Real lifecycle verified', evidence } },
    });
    expect(result).toEqual({ status: 'verified', selectedProtocol: 'openai-responses', evidence });
  });

  it('refuses connection-wide confirmation when a model-sensitive requirement has no exact model', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex',
      endpoints: [baseEndpoint], credential: undefined, agent: baseRequirements,
    });
    expect(result).toEqual({ status: 'incompatible', reasons: ['model_required_for_capability_resolution'] });
  });

  it('cannot apply compatibility evidence belonging to another agent target', () => {
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex',
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: { 'agent:claude': { status: 'verified', reason: 'Claude-only evidence', evidence } },
    });
    expect(result.status).toBe('experimental');
    expect(result.status === 'experimental' ? result.reasons : []).toContain('compatibility_evidence_missing');
  });

  it('matches header names case-insensitively but query parameter names exactly', () => {
    const queryCredential = {
      kind: 'apiKey' as const,
      slotId: 'apiKey' as const,
      required: true,
      transports: [{
        id: 'query-key',
        protocols: ['openai-responses' as const],
        uses: ['runtime' as const],
        destination: { kind: 'queryParam' as const, name: 'api_key', format: 'raw' as const },
      }],
    };
    const queryRequirements = {
      ...baseRequirements,
      credentialSupport: {
        ...baseRequirements.credentialSupport,
        apiKeyTransports: [{
          protocol: 'openai-responses' as const,
          destination: { kind: 'queryParam' as const, names: ['API_KEY'], formats: ['raw' as const] },
        }],
      },
    };
    const mismatch = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex', endpoints: [baseEndpoint], credential: queryCredential,
      agent: queryRequirements, model: { id: 'model-a', name: 'A' },
    });
    expect(mismatch.status).toBe('incompatible');
    expect(mismatch.reasons).toContain('credential_transport_unavailable');

    const exact = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex', endpoints: [baseEndpoint], credential: queryCredential,
      agent: {
        ...queryRequirements,
        credentialSupport: {
          ...queryRequirements.credentialSupport,
          apiKeyTransports: [{
            ...queryRequirements.credentialSupport.apiKeyTransports[0],
            destination: { ...queryRequirements.credentialSupport.apiKeyTransports[0].destination, names: ['api_key'] },
          }],
        },
      },
      model: { id: 'model-a', name: 'A' },
    });
    expect(exact.status === 'incompatible' ? exact.reasons : []).not.toContain('credential_transport_unavailable');

    const headerCaseVariant = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'agent:codex', endpoints: [baseEndpoint],
      credential: {
        kind: 'apiKey', slotId: 'apiKey', required: true,
        transports: [{
          id: 'header-key', protocols: ['openai-responses'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        }],
      },
      agent: baseRequirements, model: { id: 'model-a', name: 'A' },
    });
    expect(headerCaseVariant.status === 'incompatible' ? headerCaseVariant.reasons : [])
      .not.toContain('credential_transport_unavailable');
  });

  it('ignores inherited compatibility override properties for valid prototype-member agent ids', () => {
    const inherited = Object.create({
      toString: { status: 'incompatible', reason: 'Inherited values are not registry entries' },
    }) as Record<string, { status: 'incompatible'; reason: string }>;
    const result = resolveProviderBindingCompatibilityV1({
      agentTargetKey: 'toString',
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: inherited,
    });
    expect(result.status).toBe('experimental');
    expect(result.status === 'experimental' ? result.reasons : []).toContain('compatibility_evidence_missing');
  });
});
