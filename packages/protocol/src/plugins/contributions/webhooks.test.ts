import { describe, expect, it } from 'vitest';

import { PluginManifestV2Schema } from '../manifest/v2.js';

const webhookAction = {
  id: 'receive-github',
  title: 'Receive GitHub webhook',
  scopes: ['global'],
  surfaces: ['plugin'],
  dangerLevel: 'safe',
  execution: { target: 'daemon' },
} as const;

describe('plugin webhook contributions', () => {
  it('admits only the closed GitHub verifier and a same-plugin plugin-surface Action', () => {
    const manifest = PluginManifestV2Schema.parse({
      schemaVersion: 2,
      id: 'example.github-webhooks',
      version: '1.0.0',
      displayName: 'GitHub webhooks',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      contributes: {
        actions: [webhookAction],
        webhooks: [{
          id: 'github-events',
          title: 'GitHub events',
          verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
          handlerAction: { localId: 'receive-github' },
        }],
      },
    });

    expect(manifest.contributes.webhooks).toHaveLength(1);
    expect(PluginManifestV2Schema.safeParse({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        webhooks: [{
          ...manifest.contributes.webhooks[0],
          verifier: { kind: 'stripe_hmac_v1', routing: 'accountEndpoint' },
        }],
      },
    }).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        webhooks: [{
          ...manifest.contributes.webhooks[0],
          routePath: '/github',
        }],
      },
    }).success).toBe(false);
  });

  it('rejects a dangling or non-plugin-surface handler Action', () => {
    const base = {
      schemaVersion: 2,
      id: 'example.github-webhooks',
      version: '1.0.0',
      displayName: 'GitHub webhooks',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
    } as const;
    const contribution = {
      id: 'github-events',
      title: 'GitHub events',
      verifier: { kind: 'github_hmac_sha256_v1', routing: 'providerInstallation' },
      handlerAction: { localId: 'receive-github' },
    } as const;

    expect(PluginManifestV2Schema.safeParse({
      ...base,
      contributes: { actions: [], webhooks: [contribution] },
    }).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse({
      ...base,
      contributes: {
        actions: [{ ...webhookAction, surfaces: ['ui'], placementBindings: ['commandPalette'] }],
        webhooks: [contribution],
      },
    }).success).toBe(false);
  });
});
