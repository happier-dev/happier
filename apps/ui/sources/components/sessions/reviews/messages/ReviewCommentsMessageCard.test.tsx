import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewCommentsMessageCard } from './ReviewCommentsMessageCard';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('ReviewCommentsMessageCard', () => {
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
        expect(screen.findByTestId('review-comments-jump:c1')).toBeTruthy();
    });
});
