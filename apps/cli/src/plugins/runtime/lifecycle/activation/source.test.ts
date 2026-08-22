import { describe, expect, it } from 'vitest';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { ActivationTarget } from './targets';
import { resolveActivationSource } from './source';

describe('resolveActivationSource', () => {
  it('does not synthesize executable authority from an uncommitted development target', () => {
    const target: ActivationTarget = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'com.acme.development-only',
      manifestPath: '/plugins/com.acme.development-only/.happier-plugin/plugin.json',
      daemonEntryPath: null,
      devDaemonEntryPath: '/plugins/com.acme.development-only/src/daemon.ts',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/com.acme.development-only',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'com.acme.development-only',
        version: '1.0.0',
        displayName: 'Development only',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
        entrypoints: { development: './src/daemon.ts' },
        contributes: {},
      }),
    };

    expect(() => resolveActivationSource(target, undefined))
      .toThrow(/committed activation source/i);
  });

  it('selects the development entry from development-source identity instead of legacy trust policy', () => {
    const target: ActivationTarget = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'com.acme.reviewed-development',
      manifestPath: '/plugins/com.acme.reviewed-development/.happier-plugin/plugin.json',
      daemonEntryPath: '/plugins/com.acme.reviewed-development/dist/daemon.js',
      devDaemonEntryPath: '/plugins/com.acme.reviewed-development/src/daemon.ts',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/com.acme.reviewed-development',
        trustPolicy: 'prompt',
        installPolicy: 'link',
        devWatch: true,
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'com.acme.reviewed-development',
        version: '1.0.0',
        displayName: 'Reviewed development',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/daemon.js', development: './src/daemon.ts' },
        contributes: {},
      }),
    };

    const committedSource = {
      kind: 'file_backed',
      entryPath: target.daemonEntryPath!,
      devEntryPath: target.devDaemonEntryPath!,
      useDevelopmentEntry: true,
      trustPolicy: 'prompt',
    } as const;

    expect(resolveActivationSource(target, () => committedSource)).toBe(committedSource);
  });
});
