import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureEnabledMock = vi.fn(() => true);

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => useFeatureEnabledMock(),
}));

vi.mock('@/components/settings/mcpServers/McpServersSettingsScreen', () => ({
    McpServersSettingsScreen: () => React.createElement('McpServersSettingsScreen'),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: (props: any) => React.createElement('StackScreen', props),
    },
}));

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
        await act(async () => {
            tree = renderer.create(React.createElement(McpRoute));
        });

        expect(tree.toJSON()).toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
    });

    it('renders McpServersSettingsScreen when mcp.servers feature is enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);

        const mod = await import('@/app/(app)/settings/mcp');
        const McpRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpRoute));
        });

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
        const screen = tree.root.findByType('McpServersSettingsScreen' as any);
        expect(screen).toBeTruthy();
    });
});

