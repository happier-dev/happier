import { describe, expect, it } from 'vitest';

import { CONNECTED_SERVICES_BINDINGS_KEY } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

import { resolveCodexLockedBrowseSourceOption } from './resolveCodexLockedBrowseSourceOption';

describe('resolveCodexLockedBrowseSourceOption', () => {
    const userOption = {
        key: 'codex:user',
        label: 'user',
        source: { kind: 'codexHome', home: 'user' as const },
    } as const;

    const connectedOption = {
        key: 'codex:connected-service:openai-codex:work',
        label: 'connected',
        source: {
            kind: 'codexHome',
            home: 'connectedService' as const,
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
        },
    } as const;

    it('defaults to the user home when no connected service binding is selected', () => {
        const resolved = resolveCodexLockedBrowseSourceOption({
            sourceOptions: [userOption, connectedOption],
            agentOptionState: null,
        });

        expect(resolved).toEqual(userOption);
    });

    it('selects the connected service home when the binding is set for openai-codex', () => {
        const resolved = resolveCodexLockedBrowseSourceOption({
            sourceOptions: [userOption, connectedOption],
            agentOptionState: {
                [CONNECTED_SERVICES_BINDINGS_KEY]: {
                    'openai-codex': { source: 'connected', profileId: 'work' },
                },
            },
        });

        expect(resolved).toEqual(connectedOption);
    });

    it('falls back to user home when the connected profile id is not present in source options', () => {
        const resolved = resolveCodexLockedBrowseSourceOption({
            sourceOptions: [userOption, connectedOption],
            agentOptionState: {
                [CONNECTED_SERVICES_BINDINGS_KEY]: {
                    'openai-codex': { source: 'connected', profileId: 'missing' },
                },
            },
        });

        expect(resolved).toEqual(userOption);
    });
});
