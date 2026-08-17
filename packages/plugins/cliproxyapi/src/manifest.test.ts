import { describe, expect, it } from 'vitest';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('CLIProxyAPI plugin manifest', () => {
  it('is a declarative first-party Provider plugin with no runtime permissions', async () => {
    await expect(import('./manifest.js').then((module) =>
      PluginManifestV2Schema.parse(module.PLUGIN_MANIFEST))).resolves.toMatchObject({
      id: 'happier.provider.cliproxyapi',
      runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: { providers: [{ id: 'cliproxyapi', kind: 'aggregator' }] },
    });
  });

  it('uses only the strict data-only root and survives bundled or installed ingestion', () => {
    expect(Object.keys(PLUGIN_MANIFEST).sort()).toEqual([
      'contributes', 'description', 'displayName', 'engines', 'entrypoints', 'hostAccess', 'id', 'runtime', 'schemaVersion', 'version',
    ]);
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toEqual(
      ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST)),
    );
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST).ok).toBe(true);
  });

  it('declares the public managed Provider facet and requires its conditional runtime registration', () => {
    expect(PLUGIN_MANIFEST.entrypoints).toEqual({ daemon: './dist/index.js' });
    const providerFamily = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers');
    expect(providerFamily).toMatchObject({
      identityKind: 'delegatedDomain',
      stability: 'delegated',
      disposition: 'delegated',
      activationDemand: 'conditional',
      allowedRuntimeRegistration: 'providers',
    });
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      managedRuntime: {
        kind: 'managed',
        connectedAccounts: [{
          purpose: 'openai-upstream',
          title: 'Use OpenAI upstream account',
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: false,
          materializationKinds: ['httpHeaders'],
        }, {
          purpose: 'anthropic-upstream',
          title: 'Use Anthropic upstream account',
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          required: false,
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'openai-upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization', 'chatgpt-account-id'],
          },
        }, {
          purpose: 'anthropic-upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }],
        endpointTemplateIds: [
          'cliproxyapi-openai-responses',
          'cliproxyapi-openai-chat',
          'cliproxyapi-anthropic',
        ],
      },
    });
    expect(providerFamily?.projectIntrospection(PLUGIN_MANIFEST.contributes.providers[0])).toMatchObject({
      localId: null,
      stability: 'delegated',
      registration: 'required',
    });
  });
});
