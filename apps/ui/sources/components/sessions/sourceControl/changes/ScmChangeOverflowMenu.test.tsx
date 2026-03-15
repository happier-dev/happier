import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ScmChangeOverflowMenu', () => {
    it('includes copy-path action and optional reveal-in-tree action', async () => {
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                    onRevealInTree={() => {}}
                />
            );
        });

        const node = tree!.root.findByType('ItemRowActions' as any);
        expect(node.props.title).toBe('a.ts');
        expect(node.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(Array.isArray(node.props.actions)).toBe(true);

        const ids = node.props.actions.map((a: any) => a.id);
        expect(ids).toContain('copy_path');
        expect(ids).toContain('reveal_in_tree');
    });
});
