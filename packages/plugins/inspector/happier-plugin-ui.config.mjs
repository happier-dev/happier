import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  INSPECTOR_REPACK_MODULE_IDENTITY,
  INSPECTOR_UI_RENDERER_ID,
  INSPECTOR_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * One React Native source produces the Inspector's RNW, iOS, and Android
 * artifacts. The build owner turns this declaration into the platform-specific
 * Vite/Re.Pack presets, verifies their complete byte graphs, and writes the
 * canonical `dist/happier-plugin-ui/ui-artifacts.json` manifest.
 */
export const pluginUiBuildConfig = definePluginUiBuildConfig({
    projectRoot: '.',
    outDir: 'node_modules/.cache/happier-plugin-ui',
    targets: [
        {
      rendererId: INSPECTOR_UI_RENDERER_ID,
      entry: INSPECTOR_UI_SOURCE_ENTRY,
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android'],
      module: INSPECTOR_REPACK_MODULE_IDENTITY,
        },
    ],
});

export default pluginUiBuildConfig;
