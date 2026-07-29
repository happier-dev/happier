import { describe, expect, it } from 'vitest';

import {
  projectProviderBindingCompatibilityForConnectionV1,
  resolveProviderBindingCompatibilityWithFingerprintV1,
} from './resolve.js';

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

const resolve = (input: Parameters<typeof resolveProviderBindingCompatibilityWithFingerprintV1>[0]) =>
  resolveProviderBindingCompatibilityWithFingerprintV1(input).result;

describe('resolveProviderBindingCompatibilityWithFingerprintV1', () => {
  it('returns experimental for unknown required model capability and scopes confirmation to the model', () => {
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
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
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
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
    const result = resolve({
      agentTargetKey: 'agent:multi',
      adapterVersion: 1,
      endpoints: [
        { ...baseEndpoint, id: 'responses' },
        { ...baseEndpoint, id: 'chat', protocol: 'openai-chat', capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } },
      ],
      credential: undefined,
      agent: { ...baseRequirements, acceptsProtocols: ['openai-responses', 'openai-chat'] },
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:multi', protocol: 'openai-chat',
        status: 'verified', reason: 'Real lifecycle verified', evidence,
      }],
    });
    expect(result.status).toBe('verified');
    expect(result.selectedProtocol).toBe('openai-chat');
  });

  it('applies evidence-bearing agent overrides and never emits verified without evidence', () => {
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:codex', protocol: 'openai-responses',
        status: 'verified', reason: 'Real lifecycle verified', evidence,
      }],
    });
    expect(result).toEqual({ status: 'verified', selectedProtocol: 'openai-responses', evidence });
  });

  it('refuses connection-wide confirmation when a model-sensitive requirement has no exact model', () => {
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
      endpoints: [baseEndpoint], credential: undefined, agent: baseRequirements,
    });
    expect(result).toEqual({ status: 'incompatible', reasons: ['model_required_for_capability_resolution'] });
    expect(projectProviderBindingCompatibilityForConnectionV1(result)).toEqual({
      status: 'experimental', reasons: ['model_capability_evidence_required'],
    });
  });

  it('reports no protocol intersection before requiring model-sensitive evidence', () => {
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, protocol: 'anthropic' }],
      credential: undefined,
      agent: baseRequirements,
    });
    expect(result).toEqual({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
  });

  it('treats endpoint-level model capability rejection as model-independent', () => {
    const endpoint = {
      ...baseEndpoint,
      capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'unsupported' as const },
    };
    const withoutModel = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [endpoint], credential: undefined, agent: baseRequirements,
    });
    expect(withoutModel).toEqual({
      status: 'incompatible', reasons: ['capability_toolRoundTrips_unsupported'],
    });

    const modelA = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [endpoint], credential: undefined, agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
    });
    const modelB = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [endpoint], credential: undefined, agent: baseRequirements,
      model: { id: 'model-b', name: 'B', capabilities: { toolRoundTrips: 'unknown' } },
    });
    expect(modelB.result).toEqual(modelA.result);
    expect(modelB.compatibilityFingerprint).toBe(modelA.compatibilityFingerprint);
  });

  it('cannot apply compatibility evidence belonging to another agent target', () => {
    const result = resolve({
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' } },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:claude', protocol: 'openai-responses',
        status: 'verified', reason: 'Claude-only evidence', evidence,
      }],
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
    const mismatch = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1, endpoints: [baseEndpoint], credential: queryCredential,
      agent: queryRequirements, model: { id: 'model-a', name: 'A' },
    });
    expect(mismatch.status).toBe('incompatible');
    expect(mismatch.reasons).toContain('credential_transport_unavailable');

    const exact = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1, endpoints: [baseEndpoint], credential: queryCredential,
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

    const headerCaseVariant = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1, endpoints: [baseEndpoint],
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

  it('scopes evidence and incompatibility to the exact agent and protocol', () => {
    const endpoints = [
      { ...baseEndpoint, id: 'responses', capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } },
      { ...baseEndpoint, id: 'chat', protocol: 'openai-chat' as const, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } },
    ];
    const agent = { ...baseRequirements, acceptsProtocols: ['openai-responses', 'openai-chat'] as const };
    const model = { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' as const } };
    const result = resolve({
      agentTargetKey: 'agent:multi', adapterVersion: 1,
      endpoints,
      credential: undefined, agent, model,
      compatibilityOverrides: [
        {
          agentTargetKey: 'agent:multi', protocol: 'openai-responses', status: 'incompatible',
          reason: 'Responses lifecycle is broken',
        },
        {
          agentTargetKey: 'agent:multi', protocol: 'openai-chat', status: 'verified',
          reason: 'Chat lifecycle verified', evidence,
        },
      ],
    });
    expect(result).toEqual({ status: 'verified', selectedProtocol: 'openai-chat', evidence });
  });

  it('resolves no intersection and no-auth/optional-credential failures deterministically', () => {
    expect(resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, protocol: 'anthropic' }], credential: undefined,
      agent: baseRequirements, model: { id: 'model-a', name: 'A' },
    })).toEqual({ status: 'incompatible', reasons: ['no_compatible_protocol'] });

    expect(resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint], credential: undefined,
      agent: { ...baseRequirements, credentialSupport: { ...baseRequirements.credentialSupport, supportsNoAuth: false } },
      model: { id: 'model-a', name: 'A' },
    })).toMatchObject({ status: 'incompatible', reasons: ['no_auth_unsupported'] });

    expect(resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint],
      credential: {
        kind: 'apiKey', slotId: 'apiKey', required: false,
        transports: [{
          id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        }],
      },
      agent: { ...baseRequirements, credentialSupport: { ...baseRequirements.credentialSupport, supportsNoAuth: false } },
      model: { id: 'model-a', name: 'A' },
    })).toMatchObject({ status: 'incompatible', reasons: ['optional_credential_no_auth_unsupported'] });
  });

  it('supports anyValidated and rejects ambiguous matching runtime transports', () => {
    const credential = {
      kind: 'apiKey' as const, slotId: 'apiKey' as const, required: true,
      transports: [{
        id: 'a', protocols: ['openai-responses' as const], uses: ['runtime' as const],
        destination: { kind: 'httpHeader' as const, name: 'x-company-key', format: 'raw' as const },
      }],
    };
    const anyValidated = {
      ...baseRequirements,
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
          protocol: 'openai-responses' as const,
          destination: { kind: 'httpHeader' as const, names: 'anyValidated' as const, formats: ['raw' as const] },
        }],
      },
    };
    const accepted = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint], credential, agent: anyValidated,
      model: { id: 'model-a', name: 'A' },
    });
    expect(accepted.status === 'incompatible' ? accepted.reasons : []).not.toContain('credential_transport_unavailable');

    expect(() => resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint],
      credential: { ...credential, transports: [credential.transports[0], { ...credential.transports[0], id: 'b' }] },
      agent: anyValidated, model: { id: 'model-a', name: 'A' },
    })).toThrowError(/Ambiguous credential transport/u);

    expect(() => resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint],
      credential: {
        ...credential,
        transports: [
          credential.transports[0],
          {
            id: 'b', protocols: ['openai-responses'], uses: ['runtime'],
            destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          },
        ],
      },
      agent: {
        ...anyValidated,
        credentialSupport: {
          ...anyValidated.credentialSupport,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'],
            },
          }],
        },
      },
      model: { id: 'model-a', name: 'A' },
    })).toThrowError(/Multiple runtime credential transports match/u);
  });

  it('fingerprints only resolver-relevant intersecting facts', () => {
    const streamingOnly = {
      agentTargetKey: 'agent:a', adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' as const } }],
      credential: undefined,
      agent: { ...baseRequirements, required: { streaming: true }, acceptsProtocols: ['openai-responses'] as const },
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' as const } },
    } as const;
    const baseline = resolveProviderBindingCompatibilityWithFingerprintV1(streamingOnly);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...streamingOnly, agentTargetKey: 'agent:b',
    }).compatibilityFingerprint).toBe(baseline.compatibilityFingerprint);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...streamingOnly,
      endpoints: [...streamingOnly.endpoints, {
        ...baseEndpoint, id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://other.example.test',
      }],
    }).compatibilityFingerprint).toBe(baseline.compatibilityFingerprint);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...streamingOnly,
      agent: { ...streamingOnly.agent, acceptsProtocols: ['openai-responses', 'anthropic'] },
    }).compatibilityFingerprint).toBe(baseline.compatibilityFingerprint);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...streamingOnly, model: { id: 'model-b', name: 'B', capabilities: { toolRoundTrips: 'unsupported' } },
    }).compatibilityFingerprint).toBe(baseline.compatibilityFingerprint);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...streamingOnly, adapterVersion: 2,
    }).compatibilityFingerprint).not.toBe(baseline.compatibilityFingerprint);
  });

  it('fingerprints every intersecting candidate that can change winner selection', () => {
    const endpoints = [
      { ...baseEndpoint, id: 'responses', capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' as const } },
      { ...baseEndpoint, id: 'chat', protocol: 'openai-chat' as const, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' as const } },
    ];
    const agent = {
      ...baseRequirements,
      acceptsProtocols: ['openai-responses', 'openai-chat'] as const,
      required: { streaming: true },
    };
    const input = {
      agentTargetKey: 'agent:multi', adapterVersion: 1, endpoints, credential: undefined,
      agent, model: { id: 'model-a', name: 'A' },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:multi', protocol: 'openai-chat' as const, status: 'verified' as const,
        reason: 'Chat verified', evidence,
      }],
    };
    const baseline = resolveProviderBindingCompatibilityWithFingerprintV1(input);
    const reordered = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input, agent: { ...agent, acceptsProtocols: ['openai-chat', 'openai-responses'] },
    });
    const changedOtherCandidate = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input,
      endpoints: [
        { ...endpoints[0], capabilities: { ...endpoints[0].capabilities, streaming: 'unsupported' as const } },
        endpoints[1],
      ],
    });
    expect(reordered.compatibilityFingerprint).not.toBe(baseline.compatibilityFingerprint);
    expect(changedOtherCandidate.compatibilityFingerprint).not.toBe(baseline.compatibilityFingerprint);
  });

  it('does not invalidate compatibility for a human-only override reason edit', () => {
    const input = {
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [{
        ...baseEndpoint,
        capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' as const },
      }],
      credential: undefined,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' as const } },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:codex', protocol: 'openai-responses' as const,
        status: 'verified' as const, reason: 'Verified in a real session', evidence,
      }],
    };
    const baseline = resolveProviderBindingCompatibilityWithFingerprintV1(input);
    const copyEdited = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input,
      compatibilityOverrides: [{ ...input.compatibilityOverrides[0], reason: 'Real-session verification passed' }],
    });
    expect(copyEdited.result).toEqual(baseline.result);
    expect(copyEdited.compatibilityFingerprint).toBe(baseline.compatibilityFingerprint);
  });

  it('uses agent protocol order as the deterministic tie-breaker for equal experimental candidates', () => {
    const endpoints = [
      { ...baseEndpoint, id: 'responses' },
      { ...baseEndpoint, id: 'chat', protocol: 'openai-chat' as const },
    ];
    const common = {
      agentTargetKey: 'agent:multi', adapterVersion: 1, endpoints, credential: undefined,
      agent: { ...baseRequirements, acceptsProtocols: ['openai-chat', 'openai-responses'] as const },
      model: { id: 'model-a', name: 'A' },
    };
    expect(resolve(common)).toMatchObject({ status: 'experimental', selectedProtocol: 'openai-chat' });
    expect(resolve({
      ...common,
      agent: { ...common.agent, acceptsProtocols: ['openai-responses', 'openai-chat'] },
    })).toMatchObject({ status: 'experimental', selectedProtocol: 'openai-responses' });
  });

  it('keeps unsupported stateful Responses and exact-model unknowns from becoming verified', () => {
    const stateful = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [baseEndpoint], credential: undefined,
      agent: { ...baseRequirements, required: { statefulResponses: true } },
      model: { id: 'model-a', name: 'A' },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:codex', protocol: 'openai-responses',
        status: 'verified', reason: 'Streaming lifecycle verified', evidence,
      }],
    });
    expect(stateful).toMatchObject({
      status: 'incompatible', reasons: ['capability_statefulResponses_unsupported'],
    });

    const modelUnknown = resolve({
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [{ ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' } }],
      credential: undefined, agent: baseRequirements,
      model: { id: 'model-a', name: 'A' },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:codex', protocol: 'openai-responses',
        status: 'verified', reason: 'Connection lifecycle verified', evidence,
      }],
    });
    expect(modelUnknown).toMatchObject({
      status: 'experimental',
      confirmationScope: { kind: 'model', modelId: 'model-a' },
    });
  });

  it('invalidates model-scoped and runtime-transport semantics without over-invalidating lookup ids', () => {
    const credential = {
      kind: 'apiKey' as const, slotId: 'apiKey' as const, required: true,
      transports: [{
        id: 'bearer', protocols: ['openai-responses' as const], uses: ['runtime' as const],
        destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
      }],
    };
    const endpoint = { ...baseEndpoint, capabilities: { ...baseEndpoint.capabilities, toolRoundTrips: 'supported' as const } };
    const input = {
      agentTargetKey: 'agent:codex', adapterVersion: 1, endpoints: [endpoint], credential,
      agent: baseRequirements,
      model: { id: 'model-a', name: 'A', capabilities: { toolRoundTrips: 'supported' as const } },
      compatibilityOverrides: [{
        agentTargetKey: 'agent:codex', protocol: 'openai-responses' as const,
        status: 'verified' as const, reason: 'Lifecycle verified', evidence,
      }],
    };
    const baseline = resolveProviderBindingCompatibilityWithFingerprintV1(input);
    const modelUnknown = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input, model: { id: 'model-b', name: 'B' },
    });
    expect(modelUnknown.result).toMatchObject({
      status: 'experimental', confirmationScope: { kind: 'model', modelId: 'model-b' },
    });
    expect(modelUnknown.compatibilityFingerprint).not.toBe(baseline.compatibilityFingerprint);

    const destinationChanged = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input,
      credential: {
        ...credential,
        transports: [{
          ...credential.transports[0],
          destination: { kind: 'httpHeader' as const, name: 'x-api-key', format: 'raw' as const },
        }],
      },
      agent: {
        ...baseRequirements,
        credentialSupport: {
          ...baseRequirements.credentialSupport,
          apiKeyTransports: [{
            protocol: 'openai-responses' as const,
            destination: { kind: 'httpHeader' as const, names: ['x-api-key'], formats: ['raw' as const] },
          }],
        },
      },
    });
    expect(destinationChanged.result.status).toBe('verified');
    expect(destinationChanged.compatibilityFingerprint).not.toBe(baseline.compatibilityFingerprint);
  });
});
