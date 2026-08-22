import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

const CHANNELS_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
const CHANNELS_UI_RENDERER_ID = 'channels-app-native';

describe('Channels UI build configuration', () => {
  it('uses the public surface-layout owner for one web/iOS/Android artifact declaration', async () => {
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
      outDir: CHANNELS_UI_BUILD_OUT_DIR,
      targets: [{
        rendererId: CHANNELS_UI_RENDERER_ID,
        entry: 'src/ui/renderSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
      }],
    });
    expect(PLUGIN_MANIFEST.contributes?.ui?.renderers?.[0]).toMatchObject({
      kind: 'reactNative',
      artifact: config.targets[0]?.rendererId,
    });
    expect(config.targets[0]).not.toHaveProperty('bundlerConfig');

    for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
      await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  // Cold source resolution validates the public SDK build barrel itself.
  }, 45_000);
});
