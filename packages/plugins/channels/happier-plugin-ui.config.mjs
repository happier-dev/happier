import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  CHANNELS_REPACK_MODULE_IDENTITY,
  CHANNELS_UI_BUILD_OUT_DIR,
  CHANNELS_UI_RENDERER_ID,
  CHANNELS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/** One React Native surface supplies the web, iOS, and Android Settings artifact. */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: CHANNELS_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: CHANNELS_UI_RENDERER_ID,
    entry: CHANNELS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: CHANNELS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
