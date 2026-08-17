import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID,
  SENTRY_TRIAGE_SETTINGS_GROUP_ID,
  SENTRY_TRIAGE_SETTINGS_PAGE_ID,
  SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
} from './sentryContracts.js';

import { PLUGIN_MANIFEST, SENTRY_DETAIL_ARTIFACT_ID, SENTRY_DETAIL_RENDERER_ID } from './manifest.js';

describe('Sentry detail UI build configuration', () => {
  it('builds the exact artifact the manifest renderer declares', async () => {
    const loaded = await import('../happier-plugin-ui.config.mjs');
    const config = loaded.default as Readonly<{
      projectRoot?: string;
      outDir?: string;
      targets: readonly Readonly<{
        rendererId: string;
        entry: string;
        kind: string;
        platforms: readonly string[];
      }>[];
    }>;

    expect(config).toMatchObject({
      projectRoot: '.',
      outDir: 'node_modules/.cache/happier-plugin-ui',
      targets: [{
        rendererId: SENTRY_DETAIL_ARTIFACT_ID,
        entry: 'src/ui/renderSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }, {
        rendererId: SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID,
        entry: 'src/ui/settings/renderSettingsSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }],
    });
    // The declared artifact must be one this package actually emits. A manifest naming an
    // artifact no build target produces passes contribution conformance and then fails at mount.
    // Exactly one renderer may name a built artifact; the declarative fallback builds nothing.
    expect(PLUGIN_MANIFEST.contributes.ui.renderers
      .filter((renderer) => renderer.kind === 'reactNative'))
      .toEqual([expect.objectContaining({
        id: SENTRY_DETAIL_RENDERER_ID,
        kind: 'reactNative',
        artifact: config.targets[0]?.rendererId,
      }), expect.objectContaining({
        id: SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
        kind: 'reactNative',
        artifact: config.targets[1]?.rendererId,
      })]);
    expect(config.targets[0]).not.toHaveProperty('bundlerConfig');

    for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
      await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  // Cold source resolution validates the public SDK build barrel itself, and that
  // resolution is I/O bound: a bare `node` import of this config measured ~40s on
  // a loaded machine, so the budget covers the slow path rather than the fast one.
  }, 180_000);

  it('mounts the built artifact for the detail surface the Triage contribution declares', () => {
    const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    const declared = JSON.stringify(contribution);
    expect(declared).toContain(SENTRY_DETAIL_RENDERER_ID);
  });

  it('declares one reachable Settings page bound to the settings renderer', () => {
    // Without this declaration the settings surface is dormant source: the host has
    // no page to route to, so nothing in the product can reach the source
    // administration Action at all.
    expect(PLUGIN_MANIFEST.contributes.ui.settingsPages).toEqual([expect.objectContaining({
      id: SENTRY_TRIAGE_SETTINGS_PAGE_ID,
      renderer: SENTRY_TRIAGE_SETTINGS_RENDERER_ID,
    })]);
    expect(PLUGIN_MANIFEST.contributes.ui.settingsPages[0].group)
      .toEqual({ kind: 'plugin', localId: SENTRY_TRIAGE_SETTINGS_GROUP_ID });
    expect(PLUGIN_MANIFEST.contributes.ui.settingsGroups)
      .toEqual([expect.objectContaining({ id: SENTRY_TRIAGE_SETTINGS_GROUP_ID })]);
  });
});
