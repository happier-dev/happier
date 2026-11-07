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
    it('shows the search field without an open step and no clear button while empty', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        const input = screen.findByTestId('session-list-search-input');
        expect(input).toBeTruthy();
        expect(input?.props.autoFocus).not.toBe(true);
        expect(screen.findAllByTestId('session-list-search-trigger')).toHaveLength(0);
        expect(screen.findByTestId('session-list-search-clear')).toBeNull();
    });

    it('keeps typed search text visible while the parent search prop catches up', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                onSelectedTagsChange={vi.fn()}
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

    it('clears the search from the clear button and keeps the field mounted', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={onSearchQueryChange}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        const clear = screen.findByTestId('session-list-search-clear');
        expect(clear?.props.accessibilityRole).toBe('button');

        await act(async () => {
            invokeTestInstanceHandler(clear, 'onPress', { stopPropagation: vi.fn() });
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('');
        expect(screen.findByTestId('session-list-search-input')?.props.value).toBe('');
    });

    it('clears the search on Escape', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={onSearchQueryChange}
                searchTrailingAccessory={null}
                viewMenu={null}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-list-search-input'),
                'onKeyPress',
                { nativeEvent: { key: 'Escape' } },
            );
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('');
    });

    it('keeps the clear button hidden while a search trailing accessory is active', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery="memory"
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={<IoniconsTestNode />}
                viewMenu={null}
            />,
        );

        expect(screen.findByTestId('session-list-search-trailing-accessory-content')).toBeTruthy();
        expect(screen.findByTestId('session-list-search-clear')).toBeNull();
    });

    it('keeps a fixed search trailing accessory slot when the accessory content changes', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const baseProps = {
            allKnownTags: [],
            selectedTags: [],
            searchQuery: 'vector',
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
