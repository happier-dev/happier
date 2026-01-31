import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', warning: '#f90', surfaceHigh: '#fff', surfaceHighest: '#fff' } } }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/agents/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Read: { title: 'Read' },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('./views/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'title';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewTapAction') return 'expand';
        if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
        if (key === 'toolViewExpandedDetailLevelByToolName') return {};
        return null;
    },
}));

vi.mock('@/utils/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('./views/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('./ToolSectionView', () => ({
    ToolSectionView: () => null,
}));

vi.mock('@/hooks/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

describe('ToolView (tap action: expand)', () => {
    it('toggles inline expansion even without navigation params', async () => {
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'Read',
            state: 'completed',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        expect(touchables.length).toBeGreaterThan(0);

        await act(async () => {
            touchables[0].props.onPress?.();
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });
});
