import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installAgentInputAssetLoader, installAgentInputCommonModuleMocks } from '../agentInput/agentInputTestHelpers';
import { createSessionFixture, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        return createStorageModuleStub({
            useSetting: createUseSettingMock({
                values: { ...settingsDefaults, showFlavorIcons: true, avatarStyle: 'gradient' },
            }),
        });
    },
});
beforeEach(installAgentInputAssetLoader);

function findAgentMarks(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAll((node) => typeof node.props.agentId === 'string');
}

describe('SessionListIdentity', () => {
    it.each(['agentLogo', 'avatar'] as const)('uses the declared runtime identity for %s despite stale flavor', async (display) => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo', host: 'test.local',
                flavor: 'claude',
                agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } },
            },
        });
        const screen = await renderScreen(
            <SessionListIdentity session={session} display={display} avatarSize={28} agentLogoSize={22} />,
        );
        expect(findAgentMarks(screen)[0].props.agentId).toBe('codex');
    });

    it('recognizes vendor-only identity without flavor', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({ metadata: { path: '/repo', host: 'test.local', codexSessionId: 'native-codex' } });
        const screen = await renderScreen(
            <SessionListIdentity session={session} display="agentLogo" avatarSize={28} agentLogoSize={22} />,
        );
        expect(findAgentMarks(screen)[0].props.agentId).toBe('codex');
    });

    it('omits the avatar provider badge when identity is unknown', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({ metadata: { path: '/repo', host: 'test.local' } });
        const screen = await renderScreen(
            <SessionListIdentity session={session} display="avatar" avatarSize={28} agentLogoSize={22} />,
        );
        expect(findAgentMarks(screen)).toHaveLength(0);
    });

    it('uses the session provider logo selected for session lists', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo', host: 'test.local',
                flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                avatarSize={28}
                agentLogoSize={22}
                testID="identity"
            />,
        );

        expect(findAgentMarks(screen)[0].props).toMatchObject({
            agentId: 'codex',
            size: 22,
            testID: 'identity',
        });
    });

    it('dims the provider logo for a monochrome identity, as the avatar is greyed', async () => {
        const { lightTheme } = await import('@/theme');
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({ metadata: { path: '/repo', host: 'test.local', flavor: 'codex' } });
        const render = (monochrome: boolean) => renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                avatarSize={28}
                agentLogoSize={22}
                monochrome={monochrome}
                color={lightTheme.colors.text.secondary}
            />,
        );

        const live = await render(false);
        expect(findAgentMarks(live)[0].props.color).toBe(lightTheme.colors.text.secondary);
        const stopped = await render(true);
        expect(findAgentMarks(stopped)[0].props.color).toBe(lightTheme.colors.text.tertiary);
    });

    it('uses a neutral mark when list-only metadata has no resolvable provider', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo', host: 'test.local',
                flavor: 'unknown-provider',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                avatarSize={28}
                agentLogoSize={22}
            />,
        );

        expect(findAgentMarks(screen)).toHaveLength(0);
        expect(screen.tree.root.findByProps({ name: 'stack-simple' })).toBeTruthy();
    });
});
