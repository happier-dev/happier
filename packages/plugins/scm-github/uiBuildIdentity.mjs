/**
 * The build-side half of the GitHub detail surface identity.
 *
 * `GITHUB_DETAIL_UI_ARTIFACT_ID` must equal `GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1` in
 * `src/triage/contribution.ts`: the manifest's `renderers[].artifact` — NOT its
 * `renderers[].id` — is what the host looks up in the staged `dist/happier-plugin-ui`
 * graph, and the build target's `rendererId` field names that same artifact. Binding it
 * to the renderer id instead produces a manifest that passes contribution conformance
 * and then fails at mount. `src/uiBuildConfig.test.ts` is the check that keeps this
 * `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const GITHUB_DETAIL_UI_ARTIFACT_ID = 'github-detail-native';
export const GITHUB_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const GITHUB_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const GITHUB_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_github_github_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the GitHub PRs & Issues settings surface identity.
 *
 * `GITHUB_SETTINGS_UI_ARTIFACT_ID` must equal `GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1`
 * in `src/triage/contribution.ts` — the manifest's `renderers[].artifact`, NOT its
 * `renderers[].id`, is what the host looks up in the staged `dist/happier-plugin-ui`
 * graph. `src/uiBuildConfig.test.ts` is the check that keeps this `.mjs` build input
 * and the TypeScript manifest from drifting apart.
 */
export const GITHUB_SETTINGS_UI_ARTIFACT_ID = 'github-triage-sources-native';
export const GITHUB_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const GITHUB_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_github_github_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
