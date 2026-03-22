import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ReviewCommentsMessageCard } from './ReviewCommentsMessageCard';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('ReviewCommentsMessageCard', () => {
    it('renders a header and file paths', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ReviewCommentsMessageCard
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
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('Review comments');
        expect(serialized).toContain('src/a.ts');
        expect(serialized).toContain('src/b.ts');

        const findTextNode = (text: string) =>
            tree!.root.findAll((n: any) => n.type === 'Text' && n.props?.children === text)[0]!;
        expect(findTextNode('Review comments (2)').props.selectable).toBe(true);
        expect(findTextNode('src/a.ts').props.selectable).toBe(true);
        expect(
            tree!.root.findByProps({
                testID: 'review-comments-jump:c1',
                accessibilityRole: 'button',
            }),
        ).toBeDefined();
    });
});
