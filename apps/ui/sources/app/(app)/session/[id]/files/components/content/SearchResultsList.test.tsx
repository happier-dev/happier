import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { select: (value: any) => value?.default ?? null },
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

describe('SearchResultsList', () => {
    it('does not render string children under View when searchQuery is empty', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SearchResultsList
                    theme={{ colors: { textSecondary: '#999', text: '#111', surfaceHigh: '#eee', divider: '#ddd', textLink: '#09f' } } as any}
                    isSearching={false}
                    searchQuery=""
                    searchResults={[]}
                    onFilePress={vi.fn()}
                />
            );
        });

        const rootView = tree!.root.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children ?? []);
        const hasPrimitiveChild = children.some((c) => typeof c === 'string' || typeof c === 'number');
        expect(hasPrimitiveChild).toBe(false);
    });
});
