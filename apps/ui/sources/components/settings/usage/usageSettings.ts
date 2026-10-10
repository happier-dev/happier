import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { ACCOUNT_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';

/** Account-owned Coach preferences use the ordinary Settings declaration/CAS path. */
export const USAGE_SETTINGS = defineSettingsPage({
    pageId: 'usage',
    sections: {
        howYouWork: {
            titleKey: 'usage.board.howYouWork.nightGrid',
            settings: {
                nightHours: {},
            },
        },
        coach: {
            titleKey: 'usage.insights',
            settings: {
                coachPreferences: ACCOUNT_SETTING_DECLARATIONS_V1.usageCoachPreferences,
            },
        },
        costs: {
            titleKey: 'usage.cost',
            settings: {
                modelPrices: ACCOUNT_SETTING_DECLARATIONS_V1.usageModelPrices,
            },
        },
    },
});
