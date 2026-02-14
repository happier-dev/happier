import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { StructuredMessageBlock } from './StructuredMessageBlock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('StructuredMessageBlock', () => {
    it('returns null for unknown kinds', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <StructuredMessageBlock
                    message={{ meta: { happier: { kind: 'unknown.v1', payload: {} } } } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />,
            );
        });
        expect(tree!.toJSON()).toBeNull();
    });

    it('renders review comments card for valid payload', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <StructuredMessageBlock
                    message={{
                        meta: {
                            happier: {
                                kind: 'review_comments.v1',
                                payload: {
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
                                    ],
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />,
            );
        });

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('Review comments');
        expect(serialized).toContain('src/a.ts');
    });
});
