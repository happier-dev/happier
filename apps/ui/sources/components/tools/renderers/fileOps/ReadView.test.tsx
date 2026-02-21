import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('CodeView', { code }),
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('ReadView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { ReadView } = await import('./ReadView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    ReadView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('truncates long reads by default', async () => {
        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content }),
        );

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('line-0');
        expect(codeNodes[0].props.code).toContain('line-19');
        expect(codeNodes[0].props.code).not.toContain('line-20');

        // Ellipsis marker should be shown when truncated.
        expect(normalizedHostText(tree)).toContain('…');
    });

    it('shows substantially more content when detailLevel=full', async () => {
        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content }),
            'full',
        );

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('line-0');
        expect(codeNodes[0].props.code).toContain('line-99');
        expect(codeNodes[0].props.code).not.toContain('…');

        expect(normalizedHostText(tree)).not.toContain('…');
    });

    it('renders string results and returns null for malformed completed payloads', async () => {
        const stringTree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, 'direct string result'),
        );
        expect(stringTree.root.findAllByType('CodeView' as any)).toHaveLength(1);
        expect(stringTree.root.findAllByType('CodeView' as any)[0].props.code).toContain('direct string result');

        const malformedTree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content: 123 }),
        );
        expect(malformedTree.root.findAllByType('CodeView' as any)).toHaveLength(0);
    });
});
