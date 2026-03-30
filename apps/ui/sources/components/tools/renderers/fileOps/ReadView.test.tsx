import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolViewProps } from '@/dev/testkit';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { findTestInstanceByTypeWithProps } from '@/dev/testkit/render/renderScreen';


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
        tree = (await renderScreen(React.createElement(
                    ReadView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ))).tree;
        return tree;
    }

    it('truncates long reads by default', async () => {
        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content }),
        );

        const codeNode = findTestInstanceByTypeWithProps(tree, 'CodeView' as any, {});
        expect(codeNode).toBeTruthy();
        if (!codeNode) throw new Error('CodeView not found');
        expect(codeNode.props.code).toContain('line-0');
        expect(codeNode.props.code).toContain('line-19');
        expect(codeNode.props.code).not.toContain('line-20');

        // Ellipsis marker should be shown when truncated.
        expect(normalizedHostText(tree)).toContain('…');
    });

    it('shows substantially more content when detailLevel=full', async () => {
        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content }),
            'full',
        );

        const codeNode = findTestInstanceByTypeWithProps(tree, 'CodeView' as any, {});
        expect(codeNode).toBeTruthy();
        if (!codeNode) throw new Error('CodeView not found');
        expect(codeNode.props.code).toContain('line-0');
        expect(codeNode.props.code).toContain('line-99');
        expect(codeNode.props.code).not.toContain('…');

        expect(normalizedHostText(tree)).not.toContain('…');
    });

    it('renders string results and returns null for malformed completed payloads', async () => {
        const stringTree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, 'direct string result'),
        );
        const stringCodeNode = findTestInstanceByTypeWithProps(stringTree, 'CodeView' as any, {});
        expect(stringCodeNode).toBeTruthy();
        if (!stringCodeNode) throw new Error('CodeView not found');
        expect(stringCodeNode.props.code).toContain('direct string result');

        const malformedTree = await renderView(
            makeCompletedTool('Read', { file_path: '/tmp/a.txt' }, { content: 123 }),
        );
        expect(findTestInstanceByTypeWithProps(malformedTree, 'CodeView' as any, {})).toBeUndefined();
    });
});
