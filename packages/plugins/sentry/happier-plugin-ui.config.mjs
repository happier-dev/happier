import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  SENTRY_DETAIL_REPACK_MODULE_IDENTITY,
  SENTRY_DETAIL_UI_ARTIFACT_ID,
  SENTRY_DETAIL_UI_BUILD_OUT_DIR,
  SENTRY_DETAIL_UI_SOURCE_ENTRY,
  SENTRY_SETTINGS_REPACK_MODULE_IDENTITY,
  SENTRY_SETTINGS_UI_ARTIFACT_ID,
  SENTRY_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact the
 * manifest names: the Triage detail body, and the settings page a person uses to
 * put Sentry into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: SENTRY_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: SENTRY_DETAIL_UI_ARTIFACT_ID,
    entry: SENTRY_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: SENTRY_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: SENTRY_SETTINGS_UI_ARTIFACT_ID,
    entry: SENTRY_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: SENTRY_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
