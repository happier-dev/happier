import { readPluginTranslationResources } from '../../../../scripts/testing/readPluginTranslationResources.js';

import { describe, expect, it } from 'vitest';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../', import.meta.url));
const PACKAGED_UI_TRANSLATION_BUNDLES = Object.entries(PACKAGED_UI_TRANSLATIONS).map(([locale, messages]) => ({ locale, messages }));

describe('CLIProxyAPI plugin manifest', () => {
  it('discloses the managed gateway environment without granting host resources', async () => {
    await expect(import('./manifest.js').then((module) =>
      PluginManifestV2Schema.parse(module.PLUGIN_MANIFEST))).resolves.toMatchObject({
      id: 'happier.provider.cliproxyapi',
      runtime: { apiVersion: 1 },
      hostAccess: {
        required: [{
          capability: 'environment',
          scope: {
            keys: [
              'HOST',
              'PORT',
              'HAPPIER_CLIPROXYAPI_CONSUMER_ACCESS_PATH',
              'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
              'HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION',
            ],
          },
        }],
        optional: [],
      },
      contributes: { providers: [{ id: 'cliproxyapi', kind: 'aggregator' }] },
    });
  });

  it('ships the managed-purpose presentation in every supported plugin locale', () => {
    expect(PACKAGED_UI_TRANSLATION_BUNDLES.map((bundle) => bundle.locale).sort()).toEqual([
      'en', 'de', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja',
    ].sort());
    for (const bundle of PACKAGED_UI_TRANSLATION_BUNDLES) {
      expect(bundle.messages).toEqual({
        'managedPurpose.openai.title': expect.any(String),
        'managedPurpose.anthropic.title': expect.any(String),
      });
      expect(bundle.messages['managedPurpose.openai.title'].trim()).not.toBe('');
      expect(bundle.messages['managedPurpose.anthropic.title'].trim()).not.toBe('');
    }
  });

  it('uses only the strict data-only root and survives bundled or installed ingestion', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toEqual(
      ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST)),
    );
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST).ok).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.providers[0].managedRuntime?.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        staticModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol' })]),
      }),
      expect.objectContaining({
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        staticModels: expect.arrayContaining([expect.objectContaining({ id: 'claude-sonnet-4-6' })]),
      }),
    ]));
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
            fallback: 'ChatGPT account or pool',
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
            fallback: 'Claude account or pool',
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
          'cliproxyapi-openai-chat',
          'cliproxyapi-openai-responses',
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
