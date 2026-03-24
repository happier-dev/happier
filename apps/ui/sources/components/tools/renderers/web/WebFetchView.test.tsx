import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolViewProps } from '@/dev/testkit';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('CodeView', { code }),
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('WebFetchView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WebFetchView } = await import('./WebFetchView');
        return renderScreen(React.createElement(
            WebFetchView,
            makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
        ));
    }

    it('shows HTTP status when present', async () => {
        const screen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: 'ok' }),
        );
        const renderedText = normalizedHostText(screen.tree);
        expect(renderedText).toContain('HTTP 200');
    });

    it('does not truncate content when detailLevel=full', async () => {
        const longText = 'x'.repeat(3000);
        const screen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: longText }),
            'full',
        );

        const codeNodes = screen.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toBe(longText);
    });

    it('supports plain-string result payloads and returns null when both url and text are missing', async () => {
        const stringScreen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, 'plain body'),
        );
        const codeNodes = stringScreen.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('plain body');

        const emptyScreen = await renderView(
            makeCompletedTool('WebFetch', {}, { status: 204 }),
        );
        expect(emptyScreen.findAllByType('Text' as any)).toHaveLength(0);
    });
});
