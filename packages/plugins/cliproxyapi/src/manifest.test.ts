import { describe, expect, it } from 'vitest';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';
import { CLIPROXYAPI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

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

  it('ships the managed-purpose presentation in every supported plugin locale', () => {
    expect(CLIPROXYAPI_UI_TRANSLATION_BUNDLES.map((bundle) => bundle.locale)).toEqual([
      'en', 'de', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja',
    ]);
    for (const bundle of CLIPROXYAPI_UI_TRANSLATION_BUNDLES) {
      expect(bundle.messages).toEqual({
        'managedPurpose.openai.title': expect.any(String),
        'managedPurpose.anthropic.title': expect.any(String),
      });
      expect(bundle.messages['managedPurpose.openai.title'].trim()).not.toBe('');
      expect(bundle.messages['managedPurpose.anthropic.title'].trim()).not.toBe('');
    }
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
    expect(PLUGIN_MANIFEST.entrypoints).toEqual({ daemon: './.happier-plugin/daemon.js' });
    const providerFamily = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers');
    expect(providerFamily).toMatchObject({
      identityKind: 'delegatedDomain',
      disposition: 'delegated',
      activationDemand: 'conditional',
      allowedRuntimeRegistration: 'providers',
    });
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      managedRuntime: {
        kind: 'managed',
        connectedAccountPurposeBindingPolicy: { minimumBound: 1 },
        connectedAccounts: [{
          purpose: 'openai-upstream',
          title: {
            key: 'managedPurpose.openai.title',
            fallback: 'Use OpenAI upstream account',
          },
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: false,
          materializationKinds: ['httpHeaders'],
        }, {
          purpose: 'anthropic-upstream',
          title: {
            key: 'managedPurpose.anthropic.title',
            fallback: 'Use Anthropic upstream account',
          },
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
      registration: 'required',
    });
  });
});
