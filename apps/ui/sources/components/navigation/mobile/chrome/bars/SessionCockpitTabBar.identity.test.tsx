import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentAssetLoader } from '@/dev/testkit/mocks/agentAssets';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { Metadata } from '@/sync/domains/state/storageTypes';

const sessionState = vi.hoisted(() => ({ metadata: null as Metadata | null }));

installNavigationCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit');
        return createStorageModuleStub({
            useSessionMetadata: () => sessionState.metadata,
            useSessionProjectScmStatus: () => null,
            useSetting: createUseSettingMock({ values: { tabBarShowLabels: true, tabBarSize: 'regular' } }),
        });
    },
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({}).module;
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

beforeEach(installAgentAssetLoader);

async function renderTabBar(metadata: Metadata | null) {
    sessionState.metadata = metadata;
    const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
    return renderScreen(<SessionCockpitTabBar
        sessionId="session-1"
        activeSurface="chat"
        terminalTabAvailable={false}
        openDetailsTabCount={0}
        onSurfacePress={() => {}}
    />);
}

describe('SessionCockpitTabBar identity', () => {
    it('uses a neutral mark and label when the existing Session identity is unknown', async () => {
        const screen = await renderTabBar({ path: '/repo', host: 'host' });

        expect(screen.tree.root.findByProps({ name: 'stack-simple' })).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-chat')?.props.accessibilityLabel).toBe('status.unknown');
    });

    it('uses declared Codex identity ahead of stale Claude flavor', async () => {
        const screen = await renderTabBar({
            path: '/repo',
            host: 'host',
            flavor: 'claude',
            agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } },
        });

        expect(screen.tree.root.findAll((node) => node.props.agentId === 'codex')).not.toHaveLength(0);
        expect(screen.findByTestId('session-cockpit-tab-chat')?.props.accessibilityLabel).toBe('agentInput.agent.codex');
    });
});
