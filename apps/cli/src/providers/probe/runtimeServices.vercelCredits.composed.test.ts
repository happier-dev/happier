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
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as vercelGateway from '../../../../../packages/plugins/vercel-ai-gateway/src/manifest';

import { createProviderProbeHttpClient, type ProviderProbeTransportRequest } from './client';
import { createRuntimeProviderServices } from './runtimeServices';

it('reads Vercel Gateway credits once with the saved API key and the activated plugin parser', async () => {
  const pluginId = vercelGateway.PLUGIN_MANIFEST.id;
  const definition = ProviderContributionV1Schema.parse(vercelGateway.PLUGIN_MANIFEST.contributes.providers[0]);
  const gatewayKey = buildQualifiedPluginContributionKey({ pluginId, localId: definition.id });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
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
