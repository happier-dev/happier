import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const dropdownMenuSpy = vi.fn();
const setStorageFilterSpy = vi.hoisted(() => vi.fn());
const featureFlags = vi.hoisted(() => ({ externalSessionsEnabled: true }));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: React.Attributes & Record<string, unknown> & Readonly<{
        trigger?: (input: { toggle: () => void }) => React.ReactNode;
    }>) => {
        dropdownMenuSpy(props);
        return React.createElement('DropdownMenu', props, props.trigger?.({ toggle: vi.fn() }));
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

installSessionShellCommonModuleMocks({
    storage: async () => ({
        useLocalSettingMutable: (key: string) => {
            if (key === 'sessionsListStorageFilter') return ['direct', setStorageFilterSpy] as const;
            return [undefined, vi.fn()] as const;
        },
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct' && featureFlags.externalSessionsEnabled,
}));

afterEach(() => {
    standardCleanup();
    dropdownMenuSpy.mockClear();
    setStorageFilterSpy.mockClear();
    featureFlags.externalSessionsEnabled = true;
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

    it('persists storage filter selection and exposes the active-filter affordance', async () => {
        const { SessionListHeaderControls } = await import('./sessionListChrome');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.root.findByProps({ testID: 'session-list-ordering-menu-trigger' }).props.accessibilityState)
            .toEqual({ selected: true });
        expect(screen.root.findByProps({ testID: 'session-list-active-filter-indicator' })).toBeTruthy();

        const orderingMenuProps = dropdownMenuSpy.mock.calls
            .map(([props]) => props as { items?: Array<{ id: string }>; onSelect?: (id: string) => void })
            .find((props) => props.items?.some((item) => item.id === 'sessionListStorageFilterAll'));
        expect(orderingMenuProps).toBeTruthy();

        await act(async () => {
            orderingMenuProps?.onSelect?.('sessionListStorageFilterPersisted');
        });
        expect(setStorageFilterSpy).toHaveBeenCalledWith('persisted');
    });

    it('does not advertise a persisted external filter while the feature is disabled', async () => {
        featureFlags.externalSessionsEnabled = false;
        const { SessionListHeaderControls } = await import('./sessionListChrome');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={[]}
                selectedTags={[]}
                searchQuery=""
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.root.findByProps({ testID: 'session-list-ordering-menu-trigger' }).props.accessibilityState)
            .toEqual({ selected: false });
        expect(screen.root.findAllByProps({ testID: 'session-list-active-filter-indicator' })).toHaveLength(0);

        const orderingMenuProps = dropdownMenuSpy.mock.calls
            .map(([props]) => props as { items?: Array<{ id: string }> })
            .find((props) => props.items?.some((item) => item.id === 'custom'));
        expect(orderingMenuProps?.items?.some((item) => item.id.startsWith('sessionListStorageFilter'))).toBe(false);
    });
});
