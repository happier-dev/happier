import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { ReviewCommentsMessageCard } from './ReviewCommentsMessageCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ReviewCommentsMessageCard', () => {
    it('renders a header and file paths', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
        });

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('Review comments');
        expect(serialized).toContain('src/a.ts');
        expect(serialized).toContain('src/b.ts');
    });
});
