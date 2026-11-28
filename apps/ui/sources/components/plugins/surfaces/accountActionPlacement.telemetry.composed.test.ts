import { Platform } from 'react-native';
import { expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/telemetry/src/manifest';
import { TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS } from '../../../../../../packages/plugins/telemetry/src/exceptions/sourceActions';
import { resolvesAccountActionLocally } from './accountActionPlacement';

it('places native exception reads in the invoking browser when the Collector is offline', async () => {
    const previousPlatform = Platform.OS;
    Object.assign(Platform, { OS: 'web' });
    try {
        for (const localId of Object.values(TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS)) {
            const action = PLUGIN_MANIFEST.contributes.actions.find(candidate => candidate.id === localId);
            if (action?.execution.target !== 'account') throw new Error('Expected an Account exception source Action');
            expect(await resolvesAccountActionLocally({
                accountScope: { serverId: 'https://home.example.test', accountId: 'team-member' },
                action: { pluginId: PLUGIN_MANIFEST.id, localId },
                execution: action.execution,
                input: undefined,
                context: { surface: 'ui', authority: 'present_user' },
            }), localId).toBe(true);
        }
    } finally {
        Object.assign(Platform, { OS: previousPlatform });
    }
});
