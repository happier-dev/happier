import { describe, expect, it } from 'vitest';

import {
  createProviderAccountGrantFingerprintV1,
  createProviderBindingSecurityFingerprintV1,
  createProviderCatalogFingerprintV1,
  createProviderConnectionSecurityFingerprintV1,
  createProviderCredentialDestinationFingerprintV1,
  createProviderEndpointFingerprintV1,
  createProviderEndpointSetFingerprintV1,
  createProviderMachineGrantFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderProbeObservationIdentityV1,
  createProviderProbeRequestFingerprintV1,
  createProviderSavedSecretRecordFingerprintV1,
} from './securityFingerprintsV1.js';
import { assessProviderEndpoint, type AssessedProviderEndpoint } from './safety/index.js';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from './compatibility/resolve.js';

const connectionInput = {
  securityContractVersion: 1,
  endpoints: [{
    endpointTemplateId: 'responses',
    protocol: 'openai-responses',
    url: 'https://EXAMPLE.test:443/v1',
    publicHeaders: { 'X-Title': 'Happier', 'HTTP-Referer': 'https://happier.dev' },
  }],
  catalogProbes: [{ endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' }],
  availabilityProbe: { endpointTemplateId: 'responses', path: '/health/models', parser: 'openai-models' },
  credentialTransports: [{
    id: 'bearer', protocols: ['openai-responses'], uses: ['probe', 'runtime'],
    destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
  }],
} as const;

function managedDeploymentWithPurposes(purposes: readonly string[]) {
  return {
    implementationIdentity: {
      pluginId: 'happier.provider.gateway',
      localId: 'gateway',
    },
    managedEndpoint: {
      localService: {
        id: 'gateway',
        launch: {
          kind: 'packaged-runtime-binary',
          directorySegments: ['tools', 'unpacked'],
          executableBaseName: 'gateway-managed',
          privateConfigPathFlag: '--config',
        },
        launchMode: {
          kind: 'assignAndInject',
          portPolicy: { kind: 'allocated' },
        },
        hostPolicy: { kind: 'loopback' },
        name: { strategy: 'fixed', name: 'Gateway' },
        healthCheck: { kind: 'http', path: '/healthz' },
        restart: { kind: 'never' },
        cleanup: { staleAfterMs: 60_000 },
      },
      protocols: ['openai-chat', 'openai-responses'],
    },
    connectedAccounts: purposes.map((purpose) => ({
      purpose,
      service: {
        pluginId: 'happier.connected-account.example',
        localId: 'example',
      },
      required: true,
      materializationKinds: ['httpHeaders'],
    })),
    requestAuthUses: purposes.map((purpose) => ({
      purpose,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.example.test',
        headerNames: ['authorization'],
      },
    })),
  } as const;
}

describe('typed provider security fingerprints', () => {
  it('binds draft probe authorization to the exact credential destination', () => {
    const bearer = createProviderCredentialDestinationFingerprintV1({
      kind: 'httpHeader', name: 'Authorization', format: 'bearer',
    });
    expect(bearer).toBe('credential-destination:v1:C4kSX8ZSJnndNgQLz0-g04dP0qV0AJbgTqbh0Ik6yQU');
    expect(bearer).toBe(createProviderCredentialDestinationFingerprintV1({
      kind: 'httpHeader', name: 'authorization', format: 'bearer',
    }));
    expect(bearer).not.toBe(createProviderCredentialDestinationFingerprintV1({
      kind: 'httpHeader', name: 'x-api-key', format: 'raw',
    }));
    expect(createProviderCredentialDestinationFingerprintV1(null)).not.toBe(bearer);
  });

  it('normalizes connection trust inputs and changes for executable security-surface edits', () => {
    const a = createProviderConnectionSecurityFingerprintV1(connectionInput);
    const reorderedHeaders = createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      endpoints: [{
        ...connectionInput.endpoints[0],
        publicHeaders: { 'HTTP-Referer': 'https://happier.dev', 'x-title': 'Happier' },
      }],
    });
    const changedProbe = createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      catalogProbes: [{ ...connectionInput.catalogProbes[0], path: '/v1/other-models' }],
    });
    const changedProtocol = createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      endpoints: [{ ...connectionInput.endpoints[0], protocol: 'anthropic' }],
    });
    const changedAvailabilityProbe = createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      availabilityProbe: { ...connectionInput.availabilityProbe, path: '/health/other-models' },
    });
    expect(reorderedHeaders).toBe(a);
    expect(changedProbe).not.toBe(a);
    expect(changedProtocol).not.toBe(a);
    expect(changedAvailabilityProbe).not.toBe(a);
    expect(a).toMatch(/^connection-security:v1:/);
  });

  it('invalidates connection trust when a local catalog command contract changes', () => {
    const fallback = {
      endpointTemplateId: 'responses',
      lookupNames: ['ollama'],
      fixedArgs: ['list'],
      parser: 'ollama-list-table' as const,
      endpointEnvName: 'OLLAMA_HOST',
    };
    const base = createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      catalogFallback: fallback,
    });
    expect(createProviderConnectionSecurityFingerprintV1({
      ...connectionInput,
      catalogFallback: { ...fallback, fixedArgs: ['ls'] },
    })).not.toBe(base);
    expect(createProviderConnectionSecurityFingerprintV1(connectionInput)).not.toBe(base);
  });

  it('uses stable managed declaration facts without accepting a durable endpoint URL', () => {
    const managedDeployment = managedDeploymentWithPurposes(['upstream']);
    const input = {
      securityContractVersion: 1,
      endpoints: [],
      catalogProbes: [],
      credentialTransports: [],
      managedDeployment,
    } as const;
    const fingerprint = createProviderConnectionSecurityFingerprintV1(input);

    expect(createProviderConnectionSecurityFingerprintV1(input)).toBe(fingerprint);
    expect(createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        managedEndpoint: {
          ...managedDeployment.managedEndpoint,
          localService: {
            ...managedDeployment.managedEndpoint.localService,
            launch: {
              ...managedDeployment.managedEndpoint.localService.launch,
              executableBaseName: 'gateway-managed-v2',
            },
          },
        },
      },
    })).not.toBe(fingerprint);
    expect(createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        connectedAccounts: [{
          ...managedDeployment.connectedAccounts[0],
          purpose: 'different-upstream',
        }],
        requestAuthUses: [{
          ...managedDeployment.requestAuthUses[0],
          purpose: 'different-upstream',
        }],
      },
    })).not.toBe(fingerprint);
    expect(createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        connectedAccounts: [{
          ...managedDeployment.connectedAccounts[0],
          materializationKinds: ['httpHeaders', 'environment'],
        }],
      },
    })).not.toBe(fingerprint);
    expect(() => createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        requestAuthUses: [],
      },
    })).toThrowError(/must exactly match/u);
    expect(() => createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        connectedAccounts: [{
          ...managedDeployment.connectedAccounts[0],
          materializationKinds: ['files'],
        }],
      },
    })).toThrowError(/materialization kind/u);
    expect(createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        requestAuthUses: [{
          ...managedDeployment.requestAuthUses[0],
          materialization: {
            ...managedDeployment.requestAuthUses[0].materialization,
            origin: 'https://different.example.test',
          },
        }],
      },
    })).not.toBe(fingerprint);
    expect(createProviderConnectionSecurityFingerprintV1({
      ...input,
      managedDeployment: {
        ...managedDeployment,
        connectedAccounts: [{
          ...managedDeployment.connectedAccounts[0],
          service: {
            ...managedDeployment.connectedAccounts[0].service,
            localId: 'different-service',
          },
        }],
      },
    })).not.toBe(fingerprint);
    expect(() => createProviderConnectionSecurityFingerprintV1({
      ...input,
      endpoints: connectionInput.endpoints,
    })).toThrowError(/must not contain durable endpoints/u);
  });

  it('orders managed declarations canonically without host locale authority', () => {
    const forward = {
      ...connectionInput,
      endpoints: [],
      catalogProbes: [],
      credentialTransports: [],
      managedDeployment: managedDeploymentWithPurposes(['ä-upstream', 'Z-upstream']),
    } as const;
    const reversed = {
      ...forward,
      managedDeployment: managedDeploymentWithPurposes(['Z-upstream', 'ä-upstream']),
    } as const;
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('localeCompare must not participate in Provider fingerprint identity');
    };
    try {
      expect(createProviderConnectionSecurityFingerprintV1(forward)).toBe(
        createProviderConnectionSecurityFingerprintV1(reversed),
      );
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it('binds an agent/model/materialization without accepting display or secret values', () => {
    const base = {
      agentTargetKey: 'agent:codex', connectionId: 'pc_a', modelId: 'model/a',
      endpointTemplateId: 'responses', endpointUrl: 'https://example.test/v1', protocol: 'openai-responses',
      publicHeaders: {}, materialization: 'engineConfig', adapterBindingKey: 'pc_a',
      modelCapabilities: {},
      credentialDestination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      compatibilityFingerprint: 'compatibility:v1:a', adapterVersion: 1,
    } as const;
    expect(createProviderBindingSecurityFingerprintV1({ ...base, modelId: 'model/b' })).not.toBe(
      createProviderBindingSecurityFingerprintV1(base),
    );
    expect(createProviderBindingSecurityFingerprintV1({
      ...base,
      modelCapabilities: { reasoningControls: 'unsupported' },
    })).toBe(createProviderBindingSecurityFingerprintV1({
      ...base,
      modelCapabilities: { reasoningControls: 'supported' },
    }));
  });

  it('binds managed sessions to a logical implementation identity and never a realized URL', () => {
    const base = {
      agentTargetKey: 'agent:codex',
      connectionId: 'pc_a',
      modelId: 'model/a',
      modelCapabilities: {},
      deployment: {
        kind: 'managedLocal',
        securityFacts: managedDeploymentWithPurposes(['upstream']),
      },
      endpointTemplateId: 'responses',
      protocol: 'openai-responses',
      publicHeaders: {},
      materialization: 'engineConfig',
      compatibilityFingerprint: 'compatibility:v1:a',
      adapterVersion: 1,
    } as const;
    const fingerprint = createProviderBindingSecurityFingerprintV1(base);

    expect(createProviderBindingSecurityFingerprintV1(base)).toBe(fingerprint);
    expect(createProviderBindingSecurityFingerprintV1({
      ...base,
      deployment: {
        kind: 'managedLocal',
        securityFacts: {
          ...base.deployment.securityFacts,
          requestAuthUses: [{
            ...base.deployment.securityFacts.requestAuthUses[0],
            materialization: {
              ...base.deployment.securityFacts.requestAuthUses[0].materialization,
              origin: 'https://different.example.test',
            },
          }],
        },
      },
    })).not.toBe(fingerprint);
    expect(() => createProviderBindingSecurityFingerprintV1({
      ...base,
      endpointUrl: 'http://127.0.0.1:49152/v1',
    })).toThrowError(/must not contain a realized endpoint URL/u);
  });

  it('treats private DNS answers as a set while preserving endpoint-template order', () => {
    const local = assessProviderEndpoint('http://service.localhost:11434/', {
      resolvedAddresses: ['::1', '127.0.0.1'],
    });
    const localReordered = assessProviderEndpoint('http://service.localhost:11434/', {
      resolvedAddresses: ['127.0.0.1', '::1'],
    });
    const publicEndpoint = assessProviderEndpoint('https://public.example/v1', {
      resolvedAddresses: ['93.184.216.34'],
    });
    const a = createProviderEndpointSetFingerprintV1({ endpoints: [
      { endpointTemplateId: 'a', endpoint: local },
      { endpointTemplateId: 'b', endpoint: publicEndpoint },
    ] });
    const reorderedAnswers = createProviderEndpointSetFingerprintV1({ endpoints: [
      { endpointTemplateId: 'a', endpoint: localReordered },
      { endpointTemplateId: 'b', endpoint: publicEndpoint },
    ] });
    const reorderedEndpoints = createProviderEndpointSetFingerprintV1({ endpoints: [
      { endpointTemplateId: 'b', endpoint: publicEndpoint },
      { endpointTemplateId: 'a', endpoint: local },
    ] });
    expect(reorderedAnswers).toBe(a);
    expect(reorderedEndpoints).not.toBe(a);
  });

  it('refuses fabricated machine-hostname assessments with no complete non-public DNS set', () => {
    const fabricated = {
      normalizedUrl: 'http://service.localhost:11434/',
      origin: 'http://service.localhost:11434',
      hostname: 'service.localhost',
      protocol: 'http:',
      locality: 'loopback',
      scope: 'machine',
      resolvedAddresses: [],
      nonPublicAddresses: [],
    } as const satisfies AssessedProviderEndpoint;
    expect(() => createProviderEndpointSetFingerprintV1({ endpoints: [
      { endpointTemplateId: 'local', endpoint: fabricated },
    ] })).toThrowError(/successful A\/AAAA resolution/u);
  });

  it('fingerprints persisted secret records without plaintext or mutable display metadata', () => {
    const a = createProviderSavedSecretRecordFingerprintV1({
      secretId: 'secret-a', persistedEncryptedEnvelope: { t: 'enc-v1', c: 'ciphertext-a' },
    });
    expect(createProviderSavedSecretRecordFingerprintV1({
      secretId: 'secret-a', persistedEncryptedEnvelope: { t: 'enc-v1', c: 'ciphertext-b' },
    })).not.toBe(a);
    expect(a).toMatch(/^saved-secret-record:v1:/);
  });

  it('fingerprints the complete normalized compatibility decision surface', () => {
    const input = {
      agentTargetKey: 'agent:codex',
      adapterVersion: 1,
      agent: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
        materialization: 'engineConfig',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: false,
      },
      endpoints: [{
        id: 'responses', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      credential: undefined,
      model: { id: 'model-a', name: 'Model A', capabilities: { toolRoundTrips: 'unknown' } },
    } as const;
    const fingerprint = resolveProviderBindingCompatibilityWithFingerprintV1(input).compatibilityFingerprint;
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input,
      endpoints: [{ ...input.endpoints[0], protocol: 'openai-chat' }],
    }).compatibilityFingerprint).not.toBe(fingerprint);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      ...input,
      endpoints: [{
        ...input.endpoints[0], capabilities: { ...input.endpoints[0].capabilities, streaming: 'unsupported' },
      }],
    }).compatibilityFingerprint).not.toBe(fingerprint);
    expect(fingerprint).toMatch(/^compatibility:v1:/);
  });

  it('derives compatibility result and fingerprint atomically while ignoring probe-only transport use', () => {
    const base = {
      agentTargetKey: 'agent:codex', adapterVersion: 1,
      endpoints: [{
        id: 'responses', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      credential: {
        kind: 'apiKey', slotId: 'apiKey', required: true,
        transports: [{
          id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      agent: {
        acceptsProtocols: ['openai-responses'], required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
          }],
        },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
        materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
      },
      model: { id: 'model-a', name: 'Model A' },
    } as const;
    const resolved = resolveProviderBindingCompatibilityWithFingerprintV1(base);
    const probeUseAdded = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...base,
      credential: {
        ...base.credential,
        transports: [{ ...base.credential.transports[0], uses: ['runtime', 'probe'] }],
      },
    });
    expect(probeUseAdded).toEqual(resolved);
    const transportRenamed = resolveProviderBindingCompatibilityWithFingerprintV1({
      ...base,
      credential: {
        ...base.credential,
        transports: [{ ...base.credential.transports[0], id: 'renamed-handle' }],
      },
    });
    expect(transportRenamed).toEqual(resolved);
    expect(() => resolveProviderBindingCompatibilityWithFingerprintV1({
      ...base,
      result: { status: 'incompatible', reasons: ['no_compatible_protocol'] },
    } as typeof base)).toThrowError(/derived by the canonical resolver/u);
  });

  it('uses one exact request fingerprint for probe authorization and runtime observations', () => {
    const input = {
      method: 'GET', endpointUrl: 'https://EXAMPLE.test:443/v1', path: '/v1/models?after=a',
      parser: 'openai-models', publicHeaders: { 'X-Title': 'Happier' },
    } as const;
    const request = createProviderProbeRequestFingerprintV1(input);
    expect(createProviderProbeRequestFingerprintV1({
      ...input, publicHeaders: { 'x-title': 'Happier' },
    })).toBe(request);
    expect(createProviderProbeRequestFingerprintV1({ ...input, path: '/v1/other-models' })).not.toBe(request);
    expect(createProviderProbeRequestFingerprintV1({ ...input, parser: 'ollama-tags' })).not.toBe(request);
    expect(createProviderProbeRequestFingerprintV1({
      ...input, publicHeaders: { 'x-title': 'Different' },
    })).not.toBe(request);
    expect(request).toMatch(/^probe-request:v1:/);

    const endpoint = createProviderEndpointFingerprintV1({
      endpointTemplateId: 'responses', protocol: 'openai-responses', probeRequestFingerprint: request,
    });
    expect(createProviderEndpointFingerprintV1({
      endpointTemplateId: 'responses', protocol: 'openai-chat', probeRequestFingerprint: request,
    })).not.toBe(endpoint);
    expect(endpoint).toMatch(/^endpoint-observation:v1:/);

    const catalog = createProviderCatalogFingerprintV1({ probeRequestFingerprints: [request] });
    expect(createProviderCatalogFingerprintV1({
      probeRequestFingerprints: [
        createProviderProbeRequestFingerprintV1({ ...input, path: '/v1/fallback' }),
        request,
      ],
    })).not.toBe(catalog);
    expect(catalog).toMatch(/^catalog:v1:/);
  });

  it('binds managed catalog requests to stable source authority without a realized port or bearer', () => {
    const input = {
      implementationIdentity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      managedFacet: {
        managedEndpoint: {
          localService: {
            id: 'cliproxyapi',
            launch: {
              kind: 'packaged-runtime-binary',
              directorySegments: ['tools', 'unpacked'],
              executableBaseName: 'cliproxyapi-managed',
              privateConfigPathFlag: '--config',
            },
            launchMode: {
              kind: 'assignAndInject',
              portPolicy: { kind: 'allocated' },
            },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'fixed', name: 'CLIProxyAPI' },
            healthCheck: { kind: 'http', path: '/healthz' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 60_000 },
          },
          protocols: ['openai-responses'],
        },
        connectedAccounts: [
          {
            purpose: 'ä-upstream',
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            required: true,
            materializationKinds: ['httpHeaders'],
          },
          {
            purpose: 'Z-upstream',
            service: {
              pluginId: 'happier.connected-account.google',
              localId: 'google',
            },
            required: true,
            materializationKinds: ['httpHeaders'],
          },
        ],
        requestAuthUses: [
          {
            purpose: 'ä-upstream',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://api.example.test',
              headerNames: ['authorization'],
            },
          },
          {
            purpose: 'Z-upstream',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://api.other.example.test',
              headerNames: ['authorization'],
            },
          },
        ],
      },
      purposeBindings: {
        v: 1,
        bindings: [
          {
            purpose: {
              consumer: {
                pluginId: 'happier.provider.cliproxyapi',
                localId: 'cliproxyapi',
              },
              purpose: 'ä-upstream',
            },
            target: {
              kind: 'account',
              account: {
                service: {
                  pluginId: 'happier.connected-account.openai',
                  localId: 'openai',
                },
                accountId: 'account-a',
              },
            },
          },
          {
            purpose: {
              consumer: {
                pluginId: 'happier.provider.cliproxyapi',
                localId: 'cliproxyapi',
              },
              purpose: 'Z-upstream',
            },
            target: {
              kind: 'account',
              account: {
                service: {
                  pluginId: 'happier.connected-account.google',
                  localId: 'google',
                },
                accountId: 'account-b',
              },
            },
          },
        ],
      },
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
      },
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
      method: 'GET',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: {},
    } as const;
    const fingerprint = createProviderManagedProbeRequestFingerprintV1(input);

    expect(fingerprint).toMatch(/^probe-request:v1:/);
    expect(createProviderManagedProbeRequestFingerprintV1(input)).toBe(fingerprint);
    expect(createProviderManagedProbeRequestFingerprintV1({
      ...input,
      catalogSource: { ...input.catalogSource, sdkVersion: 'v7.2.96' },
    })).not.toBe(fingerprint);
    expect(createProviderManagedProbeRequestFingerprintV1({
      ...input,
      catalogSource: { ...input.catalogSource, contractVersion: 'happier.cliproxyapi-managed/v2' },
    })).not.toBe(fingerprint);
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('localeCompare must not participate in Provider fingerprint identity');
    };
    try {
      expect(createProviderManagedProbeRequestFingerprintV1(input)).toBe(
        createProviderManagedProbeRequestFingerprintV1({
          ...input,
          purposeBindings: {
            ...input.purposeBindings,
            bindings: [...input.purposeBindings.bindings].reverse(),
          },
        }),
      );
      expect(createProviderManagedProbeRequestFingerprintV1(input)).toBe(
        createProviderManagedProbeRequestFingerprintV1({
          ...input,
          managedFacet: {
            ...input.managedFacet,
            connectedAccounts: [
              ...input.managedFacet.connectedAccounts,
            ].reverse(),
            requestAuthUses: [
              ...input.managedFacet.requestAuthUses,
            ].reverse(),
          },
        }),
      );
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
    expect(createProviderManagedProbeRequestFingerprintV1({
      ...input,
      purposeBindings: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: input.implementationIdentity,
            purpose: 'openai-upstream',
          },
          target: {
            kind: 'account',
            account: {
              service: {
                pluginId: 'happier.connected-account.openai',
                localId: 'openai',
              },
              accountId: 'account-a',
            },
          },
        }],
      },
    })).not.toBe(fingerprint);
    expect(createProviderManagedProbeRequestFingerprintV1({
      ...input,
      managedFacet: {
        ...input.managedFacet,
        requestAuthUses: input.managedFacet.requestAuthUses.map((use, index) => (
          index === 0
            ? {
                ...use,
                materialization: {
                  ...use.materialization,
                  origin: 'https://different.example.test',
                },
              }
            : use
        )),
      },
    })).not.toBe(fingerprint);
    expect(createProviderManagedProbeRequestFingerprintV1({
      ...input,
      path: '/v1/other-models',
    })).not.toBe(fingerprint);
  });

  it('binds catalog observations to the exact command fallback and resolved endpoint', () => {
    const probeRequestFingerprints = [createProviderProbeRequestFingerprintV1({
      method: 'GET', endpointUrl: 'http://127.0.0.1:11434/', path: '/api/tags',
      parser: 'ollama-tags', publicHeaders: {},
    })];
    const fallback = {
      descriptor: {
        endpointTemplateId: 'native', lookupNames: ['ollama'], fixedArgs: ['list'],
        parser: 'ollama-list-table' as const, endpointEnvName: 'OLLAMA_HOST',
      },
      endpointUrl: 'http://127.0.0.1:11434/',
    };
    const base = createProviderCatalogFingerprintV1({ probeRequestFingerprints, catalogFallback: fallback });
    expect(createProviderCatalogFingerprintV1({
      probeRequestFingerprints,
      catalogFallback: { ...fallback, endpointUrl: 'http://127.0.0.1:22434/' },
    })).not.toBe(base);
    expect(createProviderCatalogFingerprintV1({ probeRequestFingerprints })).not.toBe(base);
  });

  it('fingerprints grant authorization identity without mutable confirmation timestamps', () => {
    const account = {
      v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
    } as const;
    const accountFingerprint = createProviderAccountGrantFingerprintV1(account);
    expect(createProviderAccountGrantFingerprintV1({ ...account, confirmedAt: 99 })).toBe(accountFingerprint);
    expect(createProviderAccountGrantFingerprintV1({
      ...account, connectionSecurityFingerprint: 'connection-security:v1:b',
    })).not.toBe(accountFingerprint);
    expect(accountFingerprint).toMatch(/^account-grant:v1:/);

    const machine = {
      v: 1, machineId: 'machine_a', connectionId: 'pc_a',
      endpointSetFingerprint: 'endpoint-set:v1:a',
      connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
    } as const;
    const machineFingerprint = createProviderMachineGrantFingerprintV1(machine);
    expect(createProviderMachineGrantFingerprintV1({ ...machine, confirmedAt: 99 })).toBe(machineFingerprint);
    expect(createProviderMachineGrantFingerprintV1({
      ...machine, endpointSetFingerprint: 'endpoint-set:v1:b',
    })).not.toBe(machineFingerprint);
    expect(machineFingerprint).toMatch(/^machine-grant:v1:/);
  });

  it('binds runtime observations to the non-secret credential record and exact transport identity', () => {
    const credential = {
      transport: {
        id: 'bearer', protocols: ['openai-responses'], uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      },
      selectedProtocol: 'openai-responses',
      selectedUse: 'probe',
    } as const;
    const input = {
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:a',
      credential,
    } as const;
    const fingerprint = createProviderObservationAuthorizationFingerprintV1(input);
    expect(createProviderObservationAuthorizationFingerprintV1({
      ...input, selectedSecretRecordFingerprint: 'saved-secret-record:v1:rotated',
    })).not.toBe(fingerprint);
    expect(createProviderObservationAuthorizationFingerprintV1({
      ...input,
      credential: {
        ...credential,
        transport: {
          ...credential.transport,
          destination: { ...credential.transport.destination, name: 'X-API-Key', format: 'raw' },
        },
      },
    })).not.toBe(fingerprint);
    expect(createProviderObservationAuthorizationFingerprintV1({
      ...input,
      credential: {
        ...credential,
        transport: {
          ...credential.transport,
          protocols: ['openai-responses', 'anthropic'],
          uses: ['probe', 'runtime', 'management'],
        },
      },
    })).toBe(fingerprint);
    expect(fingerprint).toMatch(/^observation-authorization:v1:/);

    const noAuth = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential: null,
    });
    expect(noAuth).toMatch(/^observation-authorization:v1:/);
    expect(() => createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: 'secret-a', selectedSecretRecordFingerprint: null, credential,
    })).toThrowError(/present together/u);
    expect(() => createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential,
    })).toThrowError(/credential transport requires a selected secret/u);
  });

  it('projects one opaque probe observation identity from exact request, machine, authorization, and grant-event facts', () => {
    const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
      method: 'GET', endpointUrl: 'https://example.test/v1', path: '/v1/models',
      parser: 'openai-models', publicHeaders: {},
    });
    const catalogFingerprint = createProviderCatalogFingerprintV1({ probeRequestFingerprints: [probeRequestFingerprint] });
    const observationFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential: null,
    });
    const authorizationGrant = {
      kind: 'account' as const,
      fingerprint: createProviderAccountGrantFingerprintV1({
        v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
      }),
      confirmedAt: 1,
    };
    const base = createProviderProbeObservationIdentityV1({
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint,
      observationAuthorizationFingerprints: [observationFingerprint], authorizationGrant,
    });

    expect(base).toMatch(/^probe-observation:v1:/u);
    expect(createProviderProbeObservationIdentityV1({
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint,
      observationAuthorizationFingerprints: [observationFingerprint], authorizationGrant,
    })).toBe(base);
    expect(createProviderProbeObservationIdentityV1({
      machineId: 'machine_b', connectionId: 'pc_a', catalogFingerprint,
      observationAuthorizationFingerprints: [observationFingerprint], authorizationGrant,
    })).not.toBe(base);
    expect(createProviderProbeObservationIdentityV1({
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint,
      observationAuthorizationFingerprints: [observationFingerprint],
      authorizationGrant: { ...authorizationGrant, confirmedAt: 2 },
    })).not.toBe(base);
    expect(createProviderProbeObservationIdentityV1({
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint,
      observationAuthorizationFingerprints: [observationFingerprint],
      authorizationGrant: {
        kind: 'machine',
        fingerprint: createProviderMachineGrantFingerprintV1({
          v: 1, machineId: 'machine_a', connectionId: 'pc_a',
          endpointSetFingerprint: 'endpoint-set:v1:a',
          connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
        }),
        confirmedAt: 1,
      },
    })).not.toBe(base);
    expect(() => createProviderProbeObservationIdentityV1({
      machineId: 'machine_a', connectionId: 'pc_a', catalogFingerprint: null,
      observationAuthorizationFingerprints: [observationFingerprint], authorizationGrant,
    })).toThrowError(/present together/u);
  });

  it('keeps fixed cross-runtime vectors for every live typed fingerprint domain', () => {
    const agent = {
      acceptsProtocols: ['openai-responses'], required: {},
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
    } as const;
    expect({
      connection: createProviderConnectionSecurityFingerprintV1({
        securityContractVersion: 1,
        endpoints: [{ endpointTemplateId: 'responses', protocol: 'openai-responses', url: 'https://example.test/v1', publicHeaders: {} }],
        catalogProbes: [{ endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' }],
        availabilityProbe: { endpointTemplateId: 'responses', path: '/health', parser: 'openai-models' },
        credentialTransports: [],
      }),
      binding: createProviderBindingSecurityFingerprintV1({
        agentTargetKey: 'agent:codex', connectionId: 'pc_a', modelId: 'model-a',
        modelCapabilities: {},
        endpointTemplateId: 'responses', endpointUrl: 'https://example.test/v1', protocol: 'openai-responses',
        publicHeaders: {}, materialization: 'engineConfig', compatibilityFingerprint: 'compatibility:v1:a', adapterVersion: 1,
      }),
      endpointSet: createProviderEndpointSetFingerprintV1({ endpoints: [{
        endpointTemplateId: 'responses',
        endpoint: assessProviderEndpoint('https://example.test/v1', { resolvedAddresses: ['93.184.216.34'] }),
      }] }),
      compatibility: resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey: 'agent:codex', adapterVersion: 1, agent,
        endpoints: [{
          id: 'responses', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }],
        credential: undefined, model: { id: 'model-a', name: 'Model A' },
      }).compatibilityFingerprint,
      probeRequest: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://example.test/v1', path: '/v1/models',
        parser: 'openai-models', publicHeaders: {},
      }),
      endpointObservation: createProviderEndpointFingerprintV1({
        endpointTemplateId: 'responses', protocol: 'openai-responses',
        probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
          method: 'GET', endpointUrl: 'https://example.test/v1', path: '/v1/models',
          parser: 'openai-models', publicHeaders: {},
        }),
      }),
      catalog: createProviderCatalogFingerprintV1({ probeRequestFingerprints: [
        createProviderProbeRequestFingerprintV1({
          method: 'GET', endpointUrl: 'https://example.test/v1', path: '/v1/models',
          parser: 'openai-models', publicHeaders: {},
        }),
      ] }),
      observation: createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential: null,
      }),
      probeObservation: createProviderProbeObservationIdentityV1({
        machineId: 'machine_a', connectionId: 'pc_a',
        catalogFingerprint: createProviderCatalogFingerprintV1({ probeRequestFingerprints: [
          createProviderProbeRequestFingerprintV1({
            method: 'GET', endpointUrl: 'https://example.test/v1', path: '/v1/models',
            parser: 'openai-models', publicHeaders: {},
          }),
        ] }),
        observationAuthorizationFingerprints: [createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential: null,
        })],
        authorizationGrant: {
          kind: 'account',
          fingerprint: createProviderAccountGrantFingerprintV1({
            v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
          }),
          confirmedAt: 1,
        },
      }),
      accountGrant: createProviderAccountGrantFingerprintV1({
        v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
      }),
      machineGrant: createProviderMachineGrantFingerprintV1({
        v: 1, machineId: 'machine_a', connectionId: 'pc_a', endpointSetFingerprint: 'endpoint-set:v1:a',
        connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
      }),
      savedSecret: createProviderSavedSecretRecordFingerprintV1({
        secretId: 'secret-a', persistedEncryptedEnvelope: { t: 'enc-v1', c: 'ciphertext-a' },
      }),
    }).toEqual({
      connection: 'connection-security:v1:z_cpCxi4SC1u3YOFEgEEOBOYGRe8k6yJWe4TZD2p-4U',
      binding: 'binding-security:v1:sJWzredb9c_zMusg1SuSlnmpcu1aZLg68xZq13px_Ts',
      endpointSet: 'endpoint-set:v1:f4ZdXevIRRzkFVGwThPc6Qx9j4h65iX5k50NQ_x5OAQ',
      compatibility: 'compatibility:v1:CiZD3bgW42HDQ6GXxOMx0ptNdo7KxQ5_dSpP9eGLeIs',
      probeRequest: 'probe-request:v1:Z6W-8xY-bqWuOGOugX-lyYPaT-ka0OjrGvibqpzRhK8',
      endpointObservation: 'endpoint-observation:v1:_yXkhiVFToIoMRDJ6g5nl8r9DIBMns6oFbl-Zyi42PE',
      catalog: 'catalog:v1:KzohbZVoZlCNPUK8tpmzxUTMCMebiZEZXiUn-838eK4',
      observation: 'observation-authorization:v1:SuTDmbYo4O0wtiWtbteZ7gaRwUTDQfbATDiF4IuPELc',
      probeObservation: 'probe-observation:v1:pabrD2k2rZ1bPvKbe8AOzx7I-3J1_0j-ZESeGz22Af0',
      accountGrant: 'account-grant:v1:cI0puTgBEpYij46m9a81N7DXpwvuhKCUCmExkXrSGB8',
      machineGrant: 'machine-grant:v1:47tXQdT5LRTGbhQYMkJvPnCPM_fzgWtpdOpqI5x8SMk',
      savedSecret: 'saved-secret-record:v1:6u_bGJVm5x0_aLGfHoxELsYXFtrzLXglHBO9iLZqSeM',
    });
  });
});
