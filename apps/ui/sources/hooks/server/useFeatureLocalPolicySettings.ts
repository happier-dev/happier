import { useShallow } from 'zustand/react/shallow';

import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storage';

export function useFeatureLocalPolicySettings(): FeatureLocalPolicySettings {
    return getStorage()(useShallow((state) => {
        const settings = state.settings ?? settingsDefaults;
        return {
            experiments: settings.experiments,
            featureToggles: settings.featureToggles,
        };
    }));
}
