import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewCommentsMessageCard } from './ReviewCommentsMessageCard';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import { StructuredFindMessageProvider } from '@/components/sessions/transcript/structured/structuredFindText';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('ReviewCommentsMessageCard', () => {
    it('highlights a current match in snapshot context and releases its single-line clamp', async () => {
        const store = createTranscriptFindRowStore();
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <StructuredFindMessageProvider messageId="review-message">
                <ReviewCommentsMessageCard payload={{ sessionId: 's1', comments: [{
                    id: 'c1', filePath: 'src/a.ts', source: 'file', anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { beforeContext: ['long prefix needle suffix'], selectedLines: ['selected'], afterContext: [] },
                    body: 'body', createdAt: 1,
                }] }} />
            </StructuredFindMessageProvider>
        </TranscriptFindProvider>);
        await act(() => store.publish(new Map([['review-message', {
            blocks: [{ id: 'structured-review-comment:c1:before:0', sourceRanges: [{ start: 12, end: 18, current: true }] }],
            reveal: { blockId: 'structured-review-comment:c1:before:0', requestId: 1 },
        }]])));
        expect(screen.findByTestId('find-match-current')?.props.children).toBe('needle');
        const context = screen.tree.root.findAll((node) => String(node.type) === 'Text' && node.findAllByProps({ testID: 'find-match-current' }).length > 0);
        expect(context.length).toBeGreaterThan(0);
        expect(context.every((node) => node.props.numberOfLines === undefined)).toBe(true);
    });
    it('renders a header and file paths', async () => {
        const screen = await renderScreen(
            <ReviewCommentsMessageCard
                payload={{
                    sessionId: 's1',
                    comments: [
                        {
                            id: 'c1',
                            filePath: 'src/a.ts',
                            source: 'file',
                            anchor: { kind: 'fileLine', startLine: 1 },
                            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                            body: 'nit',
                            createdAt: 1,
                        },
                        {
                            id: 'c2',
                            filePath: 'src/b.ts',
                            source: 'diff',
                            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 2 },
                            snapshot: { selectedLines: ['y'], beforeContext: [], afterContext: [] },
                            body: 'nit2',
                            createdAt: 2,
                        },
                    ],
                }}
                onJumpToAnchor={() => {}}
            />,
        );

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Review comments (2)');
        expect(textContent).toContain('src/a.ts');
        expect(textContent).toContain('src/b.ts');
        expect(textContent).toContain('x');
        expect(textContent).toContain('nit');
        expect(screen.findByTestId('review-comments-jump:c1')).toBeTruthy();
    });
});
