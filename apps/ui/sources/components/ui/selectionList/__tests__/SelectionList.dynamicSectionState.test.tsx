import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListDynamicSection,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; default?: T; web?: T }) =>
                values.ios ?? values.default ?? values.web,
        },
    });
});

function makeStep(section: SelectionListDynamicSection): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'dynamic', ...section }],
    };
}

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

function makeKeyEvent(key: string): Readonly<{
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
}> {
    return {
        key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('SelectionList dynamic-section state rendering (Phase 2.2 mapping)', () => {
    it('renders loading skeleton rows while the resolver is pending', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            loadingSkeletonRows: 4,
            // RUX-11.2: explicit opt-in so the section's first-load loading
            // entry surfaces skeletons (the default is now "hide entirely"
            // to avoid the visible-then-hidden flicker — see RenderPlan tests).
            showSkeletonsOnFirstLoad: true,
            resolve: () => new Promise(() => {}),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        // Skeleton rows must surface a dedicated marker; the dynamic section is
        // expected to render either skeleton testIDs or visible placeholder rows.
        const loadingMarker = screen.findByTestId('sl:section:dyn:loading');
        expect(loadingMarker).not.toBeNull();
    });

    it('renders an inline error row when the resolver rejects', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => { throw new Error('boom'); },
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const errorRow = screen.findByTestId('sl:section:dyn:error');
        expect(errorRow).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('boom');
    });

    it('renders the descriptor emptyHint when resolver succeeds with zero options', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({ options: [], emptyHint: 'No matches available' }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const emptyHint = screen.findByTestId('sl:section:dyn:emptyHint');
        expect(emptyHint).not.toBeNull();
        expect(screen.getTextContent()).toContain('No matches available');
    });

    it('lets Tab descend into an explicitly focused value-mode dynamic row even when ghost text is suppressed', async () => {
        const { act } = await import('react-test-renderer');
        const onSelect = vi.fn();
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    {
                        id: 'projects',
                        label: 'Projects',
                        autocompleteValue: '~/Documents/Projects/',
                        onSelect,
                    },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        function Harness(): React.ReactElement {
            const [value, setValue] = React.useState('~/Documents/');
            return (
                <SelectionList
                    {...defaultProps(root, {
                        inputMode: 'value',
                        inputValue: value,
                        onChangeInputValue: setValue,
                        inputBehavior: {
                            getFilterQueryFromInput: () => '',
                            shouldSuppressAutocomplete: () => true,
                        },
                    })}
                />
            );
        }
        const screen = await renderScreen(<Harness />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:root:option:projects')).not.toBeNull();
        await act(async () => {
            await Promise.resolve();
        });

        const initialInput = screen.findByTestId('sl:header:input') as unknown as {
            props: {
                onKeyPress?: (event: unknown) => void;
            };
        } | null;
        expect(initialInput).not.toBeNull();
        if (!initialInput) throw new Error('expected selection list input');

        await act(async () => {
            initialInput.props.onKeyPress?.(makeKeyEvent('ArrowDown'));
        });
        const focusedInput = screen.findByTestId('sl:header:input') as unknown as {
            props: {
                onKeyPress?: (event: unknown) => void;
            };
        } | null;
        expect(focusedInput).not.toBeNull();
        if (!focusedInput) throw new Error('expected selection list input after focus update');
        await act(async () => {
            focusedInput.props.onKeyPress?.(makeKeyEvent('Tab'));
        });

        const updatedInput = screen.findByTestId('sl:header:input') as unknown as {
            props: { value?: string };
        } | null;
        expect(updatedInput?.props.value).toBe('~/Documents/Projects/');
        expect(onSelect).not.toHaveBeenCalled();
    });
});
