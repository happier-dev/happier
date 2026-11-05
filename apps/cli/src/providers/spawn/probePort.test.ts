import { describe, expect, it, vi } from 'vitest';

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
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { resolveProviderConnectionForMachine } from '../registry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { readProviderSettingsForCli } from '../settings/read';
import { createProviderOperationLifetime } from '../operationLifetime';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderProbeHttpClient, ProviderProbeCancelledError, type ProviderProbeTransport } from '../probe/client';
import { ProviderProbeDestinationAuthorizationError } from '../probe/authorization';

import {
  createRuntimeProviderModelLoadAuthorizationPort,
  createRuntimeProviderProbeAuthorizationPort,
} from './probePort';
import { renderProviderProbeCredential } from './runtimeCredential';

const privateConnectionId = ProviderConnectionIdSchema.parse('pc_private_gateway');
const privateEndpointUrl = 'http://gateway.internal:1234/';
const privateRegistry = { providersByContributionKey: new Map() };

function privateGrantedSnapshot(legacy = false) {
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
    providerSettings,
    registry: privateRegistry,
    dnsEvidenceByEndpointUrl: new Map([[privateEndpointUrl, ['10.0.0.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected private connection resolution');
  const fingerprints = legacy ? resolution.record.legacyGrantFingerprints! : resolution.record;
  const granted = ProviderSettingsV1Schema.parse({
    ...providerSettings,
    machineGrants: [{
      v: 1,
      machineId: 'machine-a',
      connectionId: privateConnectionId,
      endpointSetFingerprint: fingerprints.endpointSetFingerprint,
      connectionSecurityFingerprint: fingerprints.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
  });
  return {
    source: 'cache' as const,
    settings: AccountSettingsSchema.parse({}),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(granted).catalog },
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

function privateModelLoadGrantedSnapshot(legacy = false) {
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
    providerSettings,
    registry: privateModelLoadRegistry,
    dnsEvidenceByEndpointUrl: new Map([[privateModelLoadEndpointUrl, ['10.0.0.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected private model-load connection resolution');
  const fingerprints = legacy ? resolution.record.legacyGrantFingerprints! : resolution.record;
  const granted = ProviderSettingsV1Schema.parse({
    ...providerSettings,
    machineGrants: [{
      v: 1,
      machineId: 'machine-a',
      connectionId: privateModelLoadConnectionId,
      endpointSetFingerprint: fingerprints.endpointSetFingerprint,
      connectionSecurityFingerprint: fingerprints.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
  });
  return {
    source: 'cache' as const,
    settings: AccountSettingsSchema.parse({}),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(granted).catalog },
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: 'account-a',
  };
}

describe('provider probe authorization port', () => {
  it.each([false, true])('retains V2 private dispatch across DNS drift, preserves opaque legacy comparison and rejects changed origin (legacy=%s)', async legacy => {
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: privateRegistry,
      getAccountSettingsSnapshot: () => privateGrantedSnapshot(legacy),
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
    )).resolves.toMatchObject(legacy ? { ok: false, error: { code: 'provider_machine_grant_stale' } } : { ok: true });
    await expect(port.authorizeDestination(authorization.ticket, request,
      assessProviderEndpoint('http://other.internal:1234/', { resolvedAddresses: ['10.0.0.1'], privateNetworkConfirmed: true }),
    )).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('keeps the admitted bulk catalog across preference and catalog edits while new admissions read current authority', async () => {
    const admitted = privateGrantedSnapshot();
    let current = admitted;
    const resolveAddresses = vi.fn(async () => ['10.0.0.1']);
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: privateRegistry,
      getAccountSettingsSnapshot: () => current,
      resolveAddresses,
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
    const scope = {
      registry: privateRegistry,
      accountSettingsBasis: {
        scopeKey: admitted.scopeKey,
        settingsVersion: admitted.settingsVersion,
        providerConnectionsCatalog: admitted.providerConnectionsCatalog,
        accountSettings: admitted.settings,
        settingsRead: readProviderSettingsForCli(admitted),
      },
      dnsEvidenceByConnectionId: new Map([[
        privateConnectionId,
        new Map([[privateEndpointUrl, ['10.0.0.1']]]),
      ]]),
      lifetime: createProviderOperationLifetime({ wallTimeMs: 5_000 }),
    };
    await expect(port.authorize(request, scope)).resolves.toMatchObject({ ok: true });
    expect(resolveAddresses).not.toHaveBeenCalled();

    current = {
      ...admitted,
      settingsVersion: admitted.settingsVersion + 1,
    };
    await expect(port.authorize(request, scope)).resolves.toMatchObject({ ok: true });
    expect(resolveAddresses).not.toHaveBeenCalled();

    current = {
      ...admitted,
      settings: AccountSettingsSchema.parse({}),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 2,
        catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog },
      settingsVersion: admitted.settingsVersion + 2,
    };
    await expect(port.authorize(request, scope)).resolves.toMatchObject({
      ok: true,
    });
    await expect(port.authorize(request)).resolves.toMatchObject({ ok: false, error: { code: 'provider_connection_not_found' } });
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

  it('captures one admitted credential across legacy Machine admission DNS and same-Account edits while keeping credential forms inside its opaque lease', async () => {
    const key = new Uint8Array(32).fill(7);
    const rawSecret = 'raw secret/value';
    const encryptedValue = {
      _isSecretValue: true as const,
      encryptedValue: encryptSecretStringV1(
        rawSecret,
        key,
        (length) => new Uint8Array(length).fill(3),
      ),
    };
    const settings = AccountSettingsSchema.parse({ secrets: [{
      id: 'secret-a', name: 'Probe key', kind: 'apiKey', encryptedValue, createdAt: 1, updatedAt: 1,
    }] });
    const baseSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
      v: 1, id: 'pc_gateway', source: { kind: 'custom', template: {
        v: 1, name: 'Gateway', endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.internal/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }] },
        credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
      } }, role: 'named', displayName: 'Gateway', displayNameMode: 'custom',
      revision: 1, createdAt: 1, updatedAt: 1,
    }], secretBindingsByConnectionId: { pc_gateway: { account: { apiKey: 'secret-a' } } } });
    const registry = { providersByContributionKey: new Map() };
    const connection = resolveProviderConnectionForMachine({ connectionId: 'pc_gateway', machineId: 'machine-a',
      providerSettings: baseSettings, registry, dnsEvidenceByEndpointUrl: new Map([['https://gateway.internal/v1', ['10.0.0.1']]]) });
    if (connection.status !== 'resolved') throw new Error('Expected private credential source');
    const providerSettings = ProviderSettingsV1Schema.parse({ ...baseSettings, machineGrants: [{
      v: 1, connectionId: 'pc_gateway', machineId: 'machine-a', endpointSetFingerprint: connection.record.legacyGrantFingerprints!.endpointSetFingerprint,
      connectionSecurityFingerprint: connection.record.legacyGrantFingerprints!.connectionSecurityFingerprint, confirmedAt: 1,
    }] });
    let current: ActiveAccountSettingsSnapshot = { source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [key], scopeKey: 'account-a',
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog } };
    let enterDns!: () => void;
    let releaseDns!: () => void;
    const dnsEntered = new Promise<void>(resolve => { enterDns = resolve; });
    const heldDns = new Promise<readonly string[]>(resolve => { releaseDns = () => resolve(['10.0.0.1']); });
    const resolveAddresses = vi.fn(async () => { enterDns(); return heldDns; });
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry,
      getAccountSettingsSnapshot: () => current,
      resolveAddresses,
    });
    const request = { connectionId: ProviderConnectionIdSchema.parse('pc_gateway'), machineId: 'machine-a',
      endpointTemplateId: 'responses', endpointUrl: 'https://gateway.internal/v1', protocol: 'openai-responses' as const,
      path: '/models', parser: 'openai-models' as const, probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://gateway.internal/v1', path: '/models', parser: 'openai-models', publicHeaders: {},
      }) };
    const pending = port.authorize(request);
    try {
      await dnsEntered;
      const renamed = ProviderSettingsV1Schema.parse({ ...providerSettings, connections: providerSettings.connections.map(connection => ({
        ...connection, displayName: 'Renamed Gateway', revision: connection.revision + 1,
      })) });
      current = { ...current, settings: AccountSettingsSchema.parse({}), settingsVersion: 2,
        providerConnectionsCatalog: { status: 'ready', revision: 2, catalog: splitProviderSettingsV1(renamed).catalog } };
      releaseDns();
      const authorized = await pending;
      if (!authorized.ok) throw new Error(`Expected admitted credential, received ${authorized.error.code}`);
      if (!authorized.credentialRef) throw new Error('Expected admitted credential reference');
      await expect(port.revalidate(authorized.ticket, request)).resolves.toEqual({ ok: true });
      await expect(port.authorizeDestination(authorized.ticket, request,
        assessProviderEndpoint(request.endpointUrl, { resolvedAddresses: ['1.1.1.1'] }),
      )).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      const resolved = await port.resolveCredential(authorized.credentialRef);
      if (!resolved.ok) throw new Error(`Expected credential lease, received ${resolved.error.code}`);
      try {
        expect(resolved.lease.credential.value).toBe(`Bearer ${rawSecret}`);
        expect(resolved.lease.containsSensitiveValue(`echo ${rawSecret}`)).toBe(true);
        expect(resolved.lease.containsSensitiveValue(`echo Bearer ${rawSecret}`)).toBe(true);
        expect(resolved.lease.containsSensitiveValue('echo raw%20secret%2Fvalue')).toBe(true);
        expect(resolveAddresses).toHaveBeenCalledOnce();
      } finally { resolved.lease.close(); }
    } finally {
      releaseDns();
      await pending;
    }
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
    const accountBSettings = AccountSettingsSchema.parse({ secrets: [{
      id: 'secret-a', name: 'Account B key', kind: 'apiKey', encryptedValue, createdAt: 1, updatedAt: 1,
    }] });
    const inspected = createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
      accountSettings: accountBSettings,
      settingsSecretsReadKeys: [key],
    }).inspect('secret-a');
    if (inspected.status !== 'ready') throw new Error('Expected ready personal secret');
    const secretRecordFingerprint = inspected.fingerprint;
    const port = createRuntimeProviderProbeAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'network',
        settings: scopeKey === 'account-b' ? accountBSettings : accountSettingsParse({}),
        providerConnectionsCatalog: { status: 'ready', revision: 1,
          catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog },
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
  it.each(['retained', 'renamed', 'grant_revoked', 'account_withdrawn', 'cancelled'] as const)(
    'uses admitted authority and local cancellation across held destination DNS before a credential-free model POST (%s)',
    async (transition) => {
      const admitted = privateModelLoadGrantedSnapshot();
      let current: ActiveAccountSettingsSnapshot | null = admitted;
      let enterHeldDns!: () => void;
      const heldDnsEntered = new Promise<void>((resolve) => { enterHeldDns = resolve; });
      let releaseHeldDns!: () => void;
      const heldDns = new Promise<readonly string[]>((resolve) => {
        releaseHeldDns = () => resolve(['10.0.0.1']);
      });
      const resolveAddresses = vi.fn(async () => ['10.0.0.1']);
      const port = createRuntimeProviderModelLoadAuthorizationPort({
        registry: privateModelLoadRegistry,
        getAccountSettingsSnapshot: () => current,
        resolveAddresses,
      });
      const request = { connectionId: privateModelLoadConnectionId, machineId: 'machine-a', modelId: 'model-a' };
      const authorized = await port.authorize(request);
      if (authorized.status !== 'authorized') throw new Error('Expected initial model-load authorization');
      expect(authorized.authorization.credentialRef).toBeNull();
      // DNS and the HTTP transport are genuine external boundaries; the
      // destination callback below runs the canonical authorization owner.
      const transport = vi.fn<ProviderProbeTransport>(async () => ({
        status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}'),
      }));
      const client = createProviderProbeHttpClient({ resolveAddresses: async () => { enterHeldDns(); return heldDns; }, transport });
      const controller = new AbortController();
      const outcome = client.postModelLoad({
        endpointUrl: authorized.authorization.endpoint.endpointUrl,
        path: authorized.authorization.descriptor.path,
        modelId: request.modelId,
        publicHeaders: authorized.authorization.endpoint.publicHeaders,
        signal: controller.signal,
        authorizeDestination: async (destination) => {
          const checked = await port.authorizeDestination(authorized.authorization.ticket, request, destination);
          if (!checked.ok) throw new ProviderProbeDestinationAuthorizationError(checked.error);
        },
      }).then((result) => ({ result }), (error: unknown) => ({ error }));
      try {
        await heldDnsEntered;
        if (transition === 'grant_revoked') {
          current = { ...admitted, providerConnectionsCatalog: { status: 'ready', revision: 2,
            catalog: { ...admitted.providerConnectionsCatalog.catalog, machineGrants: [] } } };
        } else if (transition === 'renamed') {
          current = { ...admitted, providerConnectionsCatalog: { status: 'ready', revision: 2,
            catalog: { ...admitted.providerConnectionsCatalog.catalog, connections: admitted.providerConnectionsCatalog.catalog.connections.map(connection => ({
              ...connection, displayName: 'Renamed loader', revision: connection.revision + 1,
            })) } } };
        } else if (transition === 'account_withdrawn') {
          current = null;
        } else if (transition === 'cancelled') {
          controller.abort();
        }
        releaseHeldDns();
        if (transition === 'account_withdrawn' || transition === 'cancelled') {
          const result = await outcome;
          expect(transport).not.toHaveBeenCalled();
          expect(result).toMatchObject(transition === 'cancelled' ? { error: expect.any(ProviderProbeCancelledError) }
            : { error: { error: { code: 'provider_authorization_changed' } } });
        } else {
          expect(await outcome).toEqual({ result: { statusCode: 200 } });
          expect(transport).toHaveBeenCalledOnce();
          expect(transport.mock.calls[0]?.[0]).toMatchObject({ method: 'POST', url: `${privateModelLoadEndpointUrl}models/load` });
        }
        expect(resolveAddresses).not.toHaveBeenCalled();
        if (transition === 'grant_revoked') await expect(port.authorize(request)).resolves.toMatchObject({
          status: 'error', error: { code: 'provider_not_enabled_on_machine' },
        });
      } finally { releaseHeldDns(); await outcome; }
    },
  );

  it.each([false, true])('retains V2 model-load dispatch across DNS drift, preserves opaque legacy comparison and rejects changed origin (legacy=%s)', async legacy => {
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: privateModelLoadRegistry,
      getAccountSettingsSnapshot: () => privateModelLoadGrantedSnapshot(legacy),
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
    )).resolves.toMatchObject(legacy ? { ok: false, error: { code: 'provider_machine_grant_stale' } } : { ok: true });
    await expect(port.authorizeDestination(authorization.authorization.ticket, request,
      assessProviderEndpoint('http://other.internal:1234/models/load', { resolvedAddresses: ['10.0.0.1'], privateNetworkConfirmed: true }),
    )).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('exposes a concrete runtime factory without sharing draft probe authorization', () => {
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
    });
    expect(port).toMatchObject({
      authorize: expect.any(Function),
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
    const accountBSettings = AccountSettingsSchema.parse({ secrets: [{
      id: 'secret-a', name: 'Account B key', kind: 'apiKey', encryptedValue, createdAt: 1, updatedAt: 1,
    }] });
    const inspected = createSavedSecretMaterializerV1({ resources: [], resourceCatalogState: undefined,
      accountSettings: accountBSettings,
      settingsSecretsReadKeys: [key],
    }).inspect('secret-a');
    if (inspected.status !== 'ready') throw new Error('Expected ready personal secret');
    const secretRecordFingerprint = inspected.fingerprint;
    const port = createRuntimeProviderModelLoadAuthorizationPort({
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'network',
        settings: scopeKey === 'account-b' ? accountBSettings : accountSettingsParse({}),
        providerConnectionsCatalog: { status: 'ready', revision: 1,
          catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog },
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
