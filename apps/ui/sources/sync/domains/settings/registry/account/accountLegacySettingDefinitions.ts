import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

export const ACCOUNT_LEGACY_SETTING_DEFINITIONS = defineSettingDefinitions({
    viewInline: {
        schema: z.boolean().optional(),
        default: false,
        description: 'Whether to view inline tool calls (deprecated)',
        storageScope: 'account',
    },
    inferenceOpenAIKey: {
        schema: z.string().nullish(),
        default: null,
        description: 'OpenAI API key for inference',
        storageScope: 'account',
    },
    expandTodos: {
        schema: z.boolean().optional(),
        default: true,
        description: 'Whether to expand todo lists (deprecated)',
        storageScope: 'account',
    },
    usePickerSearch: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to show search in machine/path picker UIs (legacy combined toggle)',
        storageScope: 'account',
    },
    compactSessionView: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to use compact view for active sessions',
        storageScope: 'account',
    },
    compactSessionViewMinimal: {
        schema: z.boolean(),
        default: true,
        description: 'Whether compact session view should use the narrow layout',
        storageScope: 'account',
    },
    reviewPromptAnswered: {
        schema: z.boolean(),
        default: false,
        description: 'Whether the review prompt has been answered',
        storageScope: 'account',
    },
    reviewPromptLikedApp: {
        schema: z.boolean().nullish(),
        default: null,
        description: 'Whether user liked the app when asked',
        storageScope: 'account',
    },
    lastUsedPermissionMode: {
        schema: z.string().nullable(),
        default: null,
        description: 'Last selected permission mode for new sessions',
        storageScope: 'account',
    },
    lastUsedModelMode: {
        schema: z.string().nullable(),
        default: null,
        description: 'Last selected model mode for new sessions',
        storageScope: 'account',
    },
});

export const ACCOUNT_LEGACY_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_LEGACY_SETTING_DEFINITIONS);
