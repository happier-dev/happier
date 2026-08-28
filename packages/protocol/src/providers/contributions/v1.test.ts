import { describe, expect, it } from 'vitest';

import {
  ProviderContributionV1Schema,
  createProviderManagedRuntimeDeclarationEqualityKeyV1,
  resolveProviderManagedRuntimeDeclarationV1,
} from './v1.js';

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
  it('resolves relative managed connected-account references once at the public declaration owner', () => {
    const relative = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity: {
        pluginId: 'acme.gateway',
        localId: 'gateway',
      },
      managedRuntime: {
        kind: 'managed',
        dependencies: ['gateway-service'],
        connectedAccounts: [{
          purpose: 'upstream',
          service: 'openai',
          title: {
            key: 'plugins.acme.gateway.connectedAccounts.upstream',
            fallback: 'OpenAI upstream account',
          },
          required: true,
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.openai.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
    });
    const qualified = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity: {
        pluginId: 'acme.gateway',
        localId: 'gateway',
      },
      managedRuntime: {
        ...relative,
        connectedAccounts: [{
          ...relative.connectedAccounts[0]!,
          service: { pluginId: 'acme.gateway', localId: 'openai' },
        }],
      },
    });

    expect(relative).toEqual(qualified);
    expect(relative.connectedAccounts[0]?.service).toEqual({
      pluginId: 'acme.gateway',
      localId: 'openai',
    });
    expect(relative.connectedAccounts[0]?.title).toEqual({
      key: 'plugins.acme.gateway.connectedAccounts.upstream',
      fallback: 'OpenAI upstream account',
    });
    expect(createProviderManagedRuntimeDeclarationEqualityKeyV1({
      implementationIdentity: {
        pluginId: 'acme.gateway',
        localId: 'gateway',
      },
      managedRuntime: {
        ...relative,
        connectedAccounts: [{
          ...relative.connectedAccounts[0]!,
          title: 'Use the renamed upstream account',
        }],
      },
    })).toBe(createProviderManagedRuntimeDeclarationEqualityKeyV1({
      implementationIdentity: {
        pluginId: 'acme.gateway',
        localId: 'gateway',
      },
      managedRuntime: relative,
    }));
    expect(Object.isFrozen(relative)).toBe(true);
    expect(Object.isFrozen(relative.connectedAccounts)).toBe(true);
    expect(Object.isFrozen(relative.connectedAccounts[0]?.service)).toBe(true);
  });

  it('canonicalizes managed declaration set fields without reordering endpoint templates', () => {
    const implementationIdentity = {
      pluginId: 'acme.gateway',
      localId: 'gateway',
    };
    const declaration = {
      kind: 'managed' as const,
      dependencies: ['bridge-a', 'bridge-b'],
      endpointTemplateIds: ['responses', 'chat'],
      connectedAccounts: [
        {
          purpose: 'upstream',
          service: 'openai',
          required: true,
          materializationKinds: ['environment', 'httpHeaders'],
        },
        {
          purpose: 'audit',
          service: 'audit-service',
          materializationKinds: ['httpHeaders'],
        },
      ],
      requestAuthUses: [
        {
          purpose: 'upstream',
          materialization: {
            kind: 'httpHeaders' as const,
            origin: 'https://api.example.test',
            headerNames: ['authorization', 'x-trace-id'],
          },
        },
        {
          purpose: 'audit',
          materialization: {
            kind: 'httpHeaders' as const,
            origin: 'https://audit.example.test',
            headerNames: ['authorization'],
          },
        },
      ],
    };
    const canonical = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity,
      managedRuntime: declaration,
    });
    const permuted = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity,
      managedRuntime: {
        ...declaration,
        dependencies: [...declaration.dependencies].reverse(),
        connectedAccounts: declaration.connectedAccounts
          .map((account) => ({
            ...account,
            ...(account.materializationKinds
              ? {
                  materializationKinds: [
                    ...account.materializationKinds,
                  ].reverse(),
                }
              : {}),
          }))
          .reverse(),
        requestAuthUses: declaration.requestAuthUses
          .map((use) => ({
            ...use,
            materialization: {
              ...use.materialization,
              headerNames: [...use.materialization.headerNames].reverse(),
            },
          }))
          .reverse(),
      },
    });

    expect(permuted).toEqual(canonical);
    expect(resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity,
      managedRuntime: {
        ...declaration,
        endpointTemplateIds: ['chat', 'responses'],
      },
    })).not.toEqual(canonical);
  });

  it('accepts the cold managed-runtime declaration and rejects endpoint/dependency bound violations', () => {
    const managedRuntime = {
      kind: 'managed',
      dependencies: ['gateway-runtime'],
      connectedAccounts: [],
      endpointTemplateIds: ['responses'],
    } as const;
    const value = {
      ...validContribution(),
      catalog: {
        ...validContribution().catalog,
        sourceRegistryVersion: 'gateway-model-registry/v1',
      },
      managedRuntime,
    };
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...value, managedRuntime: { ...managedRuntime, endpointTemplateIds: [] },
    }).success).toBe(false);
    expect(ProviderContributionV1Schema.safeParse({
      ...value, managedRuntime: { ...managedRuntime, endpointTemplateIds: ['missing'] },
    }).success).toBe(false);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...managedRuntime,
        dependencies: Array.from({ length: 17 }, (_, index) => `dep-${index}`),
      },
    }).success).toBe(false);
  });

  it('requires a managed dynamic source version while preserving ordered probes and fallback', () => {
    const managed = {
      ...validContribution(),
      managedRuntime: {
        kind: 'managed',
        endpointTemplateIds: ['responses'],
      },
    } as const;

    // Managed catalog identity cannot silently collapse to a declaration with
    // no semantic source version, even though external endpoint catalogs do
    // not need that managed-source fact.
    expect(ProviderContributionV1Schema.safeParse(managed).success).toBe(false);
    const versioned = {
      ...managed,
      catalog: {
        ...managed.catalog,
        sourceRegistryVersion: 'gateway-model-registry/v1',
        probes: [
          ...managed.catalog.probes,
          { endpointTemplateId: 'responses', path: '/v1/models-alt', parser: 'openai-models' },
        ],
      },
    } as const;
    expect(ProviderContributionV1Schema.safeParse(versioned).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...versioned,
      discovery: {
        v: 1,
        listener: {
          executableBasenames: ['gateway'],
          defaultPorts: [443],
        },
        availabilityProbe: versioned.catalog.probes[0],
        catalogFallback: {
          endpointTemplateId: 'responses',
          lookupNames: ['gateway'],
          fixedArgs: ['models'],
          parser: 'ollama-list-table',
        },
      },
    }).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...versioned,
      catalog: { ...versioned.catalog, sourceRegistryVersion: '   ' },
    }).success).toBe(false);
  });

  it('accepts 32 unique managed connected-account purposes and rejects 33 or duplicate purposes', () => {
    const connectedAccounts = Array.from({ length: 32 }, (_, index) => ({
      purpose: `purpose-${index}`,
      service: `account-${index}`,
      materializationKinds: ['httpHeaders'] as const,
    }));
    const base = validContribution();
    const value = { ...base, catalog: {
      ...base.catalog,
      sourceRegistryVersion: 'gateway-model-registry/v1',
    }, managedRuntime: {
      kind: 'managed',
      endpointTemplateIds: ['responses'],
      connectedAccounts,
    } } as const;
    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...value.managedRuntime,
        connectedAccounts: [...connectedAccounts, {
          purpose: 'purpose-32', service: 'account-32', materializationKinds: ['httpHeaders'],
        }],
      },
    }).success).toBe(false);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...value.managedRuntime,
        connectedAccounts: connectedAccounts.map((entry, index) => index === 31
          ? { ...entry, purpose: 'purpose-0' }
          : entry),
      },
    }).success).toBe(false);
  });

  it('binds managed request-auth uses to declared connected-account purposes and materialization kinds', () => {
    const managedRuntime = {
      kind: 'managed',
      endpointTemplateIds: ['responses'],
      connectedAccounts: [{
        purpose: 'provider.inference',
        service: 'openai',
        materializationKinds: ['httpHeaders'],
      }, {
        purpose: 'provider.bootstrap',
        service: 'openai',
        materializationKinds: ['environment'],
      }],
      requestAuthUses: [{
        purpose: 'provider.inference',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    } as const;
    const base = validContribution();
    const value = {
      ...base,
      catalog: {
        ...base.catalog,
        sourceRegistryVersion: 'gateway-model-registry/v1',
      },
      managedRuntime,
    };

    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...managedRuntime,
        requestAuthUses: [{
          ...managedRuntime.requestAuthUses[0],
          purpose: 'provider.undeclared',
        }],
      },
    }).success).toBe(false);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...managedRuntime,
        connectedAccounts: managedRuntime.connectedAccounts.map((entry) => (
          entry.purpose === 'provider.inference'
            ? { ...entry, materializationKinds: ['environment'] as const }
            : entry
        )),
      },
    }).success).toBe(false);
  });

  it('bounds managed request-auth uses and rejects duplicate purpose authority', () => {
    const connectedAccounts = Array.from({ length: 32 }, (_, index) => ({
      purpose: `provider.request-${index}`,
      service: 'openai',
      materializationKinds: ['httpHeaders'] as const,
    }));
    const requestAuthUses = connectedAccounts.map(({ purpose }, index) => ({
      purpose,
      materialization: {
        kind: 'httpHeaders' as const,
        origin: `https://api-${index}.example.com`,
        headerNames: ['authorization'],
      },
    }));
    const managedRuntime = {
      kind: 'managed' as const,
      endpointTemplateIds: ['responses'],
      connectedAccounts,
      requestAuthUses,
    };
    const base = validContribution();
    const value = {
      ...base,
      catalog: {
        ...base.catalog,
        sourceRegistryVersion: 'gateway-model-registry/v1',
      },
      managedRuntime,
    };

    expect(ProviderContributionV1Schema.safeParse(value).success).toBe(true);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...managedRuntime,
        requestAuthUses: [...requestAuthUses, {
          purpose: 'provider.request-32',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api-32.example.com',
            headerNames: ['authorization'],
          },
        }],
      },
    }).success).toBe(false);
    expect(ProviderContributionV1Schema.safeParse({
      ...value,
      managedRuntime: {
        ...managedRuntime,
        requestAuthUses: requestAuthUses.map((use, index) => index === 31
          ? { ...use, purpose: 'provider.request-0' }
          : use),
      },
    }).success).toBe(false);
  });

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

  it('accepts a Provider-contributed catalog format, including for model loading', () => {
    const contributed = structuredClone(validContribution()) as any;
    contributed.catalog.probes[0].parser = 'acme-catalog-v3';
    expect(ProviderContributionV1Schema.safeParse(contributed).success).toBe(true);

    // Model loading depends on the format reporting load state, not on the
    // host happening to bundle that format's implementation.
    contributed.kind = 'local';
    contributed.credential.transports[0].uses.push('management');
    contributed.modelLoad = {
      endpointTemplateId: 'responses',
      path: '/api/v1/models/load',
      request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state',
      preflightPolicy: 'advisory',
    };
    expect(ProviderContributionV1Schema.safeParse(contributed).success).toBe(false);

    contributed.catalog.probes[0].reportsModelLoadState = true;
    expect(ProviderContributionV1Schema.safeParse(contributed).success).toBe(true);
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
