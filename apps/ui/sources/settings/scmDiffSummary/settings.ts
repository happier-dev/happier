import { scmDiffSummarySettingBinding as portableBinding, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { Settings } from '@/sync/domains/settings/settings';

export { SCM_DIFF_SUMMARY_SETTING_KEYS, encodeScmDiffSummaryModelOverride, decodeScmDiffSummaryModelOverride, resolveScmDiffSummaryModelSelection, resolveScmDiffSummarySettings } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
export type { ScmDiffSummaryCatalogProfile, ResolvedScmDiffSummarySettings } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';

/** Both host adapters consume the one catalog admission and CAS recheck. */
export function scmDiffSummarySettingBinding(key: typeof SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch): SettingStorageBinding {
    return portableBinding<Settings>(key);
}
