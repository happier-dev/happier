import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureEnabledMock = vi.fn(() => true);

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => useFeatureEnabledMock(),
}));

vi.mock('@/components/settings/mcpServers/McpServersSettingsScreen', () => ({
    McpServersSettingsScreen: () => React.createElement('McpServersSettingsScreen'),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('MCP settings route (feature gate)', () => {
    beforeEach(() => {
        vi.resetModules();
        useFeatureEnabledMock.mockClear();
    });

    it('returns null when mcp.servers feature is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);

        const mod = await import('@/app/(app)/settings/mcp');
        const McpRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(McpRoute))).tree;

        expect(tree.toJSON()).toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
    });

    it('renders McpServersSettingsScreen when mcp.servers feature is enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);

        const mod = await import('@/app/(app)/settings/mcp');
        const McpRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(McpRoute))).tree;

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
        const screen = tree.root.findByType('McpServersSettingsScreen' as any);
        expect(screen).toBeTruthy();
    });
});

