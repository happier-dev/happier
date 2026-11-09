import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { PLUGIN_MANIFEST, activate } from './manifest.js';
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION as declaration } from './provider/contribution.js';

describe('Cloudflare Messages pass-through contribution', () => {
  it('admits two independent secret transports with constrained endpoint and public request policy', () => {
    const provider = ProviderContributionV1Schema.parse(declaration);
    expect(provider.endpointTemplates[0]).toMatchObject({ requiresEndpointOverride: true,
      addressConstraint: declaration.endpointTemplates[0]!.addressConstraint,
      modelIdPattern: declaration.endpointTemplates[0]!.modelIdPattern,
      publicHeaders: declaration.endpointTemplates[0]!.publicHeaders });
    expect(provider.credential?.transports.find(row => row.protocols.includes('anthropic'))).toMatchObject({ destination: {
      kind: 'httpHeader', name: 'cf-aig-authorization', format: 'bearer',
    }, additionalCredentials: [{ slotId: 'anthropicApiKey', destination: {
      kind: 'httpHeader', name: 'x-api-key', format: 'raw',
    } }] });
    expect(provider.catalog).toMatchObject({ source: 'manual', manualModelPolicy: 'allowed' });
    expect(provider.catalog.probes ?? []).toHaveLength(0);
    expect(provider.usageSources ?? []).toHaveLength(0);
  });

  it('admits the real Provider and retains both credential references and public policy through Account Actions and reload', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      // A manual descriptor has no catalog/runtime callbacks to register. Its
      // admitted manifest declaration is what the ordinary Account catalog reads.
      const provider = ProviderContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.providers[0]);
      let catalog: ProviderConnectionsCatalogV1 = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
      // The persistent Account-row boundary is in memory; admission, declarations,
      // mutations and read projections are the real owners.
      const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
        readCatalog: async () => ({ status: 'ready', revision: 1, catalog }),
        writeCatalog: async input => { catalog = input.catalog; return { status: 'updated' }; },
        readDefinitions: async () => [{ contributionKey: `${PLUGIN_MANIFEST.id}/${provider.id}`,
          definition: provider, provenance: 'first_party' }],
      });
      const connectionId = 'pc_cloudflare_journey';
      expect(await execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
        action: 'createContribution', connectionId, contributionKey: `${PLUGIN_MANIFEST.id}/${provider.id}`,
        displayName: null, savedSecretId: null, enable: false,
      }), {})).toMatchObject({ ok: true });
      for (const [credentialSlotId, savedSecretId] of [
        ['apiKey', 'ss_cloudflare_gateway'], ['anthropicApiKey', 'ss_anthropic_upstream'],
      ]) {
        expect(await execute(parseProviderActionRequestV1('providers.connections.secrets.bind', {
          action: 'bindSecret', connectionId, credentialSlotId, savedSecretId, scope: 'account',
        }), {})).toMatchObject({ ok: true });
      }
      expect(catalog.secretBindingsByConnectionId[connectionId]?.account).toMatchObject({
        apiKey: 'ss_cloudflare_gateway', anthropicApiKey: 'ss_anthropic_upstream',
      });
      const baseUrl = 'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic';
      const patch = (fields: { baseUrl?: string | null; publicHeaders?: Record<string, string> | null }) => execute(
        parseProviderActionRequestV1('providers.connections.endpoint.set', {
          action: 'setEndpointOverride', connectionId, expectedRevision: catalog.connections[0]!.revision,
          endpointTemplateId: 'cloudflare-anthropic', scope: 'account', ...fields,
        }), {},
      );
      expect(await patch({ baseUrl })).toMatchObject({ ok: true });
      expect(await patch({ publicHeaders: { 'cf-aig-collect-log': 'true' } })).toMatchObject({ ok: true });
      catalog = ProviderConnectionsCatalogV1Schema.parse(JSON.parse(JSON.stringify(catalog)));
      const described = await execute(parseProviderActionRequestV1('providers.connections.describe', { connectionId }), {});
      expect(described).toMatchObject({ ok: true, result: { connections: [{ probeCapability: 'none', endpoints: expect.arrayContaining([expect.objectContaining({
        baseUrl, publicHeaders: { 'cf-aig-collect-log': 'true', 'cf-aig-no-wholesale': 'true', 'cf-aig-skip-cache': 'true' },
        publicHeaderSources: expect.objectContaining({ 'cf-aig-collect-log': 'accountOverride' }),
      })]) }] } });
      expect(await patch({ publicHeaders: null })).toMatchObject({ ok: true });
      expect(await execute(parseProviderActionRequestV1('providers.connections.describe', { connectionId }), {}))
        .toMatchObject({ ok: true, result: { connections: [{ endpoints: expect.arrayContaining([expect.objectContaining({ baseUrl,
          publicHeaders: declaration.endpointTemplates[0]!.publicHeaders,
          publicHeaderSources: expect.objectContaining({ 'cf-aig-collect-log': 'template' }),
        })]) }] } });
      const before = JSON.stringify(catalog);
      expect(await patch({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' }))
        .toMatchObject({ ok: false });
      expect(JSON.stringify(catalog)).toBe(before);
    } finally { await kit.dispose(); }
  });
});
