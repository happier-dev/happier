import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { collectHostText, installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'full';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => React.createElement('CodeView', null),
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('fragment')(importOriginal);
});

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolView (unknown tools)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('collapses unknown tools to title-only by default (safe), even when global default is summary', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'SomeBrandNewTool',
            state: 'completed',
            input: { secret: 'should-not-render-inline' },
            result: { ok: true },
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(collectHostText(screen.tree).join(' ')).toContain('SomeBrandNewTool');
        // Body should be hidden because the tool is unknown and collapses to title-only.
        expect(screen.findAllByType('CodeView' as any)).toHaveLength(0);
    });
});
