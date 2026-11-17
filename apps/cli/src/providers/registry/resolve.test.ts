import { describe, expect, it } from 'vitest';
import {
  createProviderEndpointSetFingerprintV1,
  createProviderEndpointSetFingerprintV2,
  createProviderConnectionSecurityFingerprintV1,
  assessProviderEndpoint,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderConnectionIdSchema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import {
  resolveProviderConnectionForMachine,
} from './index';
import type { ProviderContributionRegistryView } from './types';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/deepseek/src/provider/contribution';
import { OPENROUTER_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/openrouter/src/provider/contribution';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/vercel-ai-gateway/src/provider/contribution';
import { setProviderConnectionGrant } from '@/providers/connections/service/grants';

const contributionKey = 'acme.gateway/gateway';
const canonicalContributionKey = 'acme.gateway/gateway';

function providerDefinition(baseUrl = 'https://gateway.example/v1') {
  return ProviderContributionV1Schema.parse({
    v: 1,
    id: 'gateway',
    name: 'Gateway',
    kind: 'cloud',
    endpointTemplates: [{
      id: 'responses',
      protocol: 'openai-responses',
      baseUrl,
      publicHeaders: { 'X-Provider-Client': 'happier' },
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'unknown',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    }],
    credential: {
      kind: 'apiKey',
      required: true,
      transports: [{
        id: 'runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      }],
    },
    catalog: {
      source: 'probe',
      manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
    },
  });
}

function contribution(baseUrl?: string): ResolvedProviderContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.gateway',
    identity: { pluginId: 'acme.gateway', localId: 'gateway' },
    definition: providerDefinition(baseUrl),
  };
}

function managedContribution(
  dependency = 'gateway-managed',
  options: Readonly<{ required?: boolean; minimumBound?: 1 }> = {},
): ResolvedProviderContribution {
  const baseDefinition = providerDefinition();
  const definition = ProviderContributionV1Schema.parse({
    ...baseDefinition,
    catalog: {
      ...baseDefinition.catalog,
      sourceRegistryVersion: 'gateway-model-registry/v1',
    },
    managedRuntime: {
      kind: 'managed',
      dependencies: [dependency],
      endpointTemplateIds: ['responses'],
      ...(options.minimumBound === undefined
        ? {}
        : { connectedAccountPurposeBindingPolicy: { minimumBound: options.minimumBound } }),
      connectedAccounts: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.example',
          localId: 'example',
        },
        required: options.required ?? true,
        materializationKinds: ['httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
    },
  });
  return {
    ...contribution(),
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition,
  };
}

function externalManagedContribution(
  source: 'path' | 'package',
): ResolvedProviderContribution {
  const bundled = managedContribution();
  return {
    ...bundled,
    provenance: 'external',
    source: source === 'path'
      ? { kind: 'path' }
      : { kind: 'package' },
  };
}

function localContribution(): ResolvedProviderContribution {
  return {
    ...contribution(),
    definition: ProviderContributionV1Schema.parse({
      v: 1,
      id: 'gateway',
      name: 'Local Gateway',
      kind: 'local',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        localUrlCandidates: ['http://localhost:4545/v1', 'http://127.0.0.1:4545/v1'],
        capabilities: {
          streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    }),
  };
}

function registry(value: ResolvedProviderContribution = contribution()): ProviderContributionRegistryView {
  return { providersByContributionKey: new Map([[canonicalContributionKey, value]]) };
}

function connection(
  id: string,
  overrides: Partial<ProviderSettingsV1['connections'][number]> = {},
): ProviderSettingsV1['connections'][number] {
  return {
    v: 1,
    id: id as ProviderSettingsV1['connections'][number]['id'],
    source: { kind: 'contribution', contributionKey },
    role: 'default',
    displayName: 'Gateway',
    displayNameMode: 'automatic',
    deployment: { kind: 'external' },
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function settingsWith(
  connections: ProviderSettingsV1['connections'],
  overrides: Partial<ProviderSettingsV1> = {},
): ProviderSettingsV1 {
  return {
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections,
    ...overrides,
  };
}

const publicDns = new Map([
  ['https://gateway.example/v1', ['1.1.1.1']],
  ['https://gateway-v2.example/v1', ['8.8.8.8']],
]);

describe('Provider grant consent identity across harmless declaration and DNS changes', () => {
  it('keeps an explicitly confirmed HTTP private hostname usable without admission DNS', () => {
    const url = 'http://gateway.internal/v1';
    const declared = contribution(url);
    const configured = connection('pc_http_private');
    const resolve = (providerSettings: ProviderSettingsV1, withDns: boolean) => resolveProviderConnectionForMachine({
      connectionId: configured.id, machineId: 'machine-1', providerSettings, registry: registry(declared),
      dnsEvidenceByEndpointUrl: new Map(withDns ? [[url, ['10.0.0.1']]] : []),
    });
    const initial = resolve(settingsWith([configured]), true);
    expect(initial).toMatchObject({ status: 'resolved', record: { scope: 'machine', authorization: { authorized: false } } });
    if (initial.status !== 'resolved') throw new Error('Expected the private HTTP endpoint to admit consent');
    const enabled = setProviderConnectionGrant({ settings: settingsWith([configured]), connectionId: configured.id,
      machineId: 'machine-1', scope: 'machine', enabled: true, now: 10,
      connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint, endpointSetFingerprint: initial.record.endpointSetFingerprint });
    expect(resolve(enabled, false)).toMatchObject({ status: 'resolved', record: { scope: 'machine', authorization: { authorized: true } } });
    expect(() => assessProviderEndpoint(url, { resolvedAddresses: ['8.8.8.8'], privateNetworkConfirmed: true }))
      .toThrow(expect.objectContaining({ code: 'http_public_forbidden' }));
  });

  it('keeps Account enablement through catalog, usage, load and presentation declaration changes', async () => {
    const base = contribution();
    let declared: ResolvedProviderContribution = { ...base, definition: ProviderContributionV1Schema.parse({
      ...base.definition, kind: 'local',
      credential: { ...base.definition.credential, transports: [{ id: 'runtime-bearer', protocols: ['openai-responses'],
        uses: ['runtime', 'management'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses',
        path: '/models', parser: 'gateway-models', reportsModelLoadState: true }] },
      modelLoad: { endpointTemplateId: 'responses', path: '/load', request: 'json-model-id-v1',
        confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory' },
    }) };
    let catalog = splitProviderSettingsV1(settingsWith([connection('pc_consent')])).catalog;
    const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
      readCatalog: async () => ({ status: 'ready', revision: 4, catalog }),
      readDefinitions: async () => [{ contributionKey, definition: declared.definition, provenance: declared.provenance }],
      writeCatalog: async value => { catalog = value.catalog; return { status: 'updated' }; },
    });
    expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
      action: 'setEnabled', connectionId: 'pc_consent', scope: 'account', enabled: true,
    }), { surface: 'cli' })).toMatchObject({ ok: true });
    expect(catalog.accountGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    const resolve = (dnsEvidenceByEndpointUrl = publicDns) => resolveProviderConnectionForMachine({ connectionId: 'pc_consent', machineId: 'machine-1',
      providerSettings: composeProviderSettingsV1(catalog, {}), registry: registry(declared), dnsEvidenceByEndpointUrl });
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'account' } } });
    expect(resolve(new Map([['https://gateway.example/v1', ['10.0.0.1']]]))).toMatchObject({ status: 'resolved',
      record: { scope: 'account', authorization: { authorized: true, grantKind: 'account' } } });
    expect(resolve(new Map())).toMatchObject({ status: 'resolved',
      record: { scope: 'account', authorization: { authorized: true, grantKind: 'account' } } });
    declared = { ...declared, definition: ProviderContributionV1Schema.parse({ ...declared.definition,
      name: 'Renamed Gateway', kind: 'local',
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses',
        path: '/new-models', parser: 'gateway-models', reportsModelLoadState: true }] },
      usageSources: [{ id: 'balance', endpointTemplateId: 'responses', path: '/balance', parser: 'balance' }],
      modelLoad: { endpointTemplateId: 'responses', path: '/load-updated', request: 'json-model-id-v1',
        confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory' },
    }) };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'account' } } });
    const unchangedDefinition = declared.definition;
    declared = { ...declared, definition: ProviderContributionV1Schema.parse({ ...unchangedDefinition,
      credential: { ...unchangedDefinition.credential, transports: [{ id: 'runtime-bearer', protocols: ['openai-responses'],
        uses: ['runtime', 'management'], destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }] },
    }) };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_account_grant_stale' } } });
    declared = { ...declared, definition: ProviderContributionV1Schema.parse({ ...unchangedDefinition,
      endpointTemplates: [{ ...unchangedDefinition.endpointTemplates[0], baseUrl: 'https://changed.example/v1' }],
    }) };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_account_grant_stale' } } });
    declared = { ...declared, definition: unchangedDefinition };
    catalog = { ...catalog, accountGrants: [] };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_connection_disabled' } } });
  });

  it('keeps a Machine grant when DNS addresses change within the same private endpoint and Machine', () => {
    const configured = connection('pc_private_consent');
    const resolve = (providerSettings: ProviderSettingsV1, address: string | null, machineId = 'machine-1') =>
      resolveProviderConnectionForMachine({ connectionId: configured.id, machineId, providerSettings,
        registry: registry(), dnsEvidenceByEndpointUrl: new Map(address ? [['https://gateway.example/v1', [address]]] : []) });
    const initial = resolve(settingsWith([configured]), '10.0.0.1');
    if (initial.status !== 'resolved') throw new Error('Expected initial private endpoint resolution');
    const enabled = setProviderConnectionGrant({ settings: settingsWith([configured]), connectionId: configured.id,
      machineId: 'machine-1', scope: 'machine', enabled: true,
      connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
      endpointSetFingerprint: initial.record.endpointSetFingerprint, now: 10 });
    expect(enabled.machineGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    expect(enabled.machineGrants[0]?.endpointSetFingerprint).toMatch(/^endpoint-set:v2:/);
    expect(resolve(enabled, '10.0.0.1')).toMatchObject({ status: 'resolved', record: { scope: 'machine',
      authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(enabled, '10.0.0.2')).toMatchObject({ status: 'resolved', record: { scope: 'machine',
      authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(enabled, null)).toMatchObject({ status: 'resolved', record: { scope: 'machine',
      authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(enabled, '8.8.8.8')).toMatchObject({ status: 'resolved', record: { scope: 'machine',
      authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(enabled, '10.0.0.2', 'machine-2')).toMatchObject({ status: 'resolved', record: {
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' } } });
    expect(resolve({ ...enabled, machineGrants: [] }, '10.0.0.2')).toMatchObject({ status: 'resolved', record: {
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' } } });
    expect(resolve({ ...enabled, connections: [{ ...configured,
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://changed.example/v1' }],
    }] }, '10.0.0.2')).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_machine_grant_stale' } } });
    const declared = contribution();
    expect(resolveProviderConnectionForMachine({ connectionId: configured.id, machineId: 'machine-1',
      providerSettings: enabled, dnsEvidenceByEndpointUrl: new Map([['https://gateway.example/v1', ['10.0.0.2']]]),
      registry: registry({ ...declared, definition: ProviderContributionV1Schema.parse({ ...declared.definition,
        credential: { ...declared.definition.credential, transports: [{ id: 'runtime-bearer', protocols: ['openai-responses'],
          uses: ['runtime'], destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }] },
      }) }),
    })).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_machine_grant_stale' } } });
    const both = { ...enabled, accountGrants: [{ v: 1 as const, connectionId: configured.id,
      connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint, confirmedAt: 11 }] };
    expect(resolve(both, '8.8.8.8')).toMatchObject({ status: 'resolved', record: { scope: 'machine',
      authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(both, '8.8.8.8', 'machine-2')).toMatchObject({ status: 'resolved', record: { scope: 'account',
      authorization: { authorized: true, grantKind: 'account' } } });
  });

  it('keeps opaque legacy comparison until explicit Account re-consent writes the destination shape', async () => {
    let declared = contribution();
    const legacyFingerprint = createProviderConnectionSecurityFingerprintV1({ securityContractVersion: 1,
      endpoints: [{ endpointTemplateId: 'responses', protocol: 'openai-responses', url: 'https://gateway.example/v1',
        publicHeaders: { 'X-Provider-Client': 'happier' } }],
      catalogProbes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
      credentialTransports: declared.definition.credential?.transports ?? [] });
    let catalog = splitProviderSettingsV1(settingsWith([connection('pc_legacy_consent')], { accountGrants: [{
      v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_legacy_consent'), connectionSecurityFingerprint: legacyFingerprint, confirmedAt: 1,
    }] })).catalog;
    const resolve = () => resolveProviderConnectionForMachine({ connectionId: 'pc_legacy_consent', machineId: 'machine-1',
      providerSettings: composeProviderSettingsV1(catalog, {}), registry: registry(declared), dnsEvidenceByEndpointUrl: publicDns });
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true } } });
    declared = { ...declared, definition: ProviderContributionV1Schema.parse({ ...declared.definition,
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses',
        path: '/new-models', parser: 'openai-models' }] } }) };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_account_grant_stale' } } });
    const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
      readCatalog: async () => ({ status: 'ready', revision: 4, catalog }),
      readDefinitions: async () => [{ contributionKey, definition: declared.definition, provenance: declared.provenance }],
      writeCatalog: async value => { catalog = value.catalog; return { status: 'updated' }; },
    });
    expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
      action: 'setEnabled', connectionId: 'pc_legacy_consent', scope: 'account', enabled: true,
    }), { surface: 'cli' })).toMatchObject({ ok: true });
    expect(catalog.accountGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true } } });
    catalog = { ...catalog, accountGrants: [{ ...catalog.accountGrants[0]!,
      connectionSecurityFingerprint: 'connection-security:v1:unknown-history' }] };
    expect(resolve()).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_account_grant_stale' } } });
  });

  it('retains opaque Machine DNS comparison until explicit Machine re-consent writes the destination shape', () => {
    const configured = connection('pc_legacy_machine');
    const declared = contribution();
    const oldConnection = createProviderConnectionSecurityFingerprintV1({ securityContractVersion: 1,
      endpoints: [{ endpointTemplateId: 'responses', protocol: 'openai-responses', url: 'https://gateway.example/v1',
        publicHeaders: { 'X-Provider-Client': 'happier' } }],
      catalogProbes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
      credentialTransports: declared.definition.credential?.transports ?? [] });
    const oldEndpoints = createProviderEndpointSetFingerprintV1({ endpoints: [{ endpointTemplateId: 'responses',
      endpoint: assessProviderEndpoint('https://gateway.example/v1', {
        resolvedAddresses: ['10.0.0.1'], purpose: 'configuration', privateNetworkConfirmed: true,
      }) }] });
    const legacy = settingsWith([configured], { machineGrants: [{ v: 1, connectionId: configured.id, machineId: 'machine-1',
      connectionSecurityFingerprint: oldConnection, endpointSetFingerprint: oldEndpoints, confirmedAt: 1 }] });
    const resolve = (providerSettings: ProviderSettingsV1, address: string) => resolveProviderConnectionForMachine({
      connectionId: configured.id, machineId: 'machine-1', providerSettings, registry: registry(declared),
      dnsEvidenceByEndpointUrl: new Map([['https://gateway.example/v1', [address]]]),
    });
    const initial = resolve(legacy, '10.0.0.1');
    expect(initial).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolve(legacy, '10.0.0.2')).toMatchObject({ status: 'resolved', record: { authorization: {
      authorized: false, errorCode: 'provider_machine_grant_stale' } } });
    if (initial.status !== 'resolved') throw new Error('Expected healthy legacy Machine grant');
    const renewed = setProviderConnectionGrant({ settings: legacy, connectionId: configured.id, machineId: 'machine-1',
      scope: 'machine', enabled: true, connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
      endpointSetFingerprint: initial.record.endpointSetFingerprint, now: 10 });
    expect(renewed.machineGrants[0]?.connectionSecurityFingerprint).toMatch(/^connection-security:v2:/);
    expect(resolve(renewed, '10.0.0.2')).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true } } });
    expect(legacy.machineGrants[0]?.connectionSecurityFingerprint).toBe(oldConnection);
    expect(legacy.machineGrants[0]?.endpointSetFingerprint).toBe(oldEndpoints);
  });
});

it('resolves a configured family while unused required coordinates stay unconfigured, with header-only Machine inheritance', () => {
  const base = providerDefinition();
  const { baseUrl: _url, ...endpoint } = base.endpointTemplates[0]!;
  const definition = ProviderContributionV1Schema.parse({ ...base, catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    endpointTemplates: [{ ...endpoint, requiresEndpointOverride: true, publicHeaders: { 'x-policy': 'template' },
      addressConstraint: { origin: 'https://gateway.example', pathSegments: ['v1'] } },
    { ...endpoint, id: 'chat', protocol: 'openai-chat', requiresEndpointOverride: true,
      requiredPublicHeaders: ['x-routing'], addressConstraint: { origin: 'https://account.example', pathSegments: ['v1'] } }] });
  const configured = connection('pc_partial', { endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://gateway.example/v1',
    publicHeaders: { 'X-Policy': 'account' } }], endpointOverridesByMachineId: {
      'machine-1': [{ endpointTemplateId: 'responses', publicHeaders: { 'X-Mode': 'machine' } }],
    } });
  const resolve = (value = configured) => resolveProviderConnectionForMachine({ connectionId: 'pc_partial', machineId: 'machine-1',
    providerSettings: settingsWith([value]), registry: registry({ ...contribution(), definition }), dnsEvidenceByEndpointUrl: publicDns });
  const result = resolve();
  expect(result).toMatchObject({ status: 'resolved', record: { scope: 'machine', endpoints: [{ endpointTemplateId: 'responses',
    normalizedUrl: 'https://gateway.example/v1', publicHeaders: { 'x-policy': 'account', 'x-mode': 'machine' } }] } });
  expect(resolve({ ...configured, endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://gateway.example/wrong-family' }] }))
    .toMatchObject({ status: 'endpoint_unresolved', reason: 'endpoint_invalid' });
});

it.each([
  ['happier.provider.deepseek', DEEPSEEK_PROVIDER_CONTRIBUTION],
  ['happier.provider.openrouter', OPENROUTER_PROVIDER_CONTRIBUTION],
  ['happier.provider.vercel-ai-gateway', VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION],
] as const)('resolves a freshly authored %s connection with its Account grant through the same registry owner', async (pluginId, authored) => {
  const definition = ProviderContributionV1Schema.parse(authored);
  const key = `${pluginId}/${definition.id}`;
  const declared: ResolvedProviderContribution = { provenance: 'first_party', source: { kind: 'bundled' },
    pluginId, identity: { pluginId, localId: definition.id }, definition };
  let catalog = splitProviderSettingsV1(settingsWith([])).catalog;
  const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
    readCatalog: async () => ({ status: 'ready', revision: 1, catalog }),
    readDefinitions: async () => [{ contributionKey: key, definition, provenance: 'first_party' }],
    writeCatalog: async value => { catalog = value.catalog; return { status: 'updated' }; },
  });
  expect(await execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
    action: 'createContribution', connectionId: 'pc_new_contribution', contributionKey: key,
    displayName: null, savedSecretId: null, enable: true,
  }), { surface: 'cli' })).toMatchObject({ ok: true, result: { created: true } });
  const resolution = resolveProviderConnectionForMachine({ connectionId: 'pc_new_contribution', machineId: 'machine-1',
    providerSettings: composeProviderSettingsV1(catalog, {}),
    registry: { providersByContributionKey: new Map([[key, declared]]) },
    dnsEvidenceByEndpointUrl: new Map(definition.endpointTemplates.flatMap(endpoint =>
      endpoint.baseUrl ? [[endpoint.baseUrl, ['1.1.1.1']] as const] : [])),
  });
  expect(resolution).toMatchObject({ status: 'resolved', record: { connectionId: 'pc_new_contribution',
    connection: { id: 'pc_new_contribution' },
    source: { kind: 'contribution', contributionKey: key, pluginId }, authorization: { authorized: true } } });
});

it('admits the exact Account grant fingerprint for canonical URLs and all declared endpoint effects', async () => {
  const base = contribution('https://GATEWAY.EXAMPLE.:443/v1');
  const declared: ResolvedProviderContribution = { ...base, definition: ProviderContributionV1Schema.parse({
    ...base.definition,
    kind: 'local',
    credential: { ...base.definition.credential, transports: [{ id: 'bearer', protocols: ['openai-responses'],
      uses: ['runtime', 'management'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses',
      path: '/models', parser: 'gateway-models', reportsModelLoadState: true }] },
    discovery: { v: 1, listener: { executableBasenames: ['gateway'], defaultPorts: [] },
      availabilityProbe: { endpointTemplateId: 'responses', path: '/available', parser: 'openai-models' },
      catalogFallback: { endpointTemplateId: 'responses', lookupNames: ['gateway'], fixedArgs: ['models'], parser: 'gateway-models' } },
    modelLoad: { endpointTemplateId: 'responses', path: '/load', request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory' },
  }) };
  let catalog = splitProviderSettingsV1(settingsWith([connection('pc_grant')])).catalog;
  const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
    readCatalog: async () => ({ status: 'ready', revision: 4, catalog }),
    readDefinitions: async () => [{ contributionKey, definition: declared.definition, provenance: declared.provenance }],
    writeCatalog: async value => { catalog = value.catalog; return { status: 'updated' }; },
  });
  expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
    action: 'setEnabled', connectionId: 'pc_grant', scope: 'account', enabled: true,
  }), { surface: 'cli' })).toMatchObject({ ok: true });
  const resolved = resolveProviderConnectionForMachine({ connectionId: 'pc_grant', machineId: 'machine-1',
    providerSettings: composeProviderSettingsV1(catalog, {}), registry: registry(declared), dnsEvidenceByEndpointUrl: publicDns });
  expect(resolved.status).toBe('resolved');
  if (resolved.status !== 'resolved') return;
  expect(resolved.record.connectionSecurityFingerprint).toBe(catalog.accountGrants[0]?.connectionSecurityFingerprint);
  expect(resolved.record.authorization).toMatchObject({ authorized: true });
});

it('copies a contributed static source as a host-supported custom template without executable claims', async () => {
  const declared = ProviderContributionV1Schema.parse({ ...providerDefinition(),
    catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'published-model', name: 'Published model' }] } });
  let catalog = splitProviderSettingsV1(settingsWith([connection('pc_original')])).catalog;
  const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
    readCatalog: async () => ({ status: 'ready', revision: 4, catalog }),
    readDefinitions: async () => [{ contributionKey, definition: declared, provenance: 'external' }],
    writeCatalog: async value => { catalog = value.catalog; return { status: 'updated' }; },
  });
  expect(await execute(parseProviderActionRequestV1('providers.connections.duplicate', {
    action: 'duplicate', connectionId: 'pc_original', newConnectionId: 'pc_custom', displayName: 'My copy', mode: 'asCustom',
  }), { surface: 'cli' })).toMatchObject({ ok: true });
  expect(catalog.connections.find(value => value.id === 'pc_custom')?.source).toMatchObject({ kind: 'custom', template: {
    name: 'My copy', catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    endpointTemplates: [{ capabilities: { streaming: 'unknown' } }],
  } });
});

describe('machine-aware provider connection resolver', () => {
  it('resolves managed deployment as machine-scoped logical authority with an empty endpoint set', () => {
    const configured = connection('pc_managed', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const baseSettings = settingsWith([configured]);
    const first = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: baseSettings,
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (first.status !== 'resolved') throw new Error('Expected managed connection to resolve');

    expect(first.record).toMatchObject({
      deployment: {
        kind: 'managedLocal',
        implementationIdentity: {
          pluginId: 'acme.gateway',
          localId: 'gateway',
        },
        purposeBindingIntents: {
          v: 1,
          bindings: [{
            purpose: {
              consumer: {
                pluginId: 'acme.gateway',
                localId: 'gateway',
              },
              purpose: 'upstream',
            },
            target: {
              kind: 'account',
              account: {
                service: {
                  pluginId: 'happier.connected-account.example',
                  localId: 'example',
                },
                accountId: 'account-a',
              },
            },
          }],
        },
      },
      endpoints: [],
      scope: 'machine',
      authorization: {
        authorized: false,
        errorCode: 'provider_not_enabled_on_machine',
      },
    });
    expect(first.record.endpointSetFingerprint).toBe(
      createProviderEndpointSetFingerprintV2({ endpoints: [] }),
    );

    const grantedSettings = settingsWith([configured], {
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId: configured.id,
        connectionSecurityFingerprint: first.record.connectionSecurityFingerprint,
        endpointSetFingerprint: first.record.endpointSetFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: grantedSettings,
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'resolved',
      record: {
        endpoints: [],
        authorization: { authorized: true, grantKind: 'machine' },
      },
    });

    const changedContribution = managedContribution('gateway-managed-v2');
    const changed = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: grantedSettings,
      registry: registry({
        ...changedContribution,
        definition: ProviderContributionV1Schema.parse({
          ...changedContribution.definition,
          managedRuntime: {
            ...changedContribution.definition.managedRuntime,
            dependencies: ['gateway-managed-v2'],
          },
        }),
      }),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(changed).toMatchObject({
      status: 'resolved',
      record: {
        authorization: {
          authorized: true,
          grantKind: 'machine',
        },
      },
    });
    if (changed.status !== 'resolved') throw new Error('Expected changed managed connection to resolve');
    expect(changed.record.connectionSecurityFingerprint).toBe(
      first.record.connectionSecurityFingerprint,
    );

    const defaultsEdited = {
      ...configured,
      revision: configured.revision + 1,
      updatedAt: configured.updatedAt + 1,
      purposeBindingDefaults: {
        upstream: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-b',
          },
        },
      },
    };
    const futureDefaultEdit = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([defaultsEdited], {
        machineGrants: grantedSettings.machineGrants,
      }),
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(futureDefaultEdit).toMatchObject({
      status: 'resolved',
      record: {
        authorization: { authorized: true },
        deployment: {
          kind: 'managedLocal',
          purposeBindingIntents: {
            bindings: [{
              target: {
                kind: 'account',
                account: { accountId: 'account-b' },
              },
            }],
          },
        },
      },
    });
    if (futureDefaultEdit.status !== 'resolved') throw new Error('Expected edited defaults to resolve');
    expect(futureDefaultEdit.record.connectionSecurityFingerprint).toBe(
      first.record.connectionSecurityFingerprint,
    );
  });

  it('stales a managed machine grant when the declared endpoint public headers change', () => {
    const configured = connection('pc_managed_headers', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const withHeaders = (headers: Readonly<Record<string, string>>): ResolvedProviderContribution => {
      const base = managedContribution();
      return {
        ...base,
        definition: ProviderContributionV1Schema.parse({
          ...base.definition,
          endpointTemplates: base.definition.endpointTemplates.map((template) => ({
            ...template,
            publicHeaders: headers,
          })),
        }),
      };
    };
    const first = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(withHeaders({ 'X-Route': 'one' })),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (first.status !== 'resolved') throw new Error('Expected managed connection to resolve');
    const grantedSettings = settingsWith([configured], {
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId: configured.id,
        connectionSecurityFingerprint: first.record.connectionSecurityFingerprint,
        endpointSetFingerprint: first.record.endpointSetFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: grantedSettings,
      registry: registry(withHeaders({ 'X-Route': 'one' })),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: true, grantKind: 'machine' } },
    });

    const changed = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: grantedSettings,
      registry: registry(withHeaders({ 'X-Route': 'two' })),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (changed.status !== 'resolved') throw new Error('Expected changed managed connection to resolve');
    expect(changed.record.connectionSecurityFingerprint).not.toBe(
      first.record.connectionSecurityFingerprint,
    );
    expect(changed.record.authorization).toMatchObject({
      authorized: false,
      errorCode: 'provider_machine_grant_stale',
    });
  });

  it('resolves one public managed declaration across bundled, development, and installed provenance', () => {
    const configured = connection('pc_managed_invalid', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const input = {
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      dnsEvidenceByEndpointUrl: new Map(),
    } as const;

    expect(resolveProviderConnectionForMachine({
      ...input,
      registry: registry(contribution()),
    })).toMatchObject({
      status: 'invalid',
      reason: 'managed_deployment_unavailable',
    });
    for (const candidate of [
      managedContribution(),
      externalManagedContribution('path'),
      externalManagedContribution('package'),
    ]) {
      const resolution = resolveProviderConnectionForMachine({
        ...input,
        registry: registry(candidate),
      });
      expect(resolution).toMatchObject({
        status: 'resolved',
        record: {
          source: { provenance: candidate.provenance },
          deployment: {
            kind: 'managedLocal',
            managedRuntime: {
              kind: 'managed',
              endpointTemplateIds: ['responses'],
            },
          },
        },
      });
      if (resolution.status !== 'resolved') {
        throw new Error('Expected public managed declaration to resolve');
      }
      expect(resolution.record.deployment).not.toHaveProperty('facet');
    }
  });

  it('keeps an optional managed purpose unbound unless the producer explicitly requires one binding', () => {
    const configured = connection('pc_managed_optional_unbound', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {},
    });
    const input = {
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      dnsEvidenceByEndpointUrl: new Map(),
    } as const;

    expect(resolveProviderConnectionForMachine({
      ...input,
      registry: registry(managedContribution('gateway-managed', { required: false })),
    })).toMatchObject({ status: 'resolved' });
    expect(resolveProviderConnectionForMachine({
      ...input,
      registry: registry(managedContribution('gateway-managed', {
        required: false,
        minimumBound: 1,
      })),
    })).toMatchObject({
      status: 'invalid',
      reason: 'managed_purpose_bindings_missing',
    });
  });

  it('rejects managed purpose defaults outside the declared facet purpose and service', () => {
    const defaults = {
      upstream: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.connected-account.other',
            localId: 'other',
          },
          accountId: 'account-a',
        },
      },
    };
    const configured = connection('pc_managed_purpose_invalid', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: defaults,
    });

    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'invalid',
      reason: 'managed_purpose_bindings_invalid',
    });
  });

  it('uses account authorization on the public machine view and an exact machine grant for an override', () => {
    const configured = connection('pc_mixed', {
      endpointOverridesByMachineId: {
        'machine-b': [{ endpointTemplateId: 'responses', baseUrl: 'http://localhost:4242/v1' }],
      },
    });
    const baseSettings = settingsWith([configured]);
    const machineA = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: baseSettings,
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    });
    const machineB = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      providerSettings: baseSettings,
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1', '::1']]]),
    });
    if (machineA.status !== 'resolved' || machineB.status !== 'resolved') throw new Error('Expected both machine views');
    expect(machineA.record).toMatchObject({ scope: 'account', endpoints: [{ source: 'contribution' }] });
    expect(machineB.record).toMatchObject({
      scope: 'machine',
      endpoints: [{ source: 'machine_override', locality: 'loopback' }],
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
    });

    const grants = settingsWith([configured], {
      accountGrants: [{
        v: 1,
        connectionId: configured.id,
        connectionSecurityFingerprint: machineA.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
      machineGrants: [{
        v: 1,
        machineId: 'machine-b',
        connectionId: configured.id,
        endpointSetFingerprint: machineB.record.endpointSetFingerprint,
        connectionSecurityFingerprint: machineB.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: grants,
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'account' } } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      providerSettings: grants,
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1', '::1']]]),
    })).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      providerSettings: grants,
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: true, grantKind: 'machine' } },
    });
  });

  it('uses account overrides before contribution defaults without turning a public account view into machine scope', () => {
    const configured = connection('pc_account_override', {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override.example/v1' }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([
        ['https://gateway.example/v1', ['1.1.1.1']],
        ['https://override.example/v1', ['8.8.4.4']],
      ]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'account',
        endpoints: [{ source: 'account_override', normalizedUrl: 'https://override.example/v1' }],
      },
    });
  });

  it('does not reuse an opaque legacy account grant after an actual endpoint override edit', () => {
    const configured = connection('pc_account_reauthorization', {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override.example/v1' }],
    });
    const initial = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://override.example/v1', ['8.8.4.4']]]),
    });
    if (initial.status !== 'resolved') throw new Error('Expected initial public resolution');
    const accountGrant = {
      v: 1 as const,
      connectionId: configured.id,
      connectionSecurityFingerprint: createProviderConnectionSecurityFingerprintV1({ securityContractVersion: 1,
        endpoints: [{ endpointTemplateId: 'responses', protocol: 'openai-responses', url: 'https://override.example/v1',
          publicHeaders: { 'X-Provider-Client': 'happier' } }],
        catalogProbes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
        credentialTransports: providerDefinition().credential?.transports ?? [] }),
      confirmedAt: 2,
    };

    const edited = connection(configured.id, {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override-v2.example/v1' }],
      revision: 1,
      updatedAt: 2,
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: edited.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([edited], { accountGrants: [accountGrant] }),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://override-v2.example/v1', ['8.8.8.8']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: false, errorCode: 'provider_account_grant_stale' } },
    });

  });

  it('uses the explicitly selected declared local URL candidate when no override exists', () => {
    const configured = connection('pc_local');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(localContribution()),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4545/v1', ['127.0.0.1']]]),
      localCandidateUrlsByConnectionId: new Map([
        [configured.id, new Map([['responses', 'http://localhost:4545/v1']])],
      ]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        displayName: 'Local Gateway',
        scope: 'machine',
        endpoints: [{
          source: 'contribution_local_candidate',
          normalizedUrl: 'http://localhost:4545/v1',
        }],
      },
    });
  });

  it('scopes same-template local endpoint candidates by exact connection identity', () => {
    const secondContributionKey = 'acme.second-local/gateway';
    const first = connection('pc_local_first');
    const second = connection('pc_local_second', {
      source: { kind: 'contribution', contributionKey: secondContributionKey },
    });
    const secondLocalContribution: ResolvedProviderContribution = {
      ...localContribution(),
      pluginId: 'acme.second-local',
      identity: { pluginId: 'acme.second-local', localId: 'gateway' },
      definition: ProviderContributionV1Schema.parse({
        ...localContribution().definition,
        endpointTemplates: [{
          ...localContribution().definition.endpointTemplates[0],
          localUrlCandidates: ['http://localhost:5656/v1', 'http://127.0.0.1:5656/v1'],
        }],
      }),
    };
    const sharedInput = {
      machineId: 'machine-a',
      providerSettings: settingsWith([second, first]),
      registry: {
        providersByContributionKey: new Map([
          [canonicalContributionKey, localContribution()],
          ['acme.second-local/gateway', secondLocalContribution],
        ]),
      },
      dnsEvidenceByEndpointUrl: new Map([
        ['http://localhost:4545/v1', ['127.0.0.1']],
        ['http://localhost:5656/v1', ['127.0.0.1']],
      ]),
      localCandidateUrlsByConnectionId: new Map([
        [first.id, new Map([['responses', 'http://localhost:4545/v1']])],
        [second.id, new Map([['responses', 'http://localhost:5656/v1']])],
      ]),
    };

    expect(resolveProviderConnectionForMachine({
      ...sharedInput,
      connectionId: first.id,
    })).toMatchObject({
      status: 'resolved',
      connectionId: first.id,
      record: { endpoints: [{ normalizedUrl: 'http://localhost:4545/v1' }] },
    });
    expect(resolveProviderConnectionForMachine({
      ...sharedInput,
      connectionId: second.id,
    })).toMatchObject({
      status: 'resolved',
      connectionId: second.id,
      record: { endpoints: [{ normalizedUrl: 'http://localhost:5656/v1' }] },
    });
  });

  it('does not hide a multi-candidate local endpoint choice behind contribution array order', () => {
    const configured = connection('pc_local_choice');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(localContribution()),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4545/v1', ['127.0.0.1']]]),
    })).toMatchObject({ status: 'endpoint_unresolved', reason: 'local_candidate_required' });
  });

  it('requires a machine grant for a machine override even when that override resolves publicly', () => {
    const configured = connection('pc_public_machine_override', {
      endpointOverridesByMachineId: {
        'machine-a': [{ endpointTemplateId: 'responses', baseUrl: 'https://machine.example/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://machine.example/v1', ['1.1.1.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'machine',
        endpoints: [{ source: 'machine_override', endpointScope: 'account' }],
        authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
      },
    });
  });

  it('distinguishes missing, deleted, and contribution-unavailable connections without reinterpretation', () => {
    const configured = connection('pc_missing_plugin');
    const providerSettings = settingsWith([configured], {
        connectionTombstones: [{
          v: 1,
          id: 'pc_deleted' as ProviderSettingsV1['connectionTombstones'][number]['id'],
          contributionKey,
          lastDisplayName: 'Old Gateway',
          deletedAt: 9,
        }],
      });
    const emptyRegistry: ProviderContributionRegistryView = { providersByContributionKey: new Map() };
    expect(resolveProviderConnectionForMachine({
      connectionId: 'pc_unknown', machineId: 'machine-a', providerSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toEqual({ status: 'missing', connectionId: 'pc_unknown', diagnostics: [] });
    expect(resolveProviderConnectionForMachine({
      connectionId: 'pc_deleted', machineId: 'machine-a', providerSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({ status: 'deleted', connectionId: 'pc_deleted', tombstone: { lastDisplayName: 'Old Gateway' } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id, machineId: 'machine-a', providerSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'source_unavailable',
      connectionId: configured.id,
      contributionKey: canonicalContributionKey,
      connection: { source: { kind: 'contribution' } },
    });
  });

  it('normalizes a custom connection into the same non-secret resolved record', () => {
    const custom = connection('pc_custom', {
      role: 'named',
      displayName: 'Company Gateway',
      displayNameMode: 'custom',
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'Company Gateway',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat',
            baseUrl: 'https://company.example/v1',
            capabilities: {
              streaming: 'unknown', toolRoundTrips: 'unknown',
              statefulResponses: 'unknown', reasoningControls: 'unknown',
            },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
      },
    });
    const result = resolveProviderConnectionForMachine({
      connectionId: custom.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([custom], {
        secretBindingsByConnectionId: {
          [custom.id]: { account: { apiKey: 'secret-binding-canary' } },
        },
      }),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://company.example/v1', ['9.9.9.9']]]),
    });
    expect(result).toMatchObject({
      status: 'resolved',
      record: {
        source: { kind: 'custom' },
        displayName: 'Company Gateway',
        endpoints: [{ endpointTemplateId: 'chat', protocol: 'openai-chat' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-binding-canary');
  });

  it('rejects unknown override ids and resolves configured public URLs without daemon DNS', () => {
    const invalidOverride = connection('pc_invalid_override', {
      endpointOverrides: [{ endpointTemplateId: 'unknown', baseUrl: 'https://other.example/v1' }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: invalidOverride.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([invalidOverride]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://other.example/v1', ['1.0.0.1']]]),
    })).toMatchObject({ status: 'invalid', reason: 'unknown_endpoint_override' });

    const configured = connection('pc_dns');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([configured]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({ status: 'resolved', record: { scope: 'account', endpoints: [{
      normalizedUrl: 'https://gateway.example/v1', locality: 'public', resolvedAddresses: [],
    }] } });
  });

  it.each([
    ['http://localhost:11434/v1', 'loopback'],
    ['http://127.0.0.1:11434/v1', 'loopback'],
    ['https://192.168.1.20/v1', 'private'],
  ])('keeps configured local URL %s Machine-scoped without DNS', (url, locality) => {
    const configured = connection('pc_local');
    expect(resolveProviderConnectionForMachine({ connectionId: configured.id, machineId: 'machine-a',
      providerSettings: settingsWith([configured]), registry: registry(contribution(url)), dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({ status: 'resolved', record: { scope: 'machine', endpoints: [{ locality }],
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
    } });
  });

  it('rejects a contribution override for an unknown endpoint even when it belongs to another machine branch', () => {
    const invalidOtherMachine = connection('pc_invalid_other_machine', {
      endpointOverridesByMachineId: {
        'machine-b': [{ endpointTemplateId: 'unknown', baseUrl: 'https://other.example/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: invalidOtherMachine.id,
      machineId: 'machine-a',
      providerSettings: settingsWith([invalidOtherMachine]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({ status: 'invalid', reason: 'unknown_endpoint_override' });
  });

  it('rejects poison connection identifiers before registry lookup', () => {
    const result = resolveProviderConnectionForMachine({
      connectionId: '__proto__',
      machineId: 'machine-a',
      providerSettings: settingsWith([]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_connection_id' });
  });

  it('uses own-property lookup for legal machine ids that overlap Object.prototype names', () => {
    const configured = connection('pc_own_machine_key', {
      endpointOverridesByMachineId: {
        toString: [{ endpointTemplateId: 'responses', baseUrl: 'http://localhost:4343/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'toString',
      providerSettings: settingsWith([configured]),
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4343/v1', ['127.0.0.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { scope: 'machine', endpoints: [{ source: 'machine_override' }] },
    });
  });
});
