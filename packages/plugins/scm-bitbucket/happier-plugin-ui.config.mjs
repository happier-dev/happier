import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  BITBUCKET_DETAIL_REPACK_MODULE_IDENTITY,
  BITBUCKET_DETAIL_UI_ARTIFACT_ID,
  BITBUCKET_DETAIL_UI_BUILD_OUT_DIR,
  BITBUCKET_DETAIL_UI_SOURCE_ENTRY,
  BITBUCKET_SETTINGS_REPACK_MODULE_IDENTITY,
  BITBUCKET_SETTINGS_UI_ARTIFACT_ID,
  BITBUCKET_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact the
 * manifest names: the Triage detail body, and the settings page a person uses to
 * put Bitbucket Cloud into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: BITBUCKET_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: BITBUCKET_DETAIL_UI_ARTIFACT_ID,
    entry: BITBUCKET_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: BITBUCKET_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: BITBUCKET_SETTINGS_UI_ARTIFACT_ID,
    entry: BITBUCKET_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: BITBUCKET_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
