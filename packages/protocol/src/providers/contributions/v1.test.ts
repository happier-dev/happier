import { describe, expect, it } from 'vitest';

import { ProviderContributionV1Schema } from './v1.js';

const unknownCapabilities = {
  streaming: 'unknown',
  toolRoundTrips: 'unknown',
  statefulResponses: 'unknown',
  reasoningControls: 'unknown',
} as const;

function validContribution() {
  return {
    v: 1,
    id: 'gateway',
    name: 'Gateway',
    kind: 'cloud',
    endpointTemplates: [{
      id: 'responses',
      protocol: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      capabilities: unknownCapabilities,
    }],
    credential: {
      kind: 'apiKey',
      transports: [{
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      }],
    },
    catalog: {
      source: 'probe',
      manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' }],
    },
  } as const;
}

describe('ProviderContributionV1Schema', () => {
  it('accepts a bounded contribution-owned legacy profile migration descriptor and validates its credential slot', () => {
    const value = structuredClone(validContribution()) as any;
    value.legacyProfileMigrations = [{
      sourceProfileId: 'openai',
      credentialBinding: { legacyEnvVarName: 'OPENAI_API_KEY', credentialSlotId: 'apiKey' },
      primaryModel: { agentTargetKey: 'agent:codex', legacyEnvVarName: 'OPENAI_MODEL', defaultModelId: 'gpt-5-codex-high' },
      migratedEnvironmentVariables: [
        { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
        { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
      ],
      retainedEnvironmentVariables: [
        { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
        { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
      ],
    }];
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    value.legacyProfileMigrations[0].credentialBinding.credentialSlotId = 'unknown-slot';
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
  });

  it('requires unique implicit model aliases to target verified static models', () => {
    const value = structuredClone(validContribution()) as any;
    value.catalog = {
      source: 'static', manualModelPolicy: 'allowed',
      staticModels: [{ id: 'model-current', name: 'Current' }],
    };
    value.legacyProfileMigrations = [{
      sourceProfileId: 'legacy',
      descriptorRevision: 2,
      implicitModelAliasReplacements: [{ legacyModelId: 'model-old', replacementModelId: 'model-current' }],
      migratedEnvironmentVariables: [],
      retainedEnvironmentVariables: [],
    }];
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    value.legacyProfileMigrations[0].implicitModelAliasReplacements.push({
      legacyModelId: 'model-old', replacementModelId: 'model-missing',
    });
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
  });

  it('normalizes one API-key slot and validates the contribution round trip', () => {
    const parsed = ProviderContributionV1Schema.parse(validContribution());
    expect(parsed.credential).toMatchObject({ slotId: 'apiKey', required: true });
    expect(ProviderContributionV1Schema.parse(parsed)).toEqual(parsed);
  });

  it('rejects duplicate protocols and credential transports for undeclared protocols', () => {
    const duplicateProtocol = {
      ...validContribution(),
      endpointTemplates: [
        ...validContribution().endpointTemplates,
        { ...validContribution().endpointTemplates[0], id: 'responses-2' },
      ],
    };
    expect(ProviderContributionV1Schema.safeParse(duplicateProtocol).success).toBe(false);

    const undeclaredTransport = structuredClone(validContribution()) as any;
    undeclaredTransport.credential.transports[0].protocols = ['anthropic'];
    expect(ProviderContributionV1Schema.safeParse(undeclaredTransport).success).toBe(false);
  });

  it('enforces catalog source invariants and endpoint probe references', () => {
    const missingProbe = structuredClone(validContribution()) as any;
    missingProbe.catalog.probes = [];
    expect(ProviderContributionV1Schema.safeParse(missingProbe).success).toBe(false);

    const unknownEndpoint = structuredClone(validContribution()) as any;
    unknownEndpoint.catalog.probes[0].endpointTemplateId = 'missing';
    expect(ProviderContributionV1Schema.safeParse(unknownEndpoint).success).toBe(false);

    const unsafePath = structuredClone(validContribution()) as any;
    unsafePath.catalog.probes[0].path = 'https://other.example/models';
    expect(ProviderContributionV1Schema.safeParse(unsafePath).success).toBe(false);
  });

  it('allows model loading only for trusted local contributions with management transport', () => {
    const invalid = structuredClone(validContribution()) as any;
    invalid.modelLoad = {
      endpointTemplateId: 'responses',
      path: '/api/v1/models/load',
      request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state',
      preflightPolicy: 'advisory',
    };
    expect(ProviderContributionV1Schema.safeParse(invalid).success).toBe(false);

    invalid.kind = 'local';
    invalid.credential.transports[0].uses.push('management');
    invalid.catalog.probes[0].parser = 'lmstudio-native-models';
    expect(ProviderContributionV1Schema.safeParse(invalid).success).toBe(true);
  });

  it('requires model-load management and load-state catalog facts to reference the selected endpoint protocol and id', () => {
    const invalid = structuredClone(validContribution()) as any;
    invalid.kind = 'local';
    invalid.endpointTemplates.push({
      ...invalid.endpointTemplates[0], id: 'native', protocol: 'ollama-native',
    });
    invalid.catalog.probes[0] = { endpointTemplateId: 'responses', path: '/api/v1/models', parser: 'lmstudio-native-models' };
    invalid.credential.transports[0].uses.push('management');
    invalid.credential.transports[0].protocols = ['ollama-native'];
    invalid.modelLoad = {
      endpointTemplateId: 'responses', path: '/api/v1/models/load', request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory',
    };
    expect(ProviderContributionV1Schema.safeParse(invalid).success).toBe(false);
    invalid.credential.transports[0].protocols = ['openai-responses'];
    invalid.catalog.probes[0].endpointTemplateId = 'native';
    expect(ProviderContributionV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('requires protocol-scoped compatibility overrides and rejects duplicate agent/protocol tuples', () => {
    const value = structuredClone(validContribution()) as any;
    value.compatibilityOverrides = [
      {
        agentTargetKey: 'agent:codex', protocol: 'openai-responses',
        status: 'incompatible', reason: 'Known incompatibility',
      },
      {
        agentTargetKey: 'agent:codex', protocol: 'openai-responses',
        status: 'experimental', reason: 'Must not overwrite',
      },
    ];
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);

    value.compatibilityOverrides[1].agentTargetKey = 'agent:claude';
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);

    value.compatibilityOverrides[1].protocol = 'openai-chat';
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
    value.compatibilityOverrides[1].protocol = 'openai-responses';

    delete value.compatibilityOverrides[1].protocol;
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
  });

  it('normalizes public and credential header names and rejects case-equivalent public duplicates', () => {
    const value = structuredClone(validContribution()) as any;
    value.endpointTemplates[0].publicHeaders = { 'X-Title': 'Happier' };
    value.credential.transports[0].destination.name = ' Authorization ';
    const parsed = ProviderContributionV1Schema.parse(value);
    expect(parsed.endpointTemplates[0]?.publicHeaders).toEqual({ 'x-title': 'Happier' });
    expect(parsed.credential?.transports[0]?.destination.name).toBe('authorization');

    value.endpointTemplates[0].publicHeaders = { 'X-Title': 'one', 'x-title': 'two' };
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
  });

  it('allows only HTTPS user-openable contribution and API-key links', () => {
    for (const [field, url] of [['websiteUrl', 'javascript:alert(1)'], ['keyUrl', 'data:text/plain,secret']] as const) {
      const value = structuredClone(validContribution()) as any;
      if (field === 'websiteUrl') value.websiteUrl = url;
      else value.credential.keyUrl = url;
      expect(ProviderContributionV1Schema.safeParse(value).success).toBe(false);
    }
    const valid = structuredClone(validContribution()) as any;
    valid.websiteUrl = 'https://example.test/provider';
    valid.credential.keyUrl = 'https://example.test/key';
    expect(ProviderContributionV1Schema.safeParse(valid).success).toBe(true);
  });

  it('allows adopted-local discovery for an aggregator while keeping local URL candidates discovery-backed', () => {
    const local = structuredClone(validContribution()) as any;
    local.kind = 'local';
    delete local.endpointTemplates[0].baseUrl;
    local.endpointTemplates[0].localUrlCandidates = ['http://127.0.0.1:11434'];
    local.discovery = {
      v: 1,
      listener: { executableBasenames: ['ollama'], defaultPorts: [11434] },
      availabilityProbe: { endpointTemplateId: 'responses', path: '/api/tags', parser: 'ollama-tags' },
    };
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(true);

    local.discovery.availabilityProbe.endpointTemplateId = 'missing';
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(false);

    local.discovery.availabilityProbe.endpointTemplateId = 'responses';
    local.discovery.catalogFallback = {
      endpointTemplateId: 'missing', lookupNames: ['ollama'], fixedArgs: ['list'],
      parser: 'ollama-list-table', endpointEnvName: 'OLLAMA_HOST',
    };
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(false);

    local.discovery.catalogFallback.endpointTemplateId = 'responses';
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(true);

    local.catalog.probes[0].endpointTemplateId = 'chat';
    local.endpointTemplates.push({
      ...local.endpointTemplates[0], id: 'chat', protocol: 'openai-chat',
    });
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(false);

    local.catalog.probes[0].endpointTemplateId = 'responses';
    local.kind = 'aggregator';
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(true);

    delete local.discovery;
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(false);
  });

  it('rejects duplicate normalized local candidates instead of probing the same destination twice', () => {
    const local = structuredClone(validContribution()) as any;
    local.kind = 'local';
    delete local.endpointTemplates[0].baseUrl;
    local.endpointTemplates[0].localUrlCandidates = [
      'http://127.0.0.1:11434',
      'http://127.0.0.1:11434/',
    ];
    expect(ProviderContributionV1Schema.safeParse(local).success).toBe(false);
  });
});
