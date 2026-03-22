import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';


type CapturedPathSelectorProps = Readonly<Record<string, unknown>>;
const capturedPathSelectorProps: CapturedPathSelectorProps[] = [];

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('./PathSelector', () => ({
    PathSelector: (props: CapturedPathSelectorProps) => {
        capturedPathSelectorProps.push(props);
        return null;
    },
}));

describe('NewSessionPathSelectionContent', () => {
    it('delegates the popover layout to PathSelector so the path field renders before the optional search block', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectorProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
                    machineHomeDir: '/home/me',
                    selectedPath: '/repo',
                    onChangeSelectedPath: vi.fn(),
                    recentPaths: ['/repo'],
                    usePickerSearch: true,
                    searchQuery: 'repo',
                    onChangeSearchQuery: vi.fn(),
                    favoriteDirectories: [],
                    onChangeFavoriteDirectories: vi.fn(),
                }));

        expect(capturedPathSelectorProps).toHaveLength(1);
        expect(capturedPathSelectorProps[0]).toMatchObject({
            usePickerSearch: true,
            searchVariant: 'belowInput',
            searchQuery: 'repo',
        });
    });
});
