import { describe, expect, it } from 'vitest';
import {
    resolveConnectedServiceProfileActionRoute,
} from './resolveConnectedServiceProfileActionRoute';

describe('resolveConnectedServiceProfileActionRoute', () => {
    const entries = [{
        serviceId: 'openai-codex',
        service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        },
        connectCommand: 'happier connect openai-codex',
        supportsOauth: true,
        executable: true,
    }] as const;

    it('routes every profile recovery action to the exact qualified account owner', () => {
        expect(resolveConnectedServiceProfileActionRoute(
            { serviceId: 'openai-codex', profileId: 'work' },
            entries,
        )).toEqual({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'work',
            },
        });
    });

    it('fails malformed, absent, and novel scalar aliases to the list', () => {
        for (const serviceId of ['', 'vault', 'not a service']) {
            expect(resolveConnectedServiceProfileActionRoute(
                { serviceId },
                entries,
            )).toEqual({
                pathname: '/(app)/settings/connected-services',
            });
        }
    });
});
