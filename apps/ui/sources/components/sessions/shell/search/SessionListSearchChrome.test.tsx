import React from 'react';
import { Animated, Platform } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';

const dropdownMenuSpy = vi.fn();
const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotion.value,
}));

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
        useLocalSettingMutable: () => [undefined, vi.fn()] as const,
    }),
});

/** The outermost node carrying a test id (an IconButton passes its id down to its pressable). */
function firstByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
    const [node] = root.findAllByProps({ testID });
    if (!node) throw new Error(`missing ${testID}`);
    return node;
}

/** The text input itself: the innermost node carrying the input's test id. */
function inputOf(root: ReactTestInstance): ReactTestInstance {
    const nodes = root.findAllByProps({ testID: 'session-list-search-input' });
    const node = nodes[nodes.length - 1];
    if (!node) throw new Error('missing session-list-search-input');
    return node;
}

afterEach(() => {
    standardCleanup();
    dropdownMenuSpy.mockClear();
    reducedMotion.value = false;
});

describe('SessionListSearchChrome', () => {
    it('keeps the canonical corpus filter control beside the stable search field', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                filterControl={<Text testID="filter-control">My work</Text>}
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.findByTestId('filter-control')).toBeDefined();
        expect(firstByTestId(screen.root, 'session-list-search-trigger')).toBeDefined();
    });

    it('shows an active facet as a chip under the title that turns off only that facet', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const { buildSessionListActiveFilterChips } = await import('./SessionListFilterControl');
        const { createSessionListViewFilterDefaults } = await import('./sessionListViewFilters');
        const filters = createSessionListViewFilterDefaults({ scope: 'following', coordinator: 'coordinator', homeServerIds: ['home-a'] });
        const updateFilters = vi.fn();
        const chips = (current: typeof filters) => buildSessionListActiveFilterChips({ filters: current, updateFilters }, null);
        expect(chips({ ...filters, coordinator: undefined })).toEqual([]);

        const screen = await renderScreen(
            <SessionListSearchChrome
                filterControl={<Text testID="filter-control">Following</Text>}
                filterChips={chips(filters)}
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />,
        );
        const chip = firstByTestId(screen.root, 'session-list-filter-chip-coordinator');
        await invokeTestInstanceHandler(chip, 'onPress');
        const update = updateFilters.mock.calls[0]?.[0] as (current: typeof filters) => typeof filters;
        const next = update(filters);
        expect(next.coordinator).toBeUndefined();
        expect(next).toMatchObject({ scope: 'following', homeServerIds: ['home-a'] });
    });

    it('renders the query from its single owner without a second local echo state', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="sta"
                onSearchQueryChange={onSearchQueryChange}
            />,
        );

        const input = inputOf(screen.root);
        expect(input.props.value).toBe('sta');

        await act(async () => {
            invokeTestInstanceHandler(input, 'onChangeText', 'stab');
        });

        expect(onSearchQueryChange).toHaveBeenCalledWith('stab');
        // The chrome does not shadow the query: an unchanged prop keeps the rendered value.
        expect(inputOf(screen.root).props.value).toBe('sta');
    });

    it('offers an interactive Search everything escalation carrying the current query', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const onSearchEverything = vi.fn();
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="  vector  "
                onSearchQueryChange={vi.fn()}
                onSearchEverything={onSearchEverything}
            />,
        );

        const escalation = screen.root.findByProps({ testID: 'session-list-search-everything' });
        expect(escalation.props.accessibilityRole).toBe('button');
        expect(escalation.props.pointerEvents).not.toBe('none');

        await act(async () => {
            escalation.props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(onSearchEverything).toHaveBeenCalledWith('vector');
    });

    it('keeps local escalation available beside a polite retryable search-source status', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const onRetrySearch = vi.fn();
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="vector"
                searchStatus={{
                    message: 'Transcript search is temporarily unavailable.',
                    onRetry: onRetrySearch,
                }}
                onSearchQueryChange={vi.fn()}
                onSearchEverything={vi.fn()}
            />,
        );

        const status = screen.root.findByProps({ testID: 'session-list-search-status' });
        expect(status.props.accessibilityLiveRegion).toBe('polite');
        expect(status.props.role).toBe('status');
        expect(screen.root.findByProps({ testID: 'session-list-search-everything' })).toBeDefined();

        const retry = screen.root.findByProps({ testID: 'session-list-search-retry' });
        expect(retry.props.accessibilityRole).toBe('button');
        await act(async () => retry.props.onPress?.({ stopPropagation: vi.fn() }));
        expect(onRetrySearch).toHaveBeenCalledOnce();
    });

    it('labels the exact Home searched for transcript and Other matches results', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="vector"
                searchScopeLabel="Server: Studio Home"
                onSearchQueryChange={vi.fn()}
            />,
        );

        const scope = screen.root.findByProps({ testID: 'session-list-search-scope' });
        expect(scope.props.accessibilityLiveRegion).toBe('polite');
        expect(scope.findByType(Text).props.children).toBe('Server: Studio Home');
    });

    it('does not show transcript scope when there is no active query', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery=""
                searchScopeLabel="Server: Studio Home"
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.root.findAllByProps({ testID: 'session-list-search-scope' })).toHaveLength(0);
    });

    it('hides the escalation while the contextual query is empty', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery=""
                onSearchQueryChange={vi.fn()}
                onSearchEverything={vi.fn()}
            />,
        );

        expect(screen.root.findAllByProps({ testID: 'session-list-search-everything' })).toHaveLength(0);
    });

    it('keeps the search toggle a button beside the open field, never around it', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="vector"
                onSearchQueryChange={vi.fn()}
            />,
        );

        const toggle = firstByTestId(screen.root, 'session-list-search-trigger');
        expect(toggle.props.accessibilityLabel).toBe('sessionsList.searchSessions');
        expect(toggle.props.selected).toBe(true);
        expect(toggle.findAllByProps({ testID: 'session-list-search-input' })).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'session-list-search-input' }).length).toBeGreaterThan(0);
    });

    it('closes search from one trailing close button that clears the query', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');

        function Harness() {
            const [query, setQuery] = React.useState('vector');
            return (
                <SessionListSearchChrome
                    searchQuery={query}
                    onSearchQueryChange={setQuery}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        // One dismiss action: no separate "clear" beside a "collapse" chevron.
        expect(screen.root.findAllByProps({ testID: 'session-list-search-clear' })).toHaveLength(0);
        const field = firstByTestId(screen.root, 'session-list-search-input.field');
        const close = firstByTestId(field, 'session-list-search-close');
        expect(close.props.accessibilityLabel).toBe('sessionsList.closeSearch');
        // Trailing: the close control comes after the input inside the field.
        const order = field.findAll((node) => (
            node.props.testID === 'session-list-search-input' || node.props.testID === 'session-list-search-close'
        )).map((node) => node.props.testID);
        expect(order.indexOf('session-list-search-input')).toBeLessThan(order.indexOf('session-list-search-close'));

        await act(async () => {
            close.props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(screen.root.findAllByProps({ testID: 'session-list-search-input' })).toHaveLength(0);
        expect(firstByTestId(screen.root, 'session-list-search-trigger').props.selected).toBe(false);
    });

    it('closes search and clears the query on Escape', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const onSearchQueryChange = vi.fn();

        function Harness() {
            const [query, setQuery] = React.useState('');
            return (
                <SessionListSearchChrome
                    searchQuery={query}
                    onSearchQueryChange={(next) => {
                        onSearchQueryChange(next);
                        setQuery(next);
                    }}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        await act(async () => {
            firstByTestId(screen.root, 'session-list-search-trigger').props.onPress?.();
        });
        const input = inputOf(screen.root);
        await act(async () => {
            invokeTestInstanceHandler(input, 'onChangeText', 'vec');
        });
        await act(async () => {
            invokeTestInstanceHandler(inputOf(screen.root), 'onKeyPress', {
                nativeEvent: { key: 'Escape' },
            });
        });

        expect(onSearchQueryChange).toHaveBeenLastCalledWith('');
        expect(screen.root.findAllByProps({ testID: 'session-list-search-input' })).toHaveLength(0);
    });

    it('toggles search closed from the header search button', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const onSearchQueryChange = vi.fn();
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery=""
                onSearchQueryChange={onSearchQueryChange}
            />,
        );

        await act(async () => {
            firstByTestId(screen.root, 'session-list-search-trigger').props.onPress?.();
        });
        expect(screen.root.findAllByProps({ testID: 'session-list-search-input' }).length).toBeGreaterThan(0);

        await act(async () => {
            firstByTestId(screen.root, 'session-list-search-trigger').props.onPress?.();
        });
        expect(screen.root.findAllByProps({ testID: 'session-list-search-input' })).toHaveLength(0);
    });

    it('renders the search trailing accessory in a stable hidden slot when search is open', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="vector"
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

    it('keeps the same input instance when an async search accessory publishes', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const baseProps = {
            searchQuery: 'vector',
            onSearchQueryChange: vi.fn(),
        };
        const screen = await renderScreen(<SessionListSearchChrome {...baseProps} />);
        const inputBeforePublication = inputOf(screen.root);

        await act(async () => {
            await screen.update(
                <SessionListSearchChrome
                    {...baseProps}
                    searchTrailingAccessory={React.createElement('ActivityIndicator')}
                />,
            );
        });

        expect(inputOf(screen.root)).toBe(inputBeforePublication);
    });

    it('keeps the opened input mounted when clear is followed by an incidental native blur', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');

        function Harness() {
            const [query, setQuery] = React.useState('');
            return (
                <SessionListSearchChrome
                    searchQuery={query}
                    onSearchQueryChange={setQuery}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        await act(async () => {
            firstByTestId(screen.root, 'session-list-search-trigger').props.onPress?.();
        });
        const openedInput = inputOf(screen.root);

        await act(async () => {
            invokeTestInstanceHandler(openedInput, 'onFocus');
            invokeTestInstanceHandler(openedInput, 'onChangeText', 'v');
        });
        await act(async () => {
            invokeTestInstanceHandler(openedInput, 'onChangeText', '');
            invokeTestInstanceHandler(openedInput, 'onBlur');
        });

        expect(inputOf(screen.root)).toBe(openedInput);
    });

    it('keeps source filtering in the corpus editor instead of View options', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.root.findByProps({ testID: 'session-list-view-options-trigger' })).toBeTruthy();
        expect(screen.root.findAllByProps({ testID: 'session-list-active-filter-indicator' })).toHaveLength(0);

        const viewOptionsProps = dropdownMenuSpy.mock.calls
            .map(([props]) => props as { items?: Array<{ id: string }> })
            .find((props) => props.items?.some((item) => item.id.startsWith('layout:')));
        expect(viewOptionsProps?.items?.some((item) => item.id.startsWith('sessionListStorageFilter'))).toBe(false);
    });

    it('lets the open field use the available width without fixing its height', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery="responsive"
                onSearchQueryChange={vi.fn()}
                onSearchEverything={vi.fn()}
            />,
        );
        const flatten = (style: unknown): Record<string, unknown> => (
            Array.isArray(style)
                ? style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flatten(entry) }), {})
                : (style as Record<string, unknown> | null) ?? {}
        );

        const fieldStyle = flatten(firstByTestId(screen.root, 'session-list-search-input.field').props.style);
        expect(fieldStyle.width).toBeUndefined();
        expect(fieldStyle.height).toBeUndefined();

        const inputStyle = flatten(inputOf(screen.root).props.style);
        expect(inputStyle.height).toBeUndefined();
        expect(inputStyle.lineHeight).toBeUndefined();

        const escalation = screen.root.findByProps({ testID: 'session-list-search-everything' });
        // The row keeps its design height (padding around one line); a finger reaches it through the hit area.
        expect(flatten(escalation.props.style).minHeight).toBeUndefined();
        expect(escalation.findByType(Text).props.numberOfLines).toBeUndefined();
    });

    it('makes search expansion immediate when Reduced Motion is enabled', async () => {
        reducedMotion.value = true;
        const timingSpy = vi.spyOn(Animated, 'timing');
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />,
        );

        await act(async () => {
            firstByTestId(screen.root, 'session-list-search-trigger').props.onPress?.();
        });

        expect(timingSpy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ duration: 0 }));
        timingSpy.mockRestore();
    });

    it('on a phone tab page folds the shell line and glyphs into one nav row above the large title', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const { PhoneTabNavRowProvider } = await import('@/components/navigation/shell/phoneTabNavRow');
        const screen = await renderScreen(
            <PhoneTabNavRowProvider
                leading={<Text testID="shell-home-line">Personal Home</Text>}
                trailing={<Text testID="shell-glyphs">glyphs</Text>}
            >
                <SessionListSearchChrome
                    filterControl={<Text testID="filter-control">My work</Text>}
                    searchQuery=""
                    onSearchQueryChange={vi.fn()}
                />
            </PhoneTabNavRowProvider>,
        );

        const navRow = firstByTestId(screen.root, 'session-list-phone-nav-row');
        for (const id of ['shell-home-line', 'session-list-search-trigger', 'session-list-view-options-trigger', 'shell-glyphs']) {
            expect(navRow.findAllByProps({ testID: id }).length).toBeGreaterThan(0);
        }
        // The title is its own row under the nav row, never beside its controls.
        expect(navRow.findAllByProps({ testID: 'filter-control' })).toHaveLength(0);
        expect(firstByTestId(screen.root, 'session-list-title-slot').findAllByProps({ testID: 'filter-control' }).length).toBeGreaterThan(0);
    });

    it('keeps the title beside its controls when no shell row is folded in', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                filterControl={<Text testID="filter-control">My work</Text>}
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />,
        );

        expect(screen.root.findAllByProps({ testID: 'session-list-phone-nav-row' })).toHaveLength(0);
        const controls = firstByTestId(screen.root, 'session-list-search-primary-controls');
        expect(controls.findAllByProps({ testID: 'filter-control' }).length).toBeGreaterThan(0);
    });

    it('moves the layout segment into View options while the space name would be cut short, and brings it back for a name that fits', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const { CollectionTitleButton } = await import('@/components/ui/lists/collection/CollectionTitleButton');
        const chrome = (label: string) => (
            <SessionListSearchChrome
                filterControl={<CollectionTitleButton testID="space-title" label={label} accessibilityLabel={label}
                    expanded={false} hasPopup="menu" onPress={vi.fn()} />}
                searchQuery=""
                onSearchQueryChange={vi.fn()}
            />
        );
        const segmentShown = () => screen.root.findAll((node) => String(node.props.testID ?? '').startsWith('session-list-layout')).length > 0;
        const layout = async (testID: string, width: number) => {
            await act(async () => {
                firstByTestId(screen.root, testID).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 36 } } });
            });
        };
        const screen = await renderScreen(chrome('Follow-ups'));
        expect(segmentShown()).toBe(true);

        // A 272px column: the title slot is 100px beside a 70px segment; the whole title wants 109px
        // (6px of it hang into the slot's optical inset), so its name would be cut to "Follow-…".
        await layout('session-list-layout-slot', 70);
        await layout('session-list-title-slot', 100);
        await layout('space-title-natural', 109);
        expect(segmentShown()).toBe(false);

        // The slot widens by the segment and its gap; that is still not room for both, so nothing flickers back.
        await layout('session-list-title-slot', 172);
        expect(segmentShown()).toBe(false);

        // A name that fits beside the segment brings it back.
        await act(async () => { screen.update(chrome('Nightly')); });
        await layout('space-title-natural', 92);
        expect(segmentShown()).toBe(true);
    });

});
