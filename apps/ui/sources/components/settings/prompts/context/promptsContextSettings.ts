import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { ACCOUNT_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';

/** `/settings/prompts/stacks/coding`: the Account layer of Context, reached from Prompts & Skills. */
export const PROMPTS_CONTEXT_ROUTE = '/settings/prompts/stacks/coding';

/**
 * The searchable settings of Settings → Prompts & Skills → Context: the three Account memory
 * creation defaults (plan 65 §2 flow 1; D45, D47). They live on the Context page, next to the memory
 * they turn on, so they are declared as its sub-page.
 */
export const PROMPTS_CONTEXT_SETTINGS = defineSettingsPage({
    pageId: 'prompts',
    subpage: { id: 'context', route: PROMPTS_CONTEXT_ROUTE, titleKey: 'contextPages.account.title' },
    sections: {
        memoryDefaults: {
            titleKey: 'promptLibrary.memoryDefaultsTitle',
            settings: {
                memoryUseInNewSessions: ACCOUNT_SETTING_DECLARATIONS_V1.memoryUseInNewSessions,
                memoryUseInNewBots: ACCOUNT_SETTING_DECLARATIONS_V1.memoryUseInNewBots,
                memoryUpkeepInNewBots: ACCOUNT_SETTING_DECLARATIONS_V1.memoryUpkeepInNewBots,
            },
        },
    },
});
