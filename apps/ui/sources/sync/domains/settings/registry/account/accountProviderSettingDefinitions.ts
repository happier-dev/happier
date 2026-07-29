import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

export const ACCOUNT_PROVIDER_SETTING_DEFINITIONS = defineSettingDefinitions({
    providerSettingsV1: {
        // Keep the synced provider subtree opaque at this generic settings boundary. Provider
        // readers classify current/future/malformed versions without destructive normalization.
        schema: z.unknown().optional(),
        default: undefined,
        description: 'Versioned first-class provider connections and authorization state',
        storageScope: 'account',
        analytics: {
            valueKind: 'presence',
            privacy: 'forbidden',
            identityScope: 'person',
        },
    },
});

export const ACCOUNT_PROVIDER_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_PROVIDER_SETTING_DEFINITIONS);
