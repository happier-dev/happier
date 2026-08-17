/**
 * The build-side half of the PostHog detail surface identity.
 *
 * `POSTHOG_DETAIL_UI_ARTIFACT_ID` must equal `POSTHOG_DETAIL_ARTIFACT_ID` in
 * `src/posthogContracts.ts`: the manifest's `renderers[].artifact` is what the host looks
 * up in the staged `dist/happier-plugin-ui` graph, so a drift between this `.mjs` build
 * input and the TypeScript manifest passes contribution conformance and then fails at
 * mount. `src/uiBuildConfig.test.ts` is the check that keeps them together.
 */
export const POSTHOG_DETAIL_UI_ARTIFACT_ID = 'posthog-issue-detail-native';
export const POSTHOG_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const POSTHOG_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const POSTHOG_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_posthog_posthog_issue_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the PostHog PRs & Issues settings surface identity.
 *
 * `POSTHOG_SETTINGS_UI_ARTIFACT_ID` must equal `POSTHOG_TRIAGE_SETTINGS_ARTIFACT_ID` in `src/posthogContracts.ts` — the manifest's
 * `renderers[].artifact`, NOT its `renderers[].id`, is what the host looks up in the
 * staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const POSTHOG_SETTINGS_UI_ARTIFACT_ID = 'posthog-triage-sources-native';
export const POSTHOG_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const POSTHOG_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_posthog_posthog_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
