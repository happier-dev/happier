import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
  PLUGIN_MANIFEST,
} from './manifest.js';
import { GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 } from './triage/contribution.js';

describe('GitHub detail UI build configuration', () => {
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
        // The build target's `rendererId` names the ARTIFACT, not the renderer id.
        // Binding it to the renderer id produces a manifest that passes contribution
        // conformance and then fails at mount; that mismatch has already broken two
        // sibling packages.
        rendererId: GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1,
        entry: 'src/ui/renderSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }, {
        rendererId: GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
        entry: 'src/ui/settings/renderSettingsSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }],
    });
    expect(GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1).not.toBe(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
    expect(GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1).not.toBe(GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1);

    // Each declared artifact must be one this package actually emits.
    expect((PLUGIN_MANIFEST.contributes.ui?.renderers ?? [])).toEqual([expect.objectContaining({
      id: GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
      kind: 'reactNative',
      artifact: config.targets[0]?.rendererId,
    }), expect.objectContaining({
      id: GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
      kind: 'reactNative',
      artifact: config.targets[1]?.rendererId,
    })]);
    expect(config.targets[0]).not.toHaveProperty('bundlerConfig');
    expect(config.targets[1]).not.toHaveProperty('bundlerConfig');

    for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
      await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  // Cold source resolution validates the public SDK build barrel itself.
  }, 45_000);

  it('mounts the built artifact for the detail surface the Triage contribution declares', () => {
    const declared = JSON.stringify(PLUGIN_MANIFEST.contributes.targetedPluginContributions);
    expect(declared).toContain(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
  });

  it('declares one reachable Settings page bound to the settings renderer', () => {
    // Without this declaration the settings surface is dormant source: the host
    // has no page to route to, so nothing in the product can reach the source
    // administration Action at all.
    expect((PLUGIN_MANIFEST.contributes.ui?.settingsPages ?? [])).toEqual([expect.objectContaining({
      id: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
      renderer: GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
    })]);
    const page = (PLUGIN_MANIFEST.contributes.ui?.settingsPages ?? [])[0];
    expect(page.group).toEqual({ kind: 'plugin', localId: GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 });
    expect((PLUGIN_MANIFEST.contributes.ui?.settingsGroups ?? []))
      .toEqual([expect.objectContaining({ id: GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 })]);
  });
});
