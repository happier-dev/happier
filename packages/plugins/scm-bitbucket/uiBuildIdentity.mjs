/**
 * The build-side half of the Bitbucket Cloud detail surface identity.
 *
 * `BITBUCKET_DETAIL_UI_ARTIFACT_ID` must equal `BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID` in
 * `src/triage/source/descriptor.ts`: the manifest's `renderers[].artifact` is what the host looks
 * up in the staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart — a manifest naming
 * an artifact no build target produces passes contribution conformance and then fails at mount.
 */
export const BITBUCKET_DETAIL_UI_ARTIFACT_ID = 'bitbucket-detail-native';
export const BITBUCKET_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const BITBUCKET_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const BITBUCKET_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_bitbucket_bitbucket_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the Bitbucket Cloud PRs & Issues settings surface identity.
 *
 * `BITBUCKET_SETTINGS_UI_ARTIFACT_ID` must equal `BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID` in `src/triage/source/descriptor.ts` — the manifest's
 * `renderers[].artifact`, NOT its `renderers[].id`, is what the host looks up in the
 * staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const BITBUCKET_SETTINGS_UI_ARTIFACT_ID = 'bitbucket-triage-sources-native';
export const BITBUCKET_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const BITBUCKET_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_bitbucket_bitbucket_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
