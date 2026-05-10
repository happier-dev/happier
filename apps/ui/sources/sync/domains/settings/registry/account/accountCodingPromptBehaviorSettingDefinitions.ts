import {
    CodingPromptBehaviorV1Schema,
    DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';

export const ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_DEFINITIONS = defineSettingDefinitions({
    codingPromptBehaviorV1: {
        schema: CodingPromptBehaviorV1Schema.default(DEFAULT_CODING_PROMPT_BEHAVIOR_V1),
        default: DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
        description: 'Controls whether built-in coding prompt guidance asks agents to update titles or propose response options',
        storageScope: 'account',
        analytics: {
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
    },
});

export const ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_ARTIFACTS = buildSettingArtifacts(
    ACCOUNT_CODING_PROMPT_BEHAVIOR_SETTING_DEFINITIONS,
);
