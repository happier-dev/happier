import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  GITHUB_DETAIL_REPACK_MODULE_IDENTITY,
  GITHUB_DETAIL_UI_ARTIFACT_ID,
  GITHUB_DETAIL_UI_BUILD_OUT_DIR,
  GITHUB_DETAIL_UI_SOURCE_ENTRY,
  GITHUB_SETTINGS_REPACK_MODULE_IDENTITY,
  GITHUB_SETTINGS_UI_ARTIFACT_ID,
  GITHUB_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact
 * the manifest names: the Triage detail body, and the settings page a person
 * uses to put GitHub into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: GITHUB_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    // `rendererId` names the ARTIFACT the manifest renderer points at, never the
    // renderer id itself.
    rendererId: GITHUB_DETAIL_UI_ARTIFACT_ID,
    entry: GITHUB_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: GITHUB_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: GITHUB_SETTINGS_UI_ARTIFACT_ID,
    entry: GITHUB_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: GITHUB_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
