/**
 * The build-side half of the Azure DevOps detail surface identity.
 *
 * `AZURE_DEVOPS_DETAIL_UI_ARTIFACT_ID` must equal `AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID` in
 * `src/triage/descriptor.ts`: the manifest's `renderers[].artifact` is what the host looks up in
 * the staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` keeps this `.mjs` build
 * input and the TypeScript manifest from drifting apart — a manifest naming an artifact no build
 * target produces passes contribution conformance and then fails at mount.
 */
export const AZURE_DEVOPS_DETAIL_UI_ARTIFACT_ID = 'azure-devops-detail-native';
export const AZURE_DEVOPS_DETAIL_UI_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
export const AZURE_DEVOPS_DETAIL_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';
export const AZURE_DEVOPS_DETAIL_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_azure_devops_azure_devops_detail_native',
  modulePath: './renderSurface',
  exportName: 'renderSurface',
});

/**
 * The build-side half of the Azure DevOps PRs & Issues settings surface identity.
 *
 * `AZURE_DEVOPS_SETTINGS_UI_ARTIFACT_ID` must equal `AZURE_DEVOPS_TRIAGE_SETTINGS_ARTIFACT_ID` in `src/triage/descriptor.ts` — the manifest's
 * `renderers[].artifact`, NOT its `renderers[].id`, is what the host looks up in the
 * staged `dist/happier-plugin-ui` graph. `src/uiBuildConfig.test.ts` is the check that
 * keeps this `.mjs` build input and the TypeScript manifest from drifting apart.
 */
export const AZURE_DEVOPS_SETTINGS_UI_ARTIFACT_ID = 'azure-devops-triage-sources-native';
export const AZURE_DEVOPS_SETTINGS_UI_SOURCE_ENTRY = 'src/ui/settings/renderSettingsSurface.tsx';
export const AZURE_DEVOPS_SETTINGS_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_azure_devops_azure_devops_triage_sources_native',
  modulePath: './renderSettingsSurface',
  exportName: 'renderSurface',
});
