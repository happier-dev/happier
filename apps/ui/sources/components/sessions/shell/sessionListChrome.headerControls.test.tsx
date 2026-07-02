import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const dropdownMenuSpy = vi.fn();

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: React.Attributes & Record<string, unknown>) => {
        dropdownMenuSpy(props);
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

installSessionShellCommonModuleMocks();

afterEach(() => {
    standardCleanup();
    dropdownMenuSpy.mockClear();
});

describe('SessionListHeaderControls', () => {
    it('keeps typed search text visible while the parent search prop catches up', async () => {
        const { SessionListHeaderControls } = await import('./sessionListChrome');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={onSearchQueryChange}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(
                screen.root.findByProps({ testID: 'session-list-search-input' }),
                'onChangeText',
                'sta',
            );
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('sta');
        expect(screen.root.findByProps({ testID: 'session-list-search-input' }).props.value).toBe('sta');
    });

    it('does not keep the expanded search shell as a button around search content', async () => {
        const { SessionListHeaderControls } = await import('./sessionListChrome');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="vector"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
            />,
        );

        const shell = screen.root.findByProps({ testID: 'session-list-search-trigger' });

        expect(shell.props.accessibilityRole).toBeUndefined();
        expect(shell.props.onPress).toBeUndefined();
    });

    it('renders the search trailing accessory in a stable hidden slot when search is open', async () => {
        const { SessionListHeaderControls } = await import('./sessionListChrome');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="vector"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={React.createElement('ActivityIndicator', {
                    testID: 'session-list-memory-search-loading-indicator',
                })}
            />,
        );

        const slot = screen.root.findByProps({ testID: 'session-list-search-trailing-accessory' });

        expect(slot.props.pointerEvents).toBe('none');
        expect(slot.props.accessibilityElementsHidden).toBe(true);
        expect(slot.findByProps({ testID: 'session-list-memory-search-loading-indicator' })).toBeTruthy();
    });
});
