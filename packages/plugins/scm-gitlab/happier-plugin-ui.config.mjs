import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  GITLAB_DETAIL_REPACK_MODULE_IDENTITY,
  GITLAB_DETAIL_UI_ARTIFACT_ID,
  GITLAB_DETAIL_UI_BUILD_OUT_DIR,
  GITLAB_DETAIL_UI_SOURCE_ENTRY,
  GITLAB_SETTINGS_REPACK_MODULE_IDENTITY,
  GITLAB_SETTINGS_UI_ARTIFACT_ID,
  GITLAB_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact the
 * manifest names: the Triage detail body, and the settings page a person uses to
 * put GitLab into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: GITLAB_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: GITLAB_DETAIL_UI_ARTIFACT_ID,
    entry: GITLAB_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: GITLAB_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: GITLAB_SETTINGS_UI_ARTIFACT_ID,
    entry: GITLAB_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: GITLAB_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
