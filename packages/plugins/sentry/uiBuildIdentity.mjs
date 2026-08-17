/**
 * The build-side half of the Sentry detail surface identity.
 *
 * `SENTRY_DETAIL_UI_ARTIFACT_ID` must equal `SENTRY_DETAIL_ARTIFACT_ID` in `src/manifest.ts`:
 * the manifest's `renderers[].artifact` is what the host looks up in the staged
 * `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that keeps this
 * `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const SENTRY_DETAIL_UI_ARTIFACT_ID = 'sentry-detail-native';
export const SENTRY_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const SENTRY_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const SENTRY_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_sentry_sentry_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the Sentry PRs & Issues settings surface identity.
 *
 * `SENTRY_SETTINGS_UI_ARTIFACT_ID` must equal `SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID` in `src/sentryContracts.ts` — the manifest's
 * `renderers[].artifact`, NOT its `renderers[].id`, is what the host looks up in the
 * staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const SENTRY_SETTINGS_UI_ARTIFACT_ID = 'sentry-triage-sources-native';
export const SENTRY_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const SENTRY_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_sentry_sentry_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
