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
        legacyServiceId: 'openai-codex',
        connectCommand: 'happier connect openai-codex',
        supportsOauth: true,
        executable: true,
    }, {
        serviceId: 'reviewer-service',
        service: {
            pluginId: 'acme.review',
            localId: 'reviewer-service',
        },
        connectCommand: 'happier connect acme.review/reviewer-service',
        supportsOauth: false,
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

    it('routes canonical qualified service keys through the same public account owner', () => {
        expect(resolveConnectedServiceProfileActionRoute(
            { serviceId: 'happier.agent.codex/openai-codex', profileId: 'work' },
            entries,
        )).toEqual({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'work',
            },
        });
        expect(resolveConnectedServiceProfileActionRoute(
            { serviceId: 'happier.agent.codex/openai-codex' },
            entries,
        )).toEqual({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
        });
        expect(resolveConnectedServiceProfileActionRoute(
            { serviceId: 'acme.review/reviewer-service', profileId: 'reviewer' },
            entries,
        )).toEqual({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'acme.review',
                localId: 'reviewer-service',
                accountId: 'reviewer',
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
