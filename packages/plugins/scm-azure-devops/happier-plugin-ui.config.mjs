import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  AZURE_DEVOPS_DETAIL_REPACK_MODULE_IDENTITY,
  AZURE_DEVOPS_DETAIL_UI_ARTIFACT_ID,
  AZURE_DEVOPS_DETAIL_UI_BUILD_OUT_DIR,
  AZURE_DEVOPS_DETAIL_UI_SOURCE_ENTRY,
  AZURE_DEVOPS_SETTINGS_REPACK_MODULE_IDENTITY,
  AZURE_DEVOPS_SETTINGS_UI_ARTIFACT_ID,
  AZURE_DEVOPS_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact the
 * manifest names: the Triage detail body, and the settings page a person uses to
 * put Azure DevOps into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: AZURE_DEVOPS_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: AZURE_DEVOPS_DETAIL_UI_ARTIFACT_ID,
    entry: AZURE_DEVOPS_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: AZURE_DEVOPS_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: AZURE_DEVOPS_SETTINGS_UI_ARTIFACT_ID,
    entry: AZURE_DEVOPS_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: AZURE_DEVOPS_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
