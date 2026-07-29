import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  AccountSettingsSchema,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  ProviderProbeRequestFingerprintV1Schema,
  accountSettingsParse,
  assessProviderEndpoint,
  createProviderProbeRequestFingerprintV1,
  createProviderSavedSecretRecordFingerprintV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { resolveProviderConnectionForMachine } from '../registry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import {
  createRuntimeProviderModelLoadAuthorizationPort,
  createRuntimeProviderProbeAuthorizationPort,
  revalidateProviderModelLoadAuthorizationTicket,
  revalidateProviderProbeAuthorizationTicket,
} from './probePort';
import { renderProviderProbeCredential } from './runtimeCredential';
import type {
  ProviderManagedProbeHostAuthorizationTicket,
  ProviderModelLoadHostAuthorizationTicket,
  ProviderProbeHostAuthorizationTicket,
} from './resolve';

const ticket: ProviderProbeHostAuthorizationTicket = {
  connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
  connectionRevision: 3,
  machineId: 'machine-a',
  connectionSecurityFingerprint: 'connection-security:v1:one',
  endpointSetFingerprint: 'endpoint-set:v1:one',
  grantFingerprint: 'account-grant:v1:one',
  connectionScope: 'account',
  endpointTemplateId: 'responses',
  endpointUrl: 'https://gateway.example/v1',
  protocol: 'openai-responses',
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:one'),
  selectedSecretBindingId: 'secret-a',
  selectedSecretRecordFingerprint: 'saved-secret-record:v1:one',
};

const managedTicket: ProviderManagedProbeHostAuthorizationTicket = {
  deployment: 'managedLocal',
  connectionId: ProviderConnectionIdSchema.parse('pc_managed_gateway'),
  connectionRevision: 3,
  machineId: 'machine-a',
  connectionSecurityFingerprint: 'connection-security:v1:managed',
  endpointSetFingerprint: 'endpoint-set:v1:managed',
  grantFingerprint: 'machine-grant:v1:managed',
  connectionScope: 'machine',
  contributionKey: 'happier.provider.gateway/gateway',
  implementationIdentity: {
    pluginId: 'happier.provider.gateway',
    localId: 'gateway',
  },
  managedFacet: {
    managedEndpoint: {
      localService: {
        id: 'gateway-managed',
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
        name: { strategy: 'fixed', name: 'Gateway managed' },
        healthCheck: { kind: 'http', path: '/healthz' },
        restart: { kind: 'never' },
        cleanup: { staleAfterMs: 60_000 },
      },
      protocols: ['openai-responses'],
    },
    connectedAccounts: [],
    requestAuthUses: [],
  },
  purposeBindings: { v: 1, bindings: [] },
  catalogSource: {
    kind: 'transientModelEndpoint',
    contractVersion: 'happier.gateway-managed/v1',
    sdkVersion: 'v1.2.3',
  },
  endpointTemplateId: 'responses',
  protocol: 'openai-responses',
  path: '/models',
  parser: 'openai-models',
  probeRequestFingerprint:
    ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:managed'),
};

const privateConnectionId = ProviderConnectionIdSchema.parse('pc_private_gateway');
const privateEndpointUrl = 'http://gateway.internal:1234/';
const privateRegistry = { providersByContributionKey: new Map() };

function privateGrantedSnapshot() {
  const providerSettings = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: privateConnectionId,
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'Private gateway',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat',
            baseUrl: privateEndpointUrl,
            capabilities: {
              streaming: 'unknown',
              toolRoundTrips: 'unknown',
              statefulResponses: 'unknown',
              reasoningControls: 'unknown',
            },
          }],
          catalog: {
            source: 'probe',
            manualModelPolicy: 'allowed',
            probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
          },
        },
      },
      role: 'named',
      displayName: 'Private gateway',
      displayNameMode: 'custom',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId: privateConnectionId,
    machineId: 'machine-a',
    accountSettings: { providerSettingsV1: providerSettings },
    registry: privateRegistry,
    dnsEvidenceByEndpointUrl: new Map([[privateEndpointUrl, ['10.0.0.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected private connection resolution');
  const granted = ProviderSettingsV1Schema.parse({
    ...providerSettings,
    machineGrants: [{
      v: 1,
      machineId: 'machine-a',
      connectionId: privateConnectionId,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
  });
  return {
    source: 'cache' as const,
    settings: AccountSettingsSchema.parse({ providerSettingsV1: granted }),
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: 'account-a',
  };
}

const privateModelLoadConnectionId = ProviderConnectionIdSchema.parse('pc_private_loader');
const privateModelLoadContributionKey = 'acme.loader/loader';
const privateModelLoadEndpointUrl = 'http://loader.internal:1234/';
const privateModelLoadDefinition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'loader',
  name: 'Private loader',
  kind: 'local',
  endpointTemplates: [{
    id: 'chat',
    protocol: 'openai-chat',
    localUrlCandidates: [privateModelLoadEndpointUrl],
    capabilities: {
      streaming: 'unknown',
      toolRoundTrips: 'unknown',
      statefulResponses: 'unknown',
      reasoningControls: 'unknown',
    },
  }],
  catalog: {
    source: 'probe',
    manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'lmstudio-native-models' }],
  },
  modelLoad: {
    endpointTemplateId: 'chat',
    path: '/models/load',
    request: 'json-model-id-v1',
    confirmation: 'refresh-catalog-load-state',
    preflightPolicy: 'advisory',
  },
});
const privateModelLoadContribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.loader',
  identity: { pluginId: 'acme.loader', localId: 'loader' },
  definition: privateModelLoadDefinition,
};
const privateModelLoadRegistry = {
  providersByContributionKey: new Map([[privateModelLoadContributionKey, privateModelLoadContribution]]),
};

function privateModelLoadGrantedSnapshot() {
  const providerSettings = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: privateModelLoadConnectionId,
      source: { kind: 'contribution', contributionKey: privateModelLoadContributionKey },
      role: 'default',
      displayName: 'Private loader',
      displayNameMode: 'automatic',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId: privateModelLoadConnectionId,
    machineId: 'machine-a',
    accountSettings: { providerSettingsV1: providerSettings },
    registry: privateModelLoadRegistry,
    dnsEvidenceByEndpointUrl: new Map([[privateModelLoadEndpointUrl, ['10.0.0.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected private model-load connection resolution');
  const granted = ProviderSettingsV1Schema.parse({
    ...providerSettings,
    machineGrants: [{
      v: 1,
      machineId: 'machine-a',
      connectionId: privateModelLoadConnectionId,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
  });
  return {
    source: 'cache' as const,
    settings: AccountSettingsSchema.parse({ providerSettingsV1: granted }),
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: 'account-a',
  };
}

describe('provider probe authorization port', () => {
  it('rejects a private dispatch address set that differs from the granted set even when an independent DNS lookup returns the granted address', async () => {
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: privateRegistry,
      getAccountSettingsSnapshot: privateGrantedSnapshot,
      resolveAddresses: async () => ['10.0.0.1'],
    });
    const request = {
      connectionId: privateConnectionId,
      machineId: 'machine-a',
      endpointTemplateId: 'chat',
      endpointUrl: privateEndpointUrl,
      protocol: 'openai-chat' as const,
      path: '/models',
      parser: 'openai-models' as const,
      probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET',
        endpointUrl: privateEndpointUrl,
        path: '/models',
        parser: 'openai-models',
        publicHeaders: {},
      }),
    };
    const authorization = await port.authorize(request);
    if (!authorization.ok) throw new Error('Expected initial authorization');

    await expect(port.authorizeDestination(
      authorization.ticket,
      request,
      assessProviderEndpoint(privateEndpointUrl, {
        resolvedAddresses: ['10.0.0.2'],
        privateNetworkConfirmed: true,
      }),
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_machine_grant_stale' },
    });
  });

  it('revalidates every request/grant/secret field and returns the precise current refusal', () => {
    expect(revalidateProviderProbeAuthorizationTicket(ticket, ticket)).toEqual({ ok: true });
    expect(revalidateProviderProbeAuthorizationTicket(ticket, {
      ...ticket,
      connectionRevision: 4,
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(revalidateProviderProbeAuthorizationTicket(ticket, {
      ...ticket,
      probeRequestFingerprint: ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:two'),
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(revalidateProviderProbeAuthorizationTicket(managedTicket, managedTicket)).toEqual({
      ok: true,
    });
    expect(revalidateProviderProbeAuthorizationTicket(managedTicket, {
      ...managedTicket,
      connectionRevision: 4,
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('keeps account-unverified managed catalog authorization stable across group-member churn', () => {
    const service = {
      pluginId: 'happier.connected-account.example',
      localId: 'example',
    } as const;
    const groupTicket: ProviderManagedProbeHostAuthorizationTicket = {
      ...managedTicket,
      managedFacet: {
        ...managedTicket.managedFacet,
        connectedAccounts: [{
          purpose: 'upstream',
          service,
          required: true,
        }],
      },
      purposeBindings: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: managedTicket.implementationIdentity,
            purpose: 'upstream',
          },
          target: {
            kind: 'group',
            service,
            groupId: 'primary',
          },
        }],
      },
    };

    // The characterized source is credential-free/account-unverified, so an
    // A/gen7 -> B/gen8 selection change deliberately produces the same ticket.
    expect(revalidateProviderProbeAuthorizationTicket(
      groupTicket,
      { ...groupTicket },
    )).toEqual({ ok: true });
    expect(revalidateProviderProbeAuthorizationTicket(groupTicket, {
      ...groupTicket,
      purposeBindings: {
        v: 1,
        bindings: [{
          ...groupTicket.purposeBindings.bindings[0]!,
          target: {
            kind: 'group',
            service,
            groupId: 'secondary',
          },
        }],
      },
    })).toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    expect(revalidateProviderProbeAuthorizationTicket(groupTicket, {
      ...groupTicket,
      catalogSource: {
        ...groupTicket.catalogSource,
        sdkVersion: 'v1.2.4',
      },
    })).toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
  });

  it('renders only the selected typed destination', () => {
    expect(renderProviderProbeCredential('secret', {
      id: 'bearer', protocols: ['openai-responses'], uses: ['probe'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
    })).toEqual({ kind: 'httpHeader', name: 'authorization', value: 'Bearer secret' });
    expect(renderProviderProbeCredential('secret', {
      id: 'query', protocols: ['openai-responses'], uses: ['probe'],
      destination: { kind: 'queryParam', name: 'key', format: { template: 'token-{secret}' } },
    })).toEqual({ kind: 'queryParam', name: 'key', value: 'token-secret' });
  });

  it('maps snapshot/decryption boundary exceptions to a stable provider error', async () => {
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => {
        throw new Error('secret-store unavailable: must not escape');
      },
    });

    await expect(port.resolveCredential({
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      machineId: 'machine-a',
      reference: {
        kind: 'apiKey',
        secretId: 'secret-a',
        secretRecordFingerprint: 'saved-secret-record:v1:one',
      },
      transport: {
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['probe'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
      protocol: 'openai-responses',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_secret_missing', connectionId: 'pc_gateway', machineId: 'machine-a' },
    });
  });

  it('keeps authorization and credential resolution pinned to the first account scope', async () => {
    let scopeKey = 'account-a';
    const key = new Uint8Array(32).fill(7);
    const encryptedValue = {
      _isSecretValue: true as const,
      encryptedValue: encryptSecretStringV1(
        'account-b-secret',
        key,
        (length) => new Uint8Array(length).fill(3),
      ),
    };
    const secretRecordFingerprint = createProviderSavedSecretRecordFingerprintV1({
      secretId: 'secret-a',
      persistedEncryptedEnvelope: encryptedValue.encryptedValue,
    });
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'network',
        settings: accountSettingsParse(scopeKey === 'account-b'
          ? { secrets: [{ id: 'secret-a', encryptedValue }] }
          : {}),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: scopeKey === 'account-b' ? [key] : [],
        scopeKey,
      }),
    });

    await expect(port.authorize({
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      machineId: 'machine-a',
      endpointTemplateId: 'responses',
      endpointUrl: 'https://gateway.example/v1',
      protocol: 'openai-responses',
      path: '/models',
      parser: 'openai-models',
      probeRequestFingerprint: ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:one'),
    })).resolves.toMatchObject({ ok: false, error: { code: 'provider_connection_not_found' } });

    scopeKey = 'account-b';
    await expect(port.resolveCredential({
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      machineId: 'machine-a',
      reference: {
        kind: 'apiKey',
        secretId: 'secret-a',
        secretRecordFingerprint,
      },
      transport: {
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['probe'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
      protocol: 'openai-responses',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
  });
});

describe('provider model-load authorization port', () => {
  const loadTicket: ProviderModelLoadHostAuthorizationTicket = {
    connectionId: ProviderConnectionIdSchema.parse('pc_local'),
    connectionRevision: 3,
    machineId: 'machine-a',
    modelId: 'model-a',
    connectionSecurityFingerprint: 'connection-security:v1:one',
    endpointSetFingerprint: 'endpoint-set:v1:one',
    grantFingerprint: 'machine-grant:v1:one',
    connectionScope: 'machine',
    endpointTemplateId: 'local',
    endpointUrl: 'http://127.0.0.1:1234/',
    protocol: 'openai-chat',
    descriptor: {
      endpointTemplateId: 'local',
      path: '/api/v1/models/load',
      request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state',
      preflightPolicy: 'advisory',
    },
    selectedSecretBindingId: null,
    selectedSecretRecordFingerprint: null,
  };

  it('rejects a model-load dispatch address set that differs from the exact granted private set', async () => {
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: privateModelLoadRegistry,
      getAccountSettingsSnapshot: privateModelLoadGrantedSnapshot,
      resolveAddresses: async () => ['10.0.0.1'],
    });
    const request = {
      connectionId: privateModelLoadConnectionId,
      machineId: 'machine-a',
      modelId: 'model-a',
    };
    const authorization = await port.authorize(request);
    if (authorization.status !== 'authorized') throw new Error('Expected model-load authorization');

    await expect(port.authorizeDestination(
      authorization.authorization.ticket,
      request,
      assessProviderEndpoint(`${privateModelLoadEndpointUrl}models/load`, {
        resolvedAddresses: ['10.0.0.2'],
        privateNetworkConfirmed: true,
      }),
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_machine_grant_stale' },
    });
  });

  it('revalidates the exact model, descriptor, endpoint, grant, and credential identity', () => {
    expect(revalidateProviderModelLoadAuthorizationTicket(loadTicket, loadTicket)).toEqual({ ok: true });
    expect(revalidateProviderModelLoadAuthorizationTicket(loadTicket, {
      ...loadTicket,
      connectionRevision: 4,
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(revalidateProviderModelLoadAuthorizationTicket(loadTicket, {
      ...loadTicket,
      modelId: 'model-b',
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(revalidateProviderModelLoadAuthorizationTicket(loadTicket, {
      ...loadTicket,
      descriptor: { ...loadTicket.descriptor, path: '/different' },
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('exposes a concrete runtime factory without sharing draft probe authorization', () => {
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
    });
    expect(port).toMatchObject({
      authorize: expect.any(Function),
      revalidate: expect.any(Function),
      authorizeDestination: expect.any(Function),
      resolveCredential: expect.any(Function),
    });
  });

  it('pins model-load credential resolution to the account that began authorization', async () => {
    let scopeKey = 'account-a';
    const key = new Uint8Array(32).fill(9);
    const encryptedValue = {
      _isSecretValue: true as const,
      encryptedValue: encryptSecretStringV1(
        'account-b-secret',
        key,
        (length) => new Uint8Array(length).fill(4),
      ),
    };
    const secretRecordFingerprint = createProviderSavedSecretRecordFingerprintV1({
      secretId: 'secret-a',
      persistedEncryptedEnvelope: encryptedValue.encryptedValue,
    });
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'network',
        settings: accountSettingsParse(scopeKey === 'account-b'
          ? { secrets: [{ id: 'secret-a', encryptedValue }] }
          : {}),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: scopeKey === 'account-b' ? [key] : [],
        scopeKey,
      }),
    });

    await expect(port.authorize({
      connectionId: ProviderConnectionIdSchema.parse('pc_local'),
      machineId: 'machine-a',
      modelId: 'model-a',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_not_found' } });

    scopeKey = 'account-b';
    await expect(port.resolveCredential({
      connectionId: ProviderConnectionIdSchema.parse('pc_local'),
      machineId: 'machine-a',
      reference: { kind: 'apiKey', secretId: 'secret-a', secretRecordFingerprint },
      transport: {
        id: 'management',
        protocols: ['openai-chat'],
        uses: ['management'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
      protocol: 'openai-chat',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
  });
});
