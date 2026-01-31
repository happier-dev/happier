import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const diffSpy = vi.fn();
vi.mock('@/components/tools/ToolDiffView', () => ({
    ToolDiffView: (props: any) => {
        diffSpy(props);
        return React.createElement('ToolDiffView', props);
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        return undefined;
    },
}));

describe('WriteView', () => {
    it('truncates long writes by default', async () => {
        diffSpy.mockClear();
        const { WriteView } = await import('./WriteView');

        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Write',
            state: 'completed',
            input: { file_path: '/tmp/a.txt', content } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(WriteView as any, { tool, metadata: null }));
        });

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const last = diffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-19');
        expect(last.newText).not.toContain('line-20');
    });

    it('shows substantially more content when detailLevel=full', async () => {
        diffSpy.mockClear();
        const { WriteView } = await import('./WriteView');

        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Write',
            state: 'completed',
            input: { file_path: '/tmp/a.txt', content } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(WriteView as any, { tool, metadata: null, detailLevel: 'full' }));
        });

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const last = diffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-99');
    });

    it('renders a one-line preview when detailLevel=title', async () => {
        diffSpy.mockClear();
        const { WriteView } = await import('./WriteView');

        const content = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Write',
            state: 'completed',
            input: { file_path: '/tmp/a.txt', content } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WriteView as any, { tool, metadata: null, detailLevel: 'title' }));
        });

        expect(diffSpy).toHaveBeenCalledTimes(0);
        const textNodes = tree.root.findAllByType('Text' as any);
        expect(textNodes.map((n) => String(n.props.children)).join('')).toContain('line-0');
    });
});

