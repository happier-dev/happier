import { CodingPromptBehaviorV1Schema } from '@happier-dev/protocol';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    codingPromptBehaviorV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: unknown) => {
            const parsed = CodingPromptBehaviorV1Schema.parse(value);
            return {
                sessionTitleUpdates: parsed.sessionTitleUpdates,
                responseOptions: parsed.responseOptions,
            };
        },
    },
});
