import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/FileIcon', () => ({
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
    it('renders file and folder entries and only makes files pressable', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const onFilePress = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SearchResultsList
                    theme={{ colors: { surfaceHigh: '#111', divider: '#222', textLink: '#09f', textSecondary: '#999' } } as any}
                    isSearching={false}
                    searchQuery="abc"
                    searchResults={[
                        { fileName: 'src', filePath: '', fullPath: 'src', fileType: 'folder' },
                        { fileName: 'a.ts', filePath: 'src', fullPath: 'src/a.ts', fileType: 'file' },
                    ]}
                    onFilePress={onFilePress}
                />
            );
        });

        const items = tree!.root.findAllByType('Item' as any);
        expect(items).toHaveLength(2);

        expect(items[0]!.props.onPress).toBeUndefined();
        act(() => {
            items[1]!.props.onPress();
        });
        expect(onFilePress).toHaveBeenCalledTimes(1);
        expect(onFilePress).toHaveBeenCalledWith(
            expect.objectContaining({ fullPath: 'src/a.ts', fileType: 'file' })
        );
    });
});
