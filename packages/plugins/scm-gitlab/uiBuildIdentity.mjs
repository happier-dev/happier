/**
 * The build-side half of the GitLab detail surface identity.
 *
 * `GITLAB_DETAIL_UI_ARTIFACT_ID` must equal `GITLAB_TRIAGE_DETAIL_ARTIFACT_ID` in
 * `src/triage/contribution.ts`: the manifest's `renderers[].artifact` is what the host looks up
 * in the staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const GITLAB_DETAIL_UI_ARTIFACT_ID = 'gitlab-detail-native';
export const GITLAB_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const GITLAB_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const GITLAB_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_gitlab_gitlab_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the GitLab PRs & Issues settings surface identity.
 *
 * `GITLAB_SETTINGS_UI_ARTIFACT_ID` must equal `GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID` in `src/triage/contribution.ts` — the manifest's
 * `renderers[].artifact`, NOT its `renderers[].id`, is what the host looks up in the
 * staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const GITLAB_SETTINGS_UI_ARTIFACT_ID = 'gitlab-triage-sources-native';
export const GITLAB_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const GITLAB_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_gitlab_gitlab_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
