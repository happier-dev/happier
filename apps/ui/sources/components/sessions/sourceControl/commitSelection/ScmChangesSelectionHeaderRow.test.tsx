import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: any) => {
        if (key === 'files.sourceControlOperations.selection') return `Selected ${params?.count ?? 0}`;
        if (key === 'files.repositoryChangedFiles') return `Total ${params?.count ?? 0}`;
        if (key === 'files.sourceControlOperations.clear') return 'Clear';
        if (key === 'common.all') return 'All';
        return key;
    },
}));

describe('ScmChangesSelectionHeaderRow', () => {
    it('renders selected/total and triggers All/None actions', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');
        const onSelectAll = vi.fn();
        const onSelectNone = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ScmChangesSelectionHeaderRow
                    theme={{ colors: { divider: '#000', textSecondary: '#aaa', textLink: '#09f', surfaceHigh: '#222' } }}
                    selectedCount={2}
                    totalCount={5}
                    onSelectAll={onSelectAll}
                    onSelectNone={onSelectNone}
                />
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any).map((n) => String(n.props.children));
        expect(textNodes.some((t) => t.includes('Selected 2'))).toBe(true);
        expect(textNodes.some((t) => t.includes('Total 5'))).toBe(true);

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBe(2);

        act(() => {
            pressables[0]!.props.onPress();
            pressables[1]!.props.onPress();
        });

        expect(onSelectAll).toHaveBeenCalledTimes(1);
        expect(onSelectNone).toHaveBeenCalledTimes(1);
    });

    it('does not render a noisy "Selected 0" line when nothing is selected', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ScmChangesSelectionHeaderRow
                    theme={{ colors: { divider: '#000', textSecondary: '#aaa', textLink: '#09f', surfaceHigh: '#222' } }}
                    selectedCount={0}
                    totalCount={5}
                />
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any).map((n) => String(n.props.children));
        expect(textNodes.some((t) => t.includes('Selected 0'))).toBe(false);
        expect(textNodes.some((t) => t.includes('Total 5'))).toBe(true);
    });
});
