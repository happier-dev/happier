import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';


type CapturedPathSelectionListProps = Readonly<Record<string, unknown>>;
const capturedPathSelectionListProps: CapturedPathSelectionListProps[] = [];
const itemListMountSpy = vi.fn();

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => {
        itemListMountSpy();
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('./PathSelectionList', () => ({
    PathSelectionList: (props: CapturedPathSelectionListProps) => {
        capturedPathSelectionListProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/selectionList', () => ({
    resolvePopoverSelectionListHeightBehavior: (preferred?: string) => (
        preferred === 'fixedToMaxHeight' ? 'fixedToMaxHeight' : 'measuredToMaxHeight'
    ),
}));

describe('NewSessionPathSelectionContent', () => {
    it('delegates path choices to PathSelectionList with favorites and recents normalized to row entries', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/home/me',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: ['/repo'],
                    usePickerSearch: true,
                    searchQuery: 'repo',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: ['~/code'],
                    onChangeFavoriteDirectories: vi.fn(),
                }));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect(capturedPathSelectionListProps[0]).toMatchObject({
            initialValue: '/repo',
            machineHomeDir: '/home/me',
            favorites: [{ path: '~/code' }],
            recents: [{ path: '/repo', lastUsedAt: 0 }],
        });
    });

    it('omits recent path entries that resolve to visible favorites and dedupes recent variants', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/Users/leeroy',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: [
                        '/Users/leeroy/proj',
                        '/Users/leeroy/recent',
                        '~/recent',
                    ],
                    usePickerSearch: true,
                    searchQuery: '',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: ['~/proj'],
                    onChangeFavoriteDirectories: vi.fn(),
                }));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const captured = capturedPathSelectionListProps[0] as {
            favorites?: ReadonlyArray<{ path: string }>;
            recents?: ReadonlyArray<{ path: string }>;
        };
        expect(captured.favorites?.map((entry) => entry.path)).toEqual(['~/proj']);
        expect(captured.recents?.map((entry) => entry.path)).toEqual(['/Users/leeroy/recent']);
    });

    it('updates favorite rows immediately while the popover stays mounted', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;
        const onChangeFavoriteDirectories = vi.fn();

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/Users/leeroy',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: ['/Users/leeroy/recent'],
                    usePickerSearch: true,
                    searchQuery: '',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: [],
                    onChangeFavoriteDirectories,
                }));

        const initial = capturedPathSelectionListProps[0] as {
            favorites?: ReadonlyArray<{ path: string }>;
            isFavorite?: (path: string) => boolean;
            onToggleFavorite?: (path: string) => void;
            recents?: ReadonlyArray<{ path: string }>;
        };
        expect(initial.favorites).toEqual([]);
        expect(initial.recents?.map((entry) => entry.path)).toEqual(['/Users/leeroy/recent']);
        expect(initial.isFavorite?.('/Users/leeroy/recent')).toBe(false);

        await act(async () => {
            initial.onToggleFavorite?.('/Users/leeroy/recent');
        });

        expect(onChangeFavoriteDirectories).toHaveBeenCalledWith(['/Users/leeroy/recent']);
        const afterAdd = capturedPathSelectionListProps.at(-1) as typeof initial;
        expect(afterAdd.favorites?.map((entry) => entry.path)).toEqual(['/Users/leeroy/recent']);
        expect(afterAdd.recents).toEqual([]);
        expect(afterAdd.isFavorite?.('/Users/leeroy/recent')).toBe(true);

        await act(async () => {
            afterAdd.onToggleFavorite?.('/Users/leeroy/recent');
        });

        expect(onChangeFavoriteDirectories).toHaveBeenLastCalledWith([]);
        const afterRemove = capturedPathSelectionListProps.at(-1) as typeof initial;
        expect(afterRemove.favorites).toEqual([]);
        expect(afterRemove.recents?.map((entry) => entry.path)).toEqual(['/Users/leeroy/recent']);
        expect(afterRemove.isFavorite?.('/Users/leeroy/recent')).toBe(false);
    });

    it('forwards draft path edits to PathSelectionList before commit', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;
        const onChangeDraftSelectedPath = vi.fn();

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/home/me',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    onChangeDraftSelectedPath,
                    recentPaths: [],
                    usePickerSearch: true,
                    searchQuery: '',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: [],
                    onChangeFavoriteDirectories: vi.fn(),
                }));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const onChangeDraftPath = (capturedPathSelectionListProps[0] as any).onChangeDraftPath;
        expect(typeof onChangeDraftPath).toBe('function');

        onChangeDraftPath('/repo/custom/subdir');

        expect(onChangeDraftSelectedPath).toHaveBeenCalledWith('/repo/custom/subdir');
    });

    it('lets PathSelectionList own native measured popover sizing and forwards the available maxHeight', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;
        itemListMountSpy.mockClear();

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/home/me',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: [],
                    usePickerSearch: true,
                    searchQuery: '',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: [],
                    onChangeFavoriteDirectories: vi.fn(),
                    maxHeight: 456,
                }));

        expect(itemListMountSpy).not.toHaveBeenCalled();
        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect((capturedPathSelectionListProps[0] as any).maxHeight).toBe(456);
        expect(capturedPathSelectionListProps[0]?.heightBehavior).toBe('measuredToMaxHeight');
    });

    it('forwards history-first suggestion mode to PathSelectionList when requested by a popover caller', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/home/me',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: [],
                    usePickerSearch: true,
                    searchQuery: '',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: [],
                    onChangeFavoriteDirectories: vi.fn(),
                    initialSuggestionMode: 'history',
                }));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect(capturedPathSelectionListProps[0]).toMatchObject({
            initialSuggestionMode: 'history',
        });
    });
});
