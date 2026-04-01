import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

import { RemoteHostSchema } from '@/sync/domains/remoteHosts/remoteHostModel';

function arrayCount(value: readonly unknown[]) {
    return value.length;
}

export const ACCOUNT_REMOTE_HOSTS_SETTING_DEFINITIONS = defineSettingDefinitions({
    remoteHostsV1: {
        schema: z.array(RemoteHostSchema),
        default: [],
        description: 'Saved remote hosts (SSH profiles)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
});

export const ACCOUNT_REMOTE_HOSTS_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_REMOTE_HOSTS_SETTING_DEFINITIONS);
