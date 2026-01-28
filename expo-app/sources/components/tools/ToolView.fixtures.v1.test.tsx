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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('./views/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
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

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

const renderedSummarySpy = vi.fn();
const renderedFullSpy = vi.fn();

vi.mock('./views/_registry', () => ({
    getToolViewComponent: (toolName: string) => (props: any) => {
        renderedSummarySpy({ toolName, props });
        return React.createElement('SummaryToolView', { name: toolName });
    },
    getToolFullViewComponent: (toolName: string) => (props: any) => {
        renderedFullSpy({ toolName, props });
        return React.createElement('FullToolView', { name: toolName });
    },
}));

vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView', null),
}));

// Minimal known tool catalog for title rendering (we don't test tool-specific renderers here).
vi.mock('@/components/tools/knownTools', () => ({
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
let mockDetailLevelDefault: ToolViewDetailLevel = 'summary';

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return mockDetailLevelDefault;
        if (key === 'toolViewDetailLevelDefaultLocalControl') return mockDetailLevelDefault;
        if (key === 'toolViewDetailLevelByToolName') return {};
        return null;
    },
}));

describe('ToolView fixtures (v1)', () => {
    it('renders title/summary/full modes without crashing for common canonical tools', async () => {
        const { ToolView } = await import('./ToolView');

        const base: Omit<ToolCall, 'name' | 'input' | 'result'> = {
            state: 'completed',
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        const tools: ToolCall[] = [
            { ...base, name: 'Bash', input: { command: "echo 'hi'" }, result: { stdout: 'hi\n', exit_code: 0 } },
            { ...base, name: 'Read', input: { file_path: '/tmp/a.txt' }, result: { file: { content: 'hello' } } },
            { ...base, name: 'Diff', input: { unified_diff: '--- a\n+++ b\n' }, result: null },
            { ...base, name: 'Patch', input: { changes: { 'a.txt': { insert: { line: 1, content: 'x' } } } }, result: null },
            { ...base, name: 'TodoWrite', input: { todos: [{ id: '1', text: 'do thing', completed: false }] }, result: { todos: [{ id: '1', text: 'do thing', completed: false }] } },
            { ...base, name: 'Reasoning', input: { content: 'thinking' }, result: { content: 'ok' } },
        ];

        for (const tool of tools) {
            // title
            renderedSummarySpy.mockClear();
            renderedFullSpy.mockClear();
            mockDetailLevelDefault = 'title';
            let titleTree!: renderer.ReactTestRenderer;
            await act(async () => {
                titleTree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
            });
            expect(renderedSummarySpy).not.toHaveBeenCalled();
            expect(renderedFullSpy).not.toHaveBeenCalled();
            expect(titleTree.toJSON()).toBeTruthy();

            // summary
            renderedSummarySpy.mockClear();
            renderedFullSpy.mockClear();
            mockDetailLevelDefault = 'summary';
            let summaryTree!: renderer.ReactTestRenderer;
            await act(async () => {
                summaryTree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
            });
            expect(summaryTree.root.findAllByType('SummaryToolView' as any)).toHaveLength(1);
            expect(summaryTree.toJSON()).toBeTruthy();

            // full (prefer full-view component)
            renderedSummarySpy.mockClear();
            renderedFullSpy.mockClear();
            mockDetailLevelDefault = 'full';
            let fullTree!: renderer.ReactTestRenderer;
            await act(async () => {
                fullTree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
            });
            expect(fullTree.root.findAllByType('FullToolView' as any)).toHaveLength(1);
            expect(fullTree.toJSON()).toBeTruthy();
        }
    });
});
