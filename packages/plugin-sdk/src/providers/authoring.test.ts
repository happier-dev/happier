import { describe, expect, it } from 'vitest';

import type { PluginManifest } from '../manifest.js';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveProviderModelPickerVisibility } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import {
  ProviderContributionV1Schema,
  type ProviderConnectionMutationRequest,
  type ProviderContribution,
} from './index.js';

describe('Provider authoring through the public manifest SDK', () => {
  it('admits an external gateway declaration and its Account configuration through existing public contracts', async () => {
    const provider = ProviderContributionV1Schema.parse({
      v: 1, id: 'gateway', name: 'Acme Gateway', kind: 'aggregator',
      endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      managedRuntime: { kind: 'managed', sharing: 'connectionMachine', endpointTemplateIds: ['responses'],
        connectedAccounts: [{ purpose: 'upstream', service: { pluginId: 'acme.auth', localId: 'subscription' }, required: false }] },
    } satisfies ProviderContribution);
    const manifest = {
      schemaVersion: 2, id: 'acme.gateway', version: '0.1.0', displayName: 'Acme Gateway',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] },
      contributes: { providers: [provider] },
    } satisfies PluginManifest;
    let catalog: ProviderConnectionsCatalogV1 = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
    // Replace only the persistent Account-row transport; keep declaration admission and mutation semantics real.
    const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
      readCatalog: async () => ({ status: 'ready', revision: 1, catalog }),
      readDefinitions: async () => [{ contributionKey: `${manifest.id}/${provider.id}`,
        definition: manifest.contributes.providers[0]!, provenance: 'external' }],
      writeCatalog: async input => { catalog = input.catalog; return { status: 'updated' }; },
    });
    expect(await execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
      action: 'createContribution', connectionId: 'pc_acme', contributionKey: 'acme.gateway/gateway',
      displayName: 'Acme', savedSecretId: null, enable: false,
    }), {})).toMatchObject({ ok: true });
    const update = {
      action: 'update', connectionId: 'pc_acme', expectedRevision: 0,
      deployment: { kind: 'managedLocal', purposeBindingDefaults: {
        upstream: { kind: 'group', service: { pluginId: 'acme.auth', localId: 'subscription' }, groupId: 'acme-pool' },
      } },
      gatewayPlacement: { kind: 'machine', machineId: 'acme-hub' },
      claudeHelperModels: { fast: 'acme-fast', default: 'acme-main', strongest: 'acme-strong' },
    } satisfies ProviderConnectionMutationRequest;
    expect(await execute(parseProviderActionRequestV1('providers.connections.update', update), {}))
      .toMatchObject({ ok: true, result: { connection: { gatewayPlacement: update.gatewayPlacement, claudeHelperModels: update.claudeHelperModels } } });
    expect(catalog.connections[0]).toMatchObject({ source: { contributionKey: 'acme.gateway/gateway' },
      purposeBindingDefaults: update.deployment.purposeBindingDefaults, gatewayPlacement: update.gatewayPlacement, claudeHelperModels: update.claudeHelperModels });
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_acme', kind: provider.kind }).shown).toBe(false);
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_acme', kind: provider.kind,
      modelPickerVisibilityByConnectionId: { pc_acme: true } }).shown).toBe(true);
    expect(catalog.secretBindingsByConnectionId).toEqual({});
  });

  it('authors the same declarative contribution shape used by bundled Providers', () => {
    const provider = {
      v: 1,
      id: 'acme-models',
      name: 'Acme Models',
      kind: 'aggregator',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        required: true,
        transports: [{
          id: 'responses-auth',
          protocols: ['openai-responses'],
          uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        }],
      },
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    } satisfies ProviderContribution;

    const manifest = {
      schemaVersion: 2,
      id: 'example.experimental-provider',
      version: '0.1.0',
      displayName: 'Experimental Provider',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: { providers: [provider] },
    } satisfies PluginManifest;

    expect(manifest.contributes.providers).toEqual([provider]);
  });

  it('validates ordinary and managed Provider declarations through the public Provider entrypoint', () => {
    const ordinaryProvider = {
      v: 1,
      id: 'acme-models',
      name: 'Acme Models',
      kind: 'aggregator',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    } as const;

    expect(ProviderContributionV1Schema.parse(ordinaryProvider))
      .not.toHaveProperty('managedRuntime');
    expect(ProviderContributionV1Schema.parse({
      ...ordinaryProvider,
      managedRuntime: {
        kind: 'managed',
        connectedAccounts: [{
          purpose: 'provider.inference',
          service: 'openai',
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'provider.inference',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.openai.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
    })).toMatchObject({
      managedRuntime: {
        kind: 'managed',
        requestAuthUses: [{ purpose: 'provider.inference' }],
        endpointTemplateIds: ['responses'],
      },
    });
    expect(ProviderContributionV1Schema.safeParse({
      ...ordinaryProvider,
      managedRuntime: {
        kind: 'managed',
        connectedAccounts: [],
        requestAuthUses: [{
          purpose: 'provider.inference',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.openai.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: ['responses'],
      },
    }).success).toBe(false);
  });
});
