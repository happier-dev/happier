import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  encryptSecretStringV1,
  splitProviderSettingsV1,
} from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { DaemonProviderUsageRefreshRequestV1Schema } from '@happier-dev/protocol/rpc/providers';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as vercelGateway from '../../../../../packages/plugins/vercel-ai-gateway/src/manifest';

import { createProviderProbeHttpClient, type ProviderProbeTransportRequest } from './client';
import { createRuntimeProviderServices } from './runtimeServices';

const definition = ProviderContributionV1Schema.parse(vercelGateway.PLUGIN_MANIFEST.contributes.providers[0]);
const provider = { pluginId: vercelGateway.PLUGIN_MANIFEST.id, localId: definition.id };
const gatewayKey = buildQualifiedPluginContributionKey(provider);

function startGatewayFixture() {
  return createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{ manifest: vercelGateway.PLUGIN_MANIFEST,
      files: { '.happier-plugin-build/daemon.js': 'export function activate() {}' },
      instantiateCommittedModule: () => ({ activate: vercelGateway.activate }) }],
    coldStart: true,
    async resolveContributes(happyHomeDir) {
      return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
      }));
    },
  });
}

it('reads Vercel Gateway credits once with the saved API key and the activated plugin parser', async () => {
  const fixture = await startGatewayFixture();
  try {
    const gatewayRegistry = fixture.registry.declarationContributes;
    const identity = { connectionId: ProviderConnectionIdSchema.parse('pc_vercel'), machineId: 'machine-a' };
    const secretId = 'vercel-gateway-key';
    const key = 'fixture-gateway-api-key';
    const settingsKey = randomBytes(32);
    const base = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{ v: 1, id: identity.connectionId, source: { kind: 'contribution', contributionKey: gatewayKey },
        role: 'default', displayName: definition.name, displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
      secretBindingsByConnectionId: { [identity.connectionId]: { account: { apiKey: secretId }, byMachineId: {} } },
    });
    const resolveAddresses = async () => ['1.1.1.1'];
    const resolution = resolveProviderConnectionForMachine({ ...identity, providerSettings: base, registry: gatewayRegistry,
      dnsEvidenceByEndpointUrl: new Map(definition.endpointTemplates.map(endpoint => [endpoint.baseUrl, ['1.1.1.1']])),
    });
    if (resolution.status !== 'resolved') throw new Error('Expected the Gateway connection to resolve');
    const { catalog, defaults } = splitProviderSettingsV1(ProviderSettingsV1Schema.parse({ ...base, accountGrants: [{
      v: 1, connectionId: identity.connectionId, connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }] }));
    const snapshot = {
      source: 'cache' as const,
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [settingsKey],
      scopeKey: resolveAccountSettingsScopeKeyForToken('fixture-vercel-credits-account'),
      settings: AccountSettingsSchema.parse({
        providerDefaultModelSelectionsByAgentTargetKeyV1: defaults,
        secrets: [{
          id: secretId, name: 'Gateway API key', kind: 'apiKey', createdAt: 1, updatedAt: 1,
          encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1(key, settingsKey, randomBytes) },
        }],
      }),
    };
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
      status: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"balance":"-0.25","total_used":"1.75"}'),
    }));
    const services = createRuntimeProviderServices({ ...identity, happyHomeDir: fixture.happyHomeDir,
      registry: gatewayRegistry, getAccountSettingsSnapshot: () => snapshot,
      featureGate: { isEnabled: () => true }, resolveAddresses,
      client: createProviderProbeHttpClient({ resolveAddresses, transport }),
      resolveContributedUsageParsers: async identity => await fixture.registry.acquireProviderUsageParsers?.(identity) ?? null,
    });
    expect(transport).not.toHaveBeenCalled();
    const result = await services.refreshUsage(identity);
    const errors = result.status === 'error' ? [result.error.code]
      : result.status === 'success' ? result.sources.flatMap(source => source.status === 'error' ? [source.error.code] : []) : [];
    expect(errors).toEqual([]);
    expect(result).toMatchObject({ status: 'success', sources: [{
      sourceId: 'credits', status: 'ok', snapshot: { meters: [
        { meterId: 'balance', remaining: -0.25, unit: 'usd', currency: 'USD' },
        { meterId: 'spend-lifetime', used: 1.75, unit: 'usd', currency: 'USD' },
      ] },
    }] });
    expect(transport.mock.calls.map(([request]) => ({
      method: request.method, url: request.url, authorization: request.headers.authorization,
    }))).toEqual([{ method: 'GET', url: 'https://ai-gateway.vercel.sh/v1/credits', authorization: `Bearer ${key}` }]);
  } finally {
    await fixture.dispose();
  }
});

it('reads only the selected Vercel account usage through its finite request-auth subject', async () => {
  const fixture = await startGatewayFixture();
  const declared = definition.connectedAccounts![0]!;
  const purpose = { consumer: provider, purpose: declared.purpose };
  const account = { service: qualifyPluginContributionReferenceV1(declared.service, provider.pluginId), accountId: 'selected-account' };
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const bearer = 'fixture-gateway-signin-token';
  const teamId = 'team_fixture';
  const machineId = 'machine-a';
  const request = { machineId, connectedAccountSource: {
    purpose, account, endpointTemplateId: 'vercel-chat', usageSourceId: 'credits',
  } };
  for (const selector of [{ teamId }, { url: 'https://example.com' }, { target: { kind: 'group', groupId: 'pool' } }]) {
    expect(DaemonProviderUsageRefreshRequestV1Schema.safeParse({ ...request,
      connectedAccountSource: { ...request.connectedAccountSource, ...selector } }).success).toBe(false);
  }
  const denied = async (): Promise<never> => { throw new Error('Unexpected credential operation'); };
  const materialize = vi.fn<Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['materializeAccount']>(async ({
    account: selected, credentialRevisionBasis,
  }) => {
    expect(selected).toEqual(account);
    credentialRevisionBasis?.captureCredentialRevision(revision);
    return { kind: 'httpHeaders' as const,
      headers: { authorization: `Bearer ${bearer}`, 'x-vercel-ai-gateway-team': teamId },
      facts: { teamId }, expiresAt: Date.now() + 60_000 };
  });
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: denied, subscribe: () => ({ dispose() {} }) },
    selectTarget: denied, projectTargetAccounts: denied, assertTargetAccountMaterializable: denied,
    resolveTarget: async target => target.kind === 'account' && target.account.accountId === account.accountId
      ? { account, displayName: 'Selected Vercel account' } : null,
    resolveCredentialRevision: async () => revision,
    materializeAccount: materialize,
  });
  const requireAuthority = (subject: Parameters<ReturnType<typeof createConnectedAccountRequestAuthService>['lookupRequestAuth']>[0]['subject']) => {
    if (!subject.bindingAuthority) throw new Error('Missing finite usage binding');
    return subject.bindingAuthority;
  };
  const requestAuth = createConnectedAccountRequestAuthService({
    resolveCurrentBinding: input => requireAuthority(input.subject).resolveCurrentBinding(input),
    materializeHeaders: input => requireAuthority(input.subject).materializeHeaders(input),
    refreshAfterAuthFailure: denied, reportQuotaFailure: denied,
  });
  const lookupRequestAuth = vi.fn(requestAuth.lookupRequestAuth);
  const transport = vi.fn(async (_request: ProviderProbeTransportRequest): Promise<{
    status: number; headers: Record<string, string>; body: Buffer;
  }> => ({
    status: 200, headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"balance":"2.25","total_used":"1.75"}'),
  }));
  const resolveAddresses = async () => ['1.1.1.1'];
  try {
    const services = createRuntimeProviderServices({ machineId, happyHomeDir: fixture.happyHomeDir,
      registry: fixture.registry.declarationContributes, featureGate: { isEnabled: () => true },
      resolveAddresses, client: createProviderProbeHttpClient({ resolveAddresses, transport }),
      connectedAccountUsage: { resolveSelection: owner.resolveBindingIntentSelection,
        activatePurposeBindings: owner.activatePurposeBindings, lookupRequestAuth },
      resolveContributedUsageParsers: async identity => await fixture.registry.acquireProviderUsageParsers?.(identity) ?? null,
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(services.refreshUsage({ ...request, machineId: 'wrong-machine' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_not_enabled_on_machine' } });
    for (const source of [{ ...request.connectedAccountSource, endpointTemplateId: 'vercel-responses' },
      { ...request.connectedAccountSource, purpose: { ...purpose, purpose: 'different-purpose' } },
      { ...request.connectedAccountSource, account: { ...account, accountId: 'unavailable-account' } }]) {
      await expect(services.refreshUsage({ machineId, connectedAccountSource: source })).resolves.toMatchObject({ status: 'error' });
    }
    expect(lookupRequestAuth).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    for (let refreshes = 1; refreshes <= 2; refreshes++) {
      await expect(services.refreshUsage(request)).resolves.toMatchObject({ status: 'success', sources: [{
        sourceId: 'credits', status: 'ok', snapshot: { meters: [
          { meterId: 'balance', remaining: 2.25, unit: 'usd', currency: 'USD' },
          { meterId: 'spend-lifetime', used: 1.75, unit: 'usd', currency: 'USD' },
        ] },
      }] });
      expect(lookupRequestAuth).toHaveBeenCalledTimes(refreshes);
      expect(transport).toHaveBeenCalledTimes(refreshes);
    }
    expect(materialize).toHaveBeenCalledTimes(1);
    for (const [outbound] of transport.mock.calls) {
      expect(outbound).toMatchObject({ method: 'GET', url: 'https://ai-gateway.vercel.sh/v1/credits?teamId=team_fixture',
        headers: { authorization: `Bearer ${bearer}` } });
      expect(outbound.headers).not.toHaveProperty('x-vercel-ai-gateway-team');
    }
    transport.mockResolvedValueOnce({ status: 302, headers: {
      location: 'https://ai-gateway.vercel.sh/v1/credits?teamId=other-team',
    }, body: Buffer.alloc(0) });
    await expect(services.refreshUsage(request)).resolves.toMatchObject({ status: 'success',
      sources: [{ sourceId: 'credits', status: 'error' }] });
    expect(lookupRequestAuth).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(lookupRequestAuth.mock.calls.every(([input]) => !input.subject.isCurrent())).toBe(true);
  } finally {
    await fixture.dispose();
  }
});
