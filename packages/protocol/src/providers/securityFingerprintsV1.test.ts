import { describe, expect, it } from 'vitest';

import {
  createProviderAccountGrantFingerprintV1,
  createProviderBindingSecurityFingerprintV1,
  createProviderCatalogFingerprintV1,
  createProviderConnectionSecurityFingerprintV1,
  createProviderEndpointSetFingerprintV1,
  createProviderMachineGrantFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
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

describe('typed provider security fingerprints', () => {
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

  it('binds an agent/model/materialization without accepting display or secret values', () => {
    const base = {
      agentTargetKey: 'agent:codex', connectionId: 'pc_a', modelId: 'model/a',
      endpointTemplateId: 'responses', endpointUrl: 'https://example.test/v1', protocol: 'openai-responses',
      publicHeaders: {}, materialization: 'engineConfig', adapterBindingKey: 'pc_a',
      credentialDestination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      compatibilityFingerprint: 'compatibility:v1:a', adapterVersion: 1,
    } as const;
    expect(createProviderBindingSecurityFingerprintV1({ ...base, modelId: 'model/b' })).not.toBe(
      createProviderBindingSecurityFingerprintV1(base),
    );
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
      result: { status: 'incompatible', reasons: ['caller-forged'] },
    } as typeof base)).toThrowError(/derived by the canonical resolver/u);
  });

  it('fingerprints ordered catalog probes with their resolved endpoints', () => {
    const input = { probes: [{
      probe: { endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' },
      endpointUrl: 'https://EXAMPLE.test:443/v1',
    }] } as const;
    const fingerprint = createProviderCatalogFingerprintV1(input);
    expect(createProviderCatalogFingerprintV1({ probes: [{
      ...input.probes[0], endpointUrl: 'https://example.test/v2',
    }] })).not.toBe(fingerprint);
    expect(fingerprint).toMatch(/^catalog:v1:/);
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
      catalog: createProviderCatalogFingerprintV1({ probes: [{
        probe: { endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' },
        endpointUrl: 'https://example.test/v1',
      }] }),
      observation: createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: null, selectedSecretRecordFingerprint: null, credential: null,
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
      connection: 'connection-security:v1:yWIzUn9sfw37SDEqPWKsSbSC1iyK_CY-y04kP7z6U5g',
      binding: 'binding-security:v1:sJWzredb9c_zMusg1SuSlnmpcu1aZLg68xZq13px_Ts',
      endpointSet: 'endpoint-set:v1:f4ZdXevIRRzkFVGwThPc6Qx9j4h65iX5k50NQ_x5OAQ',
      compatibility: 'compatibility:v1:uGu0fHonIjMEgYY_UFjgQ0LetUQIbtZhJIDWu3Ghhcg',
      catalog: 'catalog:v1:gxoB1fqiGE8hEFDQz0RD30OGDVbK09q5ut5FRC1yH6E',
      observation: 'observation-authorization:v1:SuTDmbYo4O0wtiWtbteZ7gaRwUTDQfbATDiF4IuPELc',
      accountGrant: 'account-grant:v1:cI0puTgBEpYij46m9a81N7DXpwvuhKCUCmExkXrSGB8',
      machineGrant: 'machine-grant:v1:47tXQdT5LRTGbhQYMkJvPnCPM_fzgWtpdOpqI5x8SMk',
      savedSecret: 'saved-secret-record:v1:6u_bGJVm5x0_aLGfHoxELsYXFtrzLXglHBO9iLZqSeM',
    });
  });
});
