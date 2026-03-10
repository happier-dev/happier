import { defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

export const ACCOUNT_FEATURE_TOGGLE_SETTING_DEFINITIONS = defineSettingDefinitions({
    featureToggles: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Per-feature toggle map used by the UI feature registry and feature decision runtime',
        storageScope: 'account',
    },
});
