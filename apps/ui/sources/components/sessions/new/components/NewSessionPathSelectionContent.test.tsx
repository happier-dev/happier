import * as React from 'react';
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

    it('lets PathSelectionList own the popover body scroll and forwards the available maxHeight', async () => {
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
    });
});
