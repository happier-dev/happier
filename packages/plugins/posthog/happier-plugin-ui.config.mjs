import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
import {
  POSTHOG_DETAIL_REPACK_MODULE_IDENTITY,
  POSTHOG_DETAIL_UI_ARTIFACT_ID,
  POSTHOG_DETAIL_UI_BUILD_OUT_DIR,
  POSTHOG_DETAIL_UI_SOURCE_ENTRY,
  POSTHOG_SETTINGS_REPACK_MODULE_IDENTITY,
  POSTHOG_SETTINGS_UI_ARTIFACT_ID,
  POSTHOG_SETTINGS_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * Two React Native surfaces, each supplying the web, iOS and Android artifact the
 * manifest names: the Triage detail body, and the settings page a person uses to
 * put PostHog into PRs & Issues in the first place.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: POSTHOG_DETAIL_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: POSTHOG_DETAIL_UI_ARTIFACT_ID,
    entry: POSTHOG_DETAIL_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: POSTHOG_DETAIL_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: POSTHOG_SETTINGS_UI_ARTIFACT_ID,
    entry: POSTHOG_SETTINGS_UI_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: POSTHOG_SETTINGS_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
