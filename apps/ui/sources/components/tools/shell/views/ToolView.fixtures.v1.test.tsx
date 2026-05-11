import React from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return mockSettings.detailLevelDefault;
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return mockSettings.detailLevelDefault;
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'full';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                },
            },
        }),
});

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('null')(importOriginal);
});

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

const renderedSummarySpy = vi.fn();
const renderedFullSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: (toolName: string) => (props: any) => {
        const detailLevel = props?.detailLevel ?? 'summary';
        if (detailLevel === 'full') {
            renderedFullSpy({ toolName, props });
            return React.createElement('FullToolView', { name: toolName });
        }
        renderedSummarySpy({ toolName, props });
        return React.createElement('SummaryToolView', { name: toolName });
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView', null),
}));

// Minimal known tool catalog for title rendering (we don't test tool-specific renderers here).
vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: { title: 'Terminal' },
        Read: { title: 'Read' },
        Diff: { title: 'Diff' },
        Patch: { title: 'Patch' },
        TodoWrite: { title: 'Todos' },
        Reasoning: { title: 'Reasoning' },
    },
}));

type ToolViewDetailLevel = 'title' | 'summary' | 'full';
const mockSettings: { detailLevelDefault: ToolViewDetailLevel } = { detailLevelDefault: 'summary' };

const fixtureTools: ReadonlyArray<Readonly<{ label: string; tool: ToolCall }>> = [
    {
        label: 'Bash',
        tool: makeToolCall({
            name: 'Bash',
            input: { command: "echo 'hi'" },
            result: { stdout: 'hi\n', exit_code: 0 },
        }),
    },
    {
        label: 'Read',
        tool: makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        }),
    },
    {
        label: 'Diff',
        tool: makeToolCall({
            name: 'Diff',
            input: { unified_diff: '--- a\n+++ b\n' },
            result: null,
        }),
    },
    {
        label: 'Patch',
        tool: makeToolCall({
            name: 'Patch',
            input: { changes: { 'a.txt': { insert: { line: 1, content: 'x' } } } },
            result: null,
        }),
    },
    {
        label: 'TodoWrite',
        tool: makeToolCall({
            name: 'TodoWrite',
            input: { todos: [{ id: '1', text: 'do thing', completed: false }] },
            result: { todos: [{ id: '1', text: 'do thing', completed: false }] },
        }),
    },
    {
        label: 'Reasoning',
        tool: makeToolCall({
            name: 'Reasoning',
            input: { content: 'thinking' },
            result: { content: 'ok' },
        }),
    },
] as const;

describe('ToolView fixtures (v1)', () => {
    beforeEach(() => {
        mockSettings.detailLevelDefault = 'summary';
        renderedSummarySpy.mockClear();
        renderedFullSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each(fixtureTools)('keeps $label in title mode without selecting a renderer', async ({ tool }) => {
        const { ToolView } = await import('./ToolView');

        renderedSummarySpy.mockClear();
        renderedFullSpy.mockClear();
        mockSettings.detailLevelDefault = 'title';

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(screen.findByTestId('tool-view-header-primary')).not.toBeNull();
        expect(renderedSummarySpy).not.toHaveBeenCalled();
        expect(renderedFullSpy).not.toHaveBeenCalled();
    });

    it.each(fixtureTools)('renders $label with the summary renderer in summary mode', async ({ tool }) => {
        const { ToolView } = await import('./ToolView');

        renderedSummarySpy.mockClear();
        renderedFullSpy.mockClear();
        mockSettings.detailLevelDefault = 'summary';

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(screen.findAllByType('SummaryToolView' as any)).toHaveLength(1);
        expect(renderedSummarySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                toolName: tool.name,
                props: expect.objectContaining({
                    detailLevel: 'summary',
                    tool: expect.objectContaining({ name: tool.name }),
                }),
            }),
        );
        expect(renderedFullSpy).not.toHaveBeenCalled();
    });

    it.each(fixtureTools)('renders $label with the full renderer in full mode', async ({ tool }) => {
        const { ToolView } = await import('./ToolView');

        renderedSummarySpy.mockClear();
        renderedFullSpy.mockClear();
        mockSettings.detailLevelDefault = 'full';

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(screen.findAllByType('FullToolView' as any)).toHaveLength(1);
        expect(renderedFullSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                toolName: tool.name,
                props: expect.objectContaining({
                    detailLevel: 'full',
                    tool: expect.objectContaining({ name: tool.name }),
                }),
            }),
        );
        expect(renderedSummarySpy).not.toHaveBeenCalled();
    });
});
