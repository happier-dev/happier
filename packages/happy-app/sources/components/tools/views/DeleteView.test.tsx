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
    useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#999', surfaceHigh: '#eee' } } }),
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('DeleteView', () => {
    it('shows a compact subset of deleted files by default', async () => {
        const { DeleteView } = await import('./DeleteView');

        const tool: ToolCall = {
            name: 'Delete',
            state: 'completed',
            input: { file_paths: Array.from({ length: 10 }, (_, i) => `file-${i}.txt`) } as any,
            result: { deleted: true } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(DeleteView, { tool, metadata: null } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('file-0.txt');
        expect(renderedText).toContain('file-7.txt');
        expect(renderedText).not.toContain('file-8.txt');
        expect(renderedText).toContain('+2 more');
    });

    it('renders all deleted files in full view', async () => {
        const { DeleteView } = await import('./DeleteView');

        const tool: ToolCall = {
            name: 'Delete',
            state: 'completed',
            input: { file_paths: Array.from({ length: 10 }, (_, i) => `file-${i}.txt`) } as any,
            result: { deleted: true } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(DeleteView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('file-0.txt');
        expect(renderedText).toContain('file-9.txt');
        expect(renderedText).not.toContain('+2 more');
    });
});

