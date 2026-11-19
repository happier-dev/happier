import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock({ translate: (key: string) => key })();
});

vi.mock('react-native-unistyles', async () => {
    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return installUnistylesMock()();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: React.Attributes & Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: React.Attributes & Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

afterEach(() => {
    standardCleanup();
});

describe('SessionListHeaderControls', () => {
    it('keeps typed search text visible while the parent search prop catches up', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchOpenChange={vi.fn()}
                onSearchQueryChange={onSearchQueryChange}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-list-search-input'),
                'onChangeText',
                'sta',
            );
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('sta');
        expect(screen.findByTestId('session-list-search-input')?.props.value).toBe('sta');
    });

    it('shows a clear button for a non-empty search when the trailing accessory is idle', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchOpenChange={vi.fn()}
                onSearchQueryChange={onSearchQueryChange}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        expect(screen.findByTestId('session-list-search-clear')).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-list-search-clear'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('');
    });

    it('does not keep the expanded search shell as a button around the clear button', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchOpenChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        expect(screen.findByTestId('session-list-search-trigger')?.props.accessibilityRole).toBeUndefined();
        expect(screen.findByTestId('session-list-search-trigger')?.props.onPress).toBeUndefined();
        expect(screen.findByTestId('session-list-search-clear')?.props.accessibilityRole).toBe('button');
    });

    it('keeps the clear button available while a search trailing accessory is active', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchOpenChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={<IoniconsTestNode />}
                viewMenu={null}
            />,
        );

        expect(screen.findByTestId('session-list-search-trailing-accessory-content')).toBeTruthy();
        expect(screen.findByTestId('session-list-search-clear')).toBeTruthy();
    });

    it('offers retry when transcript search failed', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onRetrySearch = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="needle"
                searchOpen={true}
                onSelectedTagsChange={vi.fn()}
                onSearchOpenChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchFailed={true}
                onRetrySearch={onRetrySearch}
                viewMenu={null}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('session-list-search-retry'), 'onPress');
        });

        expect(onRetrySearch).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-list-search-clear')).toBeTruthy();
    });

    it('keeps a fixed search trailing accessory slot when the accessory content changes', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const baseProps = {
            allKnownTags: [],
            selectedTags: [],
            searchQuery: 'vector',
            searchOpen: true,
            onSearchOpenChange: vi.fn(),
            onSelectedTagsChange: vi.fn(),
            onSearchQueryChange: vi.fn(),
            viewMenu: null,
        };

        const screen = await renderScreen(
            <SessionListHeaderControls
                {...baseProps}
                searchTrailingAccessory={<React.Fragment><IoniconsTestNode /></React.Fragment>}
            />,
        );
        const slot = screen.findByTestId('session-list-search-trailing-accessory');
        expect(slot).toBeTruthy();
        expect(screen.findByTestId('session-list-search-trailing-accessory-content')).toBeTruthy();
        const slotStyle = slot?.props?.style;

        await screen.update(
            <SessionListHeaderControls
                {...baseProps}
                searchTrailingAccessory={null}
            />,
        );

        const emptySlot = screen.findByTestId('session-list-search-trailing-accessory');
        expect(emptySlot).toBeTruthy();
        expect(emptySlot?.props?.style).toEqual(slotStyle);
        expect(screen.findAllByTestId('session-list-search-trailing-accessory-content')).toHaveLength(0);
    });
});

function IoniconsTestNode() {
    return React.createElement('View', { testID: 'session-list-search-trailing-accessory-content' });
}
