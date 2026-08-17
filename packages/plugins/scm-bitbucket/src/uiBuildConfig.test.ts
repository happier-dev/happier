import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
  BITBUCKET_TRIAGE_SETTINGS_GROUP_ID,
  BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
  BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
} from './triage/source/descriptor.js';

import {
  BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
  BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
  PLUGIN_MANIFEST,
} from './manifest.js';

describe('Bitbucket detail UI build configuration', () => {
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
        rendererId: BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
        entry: 'src/ui/renderSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }, {
        rendererId: BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
        entry: 'src/ui/settings/renderSettingsSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }],
    });
    // The declared artifact must be one this package actually emits. A manifest naming an artifact
    // no build target produces passes contribution conformance and then fails at mount.
    expect(PLUGIN_MANIFEST.contributes.ui.renderers).toEqual([expect.objectContaining({
      id: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
      kind: 'reactNative',
      artifact: config.targets[0]?.rendererId,
    }), expect.objectContaining({
      id: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
      kind: 'reactNative',
      artifact: config.targets[1]?.rendererId,
    })]);
    expect(config.targets[0]).not.toHaveProperty('bundlerConfig');

    // The build barrel owns the bundler configuration; a hand-rolled one here would be a second
    // owner that drifts from it.
    for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
      await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  // Cold source resolution validates the public SDK build barrel itself.
  }, 45_000);

  it('mounts the built artifact for the detail surface the Triage contribution declares', () => {
    const declared = JSON.stringify(PLUGIN_MANIFEST.contributes.targetedPluginContributions);
    expect(declared).toContain(BITBUCKET_TRIAGE_DETAIL_RENDERER_ID);
  });

  it('declares one reachable Settings page bound to the settings renderer', () => {
    // Without this declaration the settings surface is dormant source: the host has
    // no page to route to, so nothing in the product can reach the source
    // administration Action at all.
    expect(PLUGIN_MANIFEST.contributes.ui.settingsPages).toEqual([expect.objectContaining({
      id: BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
      renderer: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
    })]);
    expect(PLUGIN_MANIFEST.contributes.ui.settingsPages[0].group)
      .toEqual({ kind: 'plugin', localId: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID });
    expect(PLUGIN_MANIFEST.contributes.ui.settingsGroups)
      .toEqual([expect.objectContaining({ id: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID })]);
  });
});
