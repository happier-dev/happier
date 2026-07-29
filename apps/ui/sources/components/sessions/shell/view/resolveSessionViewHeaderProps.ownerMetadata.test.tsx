import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

describe('resolveSessionViewHeaderProps owner metadata', () => {
    it('uses the layout-v1 owner compatibility view for the private workspace subtitle', () => {
        const session = createSessionFixture({
            id: 'layout-v1-session',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            } as never,
            ownerMetadataView: {
                path: '/Users/private/project',
                host: 'private-host',
                homeDir: '/Users/private',
                machineId: 'private-machine',
            },
        });

        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/layout-v1-session/info',
            sessionRunsHref: '/session/layout-v1-session/runs',
            sessionAutomationsHref: '/session/layout-v1-session/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
        });

        expect(result.subtitle).toBe('~/project');
    });
});
