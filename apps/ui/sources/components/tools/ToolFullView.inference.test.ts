import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/sync/storage', () => ({
    useLocalSetting: () => false,
    useSetting: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

const renderedFullViewSpy = vi.fn();
const renderedViewSpy = vi.fn();

const getToolViewComponentSpy = vi.fn((toolName: string) => {
    if (toolName === 'execute') {
        return (props: any) => {
            renderedFullViewSpy(props);
            return React.createElement('FullToolView', { name: toolName });
        };
    }
    if (toolName === 'Read') {
        return (props: any) => {
            renderedViewSpy(props);
            return React.createElement('ToolView', { name: toolName });
        };
    }
    return null;
});

vi.mock('./views/_registry', () => ({
    getToolViewComponent: getToolViewComponentSpy,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        execute: { title: 'Terminal' },
        Read: { title: 'Read' },
    },
}));

vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolFullView (inference + view selection)', () => {
    it('uses tool.input._acp.kind to select a renderer and forces detailLevel=full', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'Run echo hello',
            input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
            result: { stdout: 'hello\n', stderr: '' },
            description: 'Run echo hello',
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));
        });

        expect(tree.root.findAllByType('FullToolView' as any)).toHaveLength(1);
        expect(renderedFullViewSpy).toHaveBeenCalled();
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('execute');
        expect(renderedFullViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'full' }));
    });

    it('renders the normal tool view component and forces detailLevel=full', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { content: 'hello' },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));
        });

        expect(tree.root.findAllByType('ToolView' as any)).toHaveLength(1);
        expect(renderedViewSpy).toHaveBeenCalled();
        expect(renderedFullViewSpy).not.toHaveBeenCalled();
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('Read');
        expect(renderedViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'full' }));
    });
});
