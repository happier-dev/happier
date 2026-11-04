import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';

export function useFeatureLocalPolicySettings(): FeatureLocalPolicySettings {
    return useSettingsValues(['experiments', 'featureToggles']);
}
