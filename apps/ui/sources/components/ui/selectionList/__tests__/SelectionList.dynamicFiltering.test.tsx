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
    return createReactNativeWebMock();
});

function dynamicStep(section: SelectionListDynamicSection): SelectionListStep {
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

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * R9 — Blocker 3: dynamic-section success rows must honor the same input filter
 * applied to static rows. Typing "Doc" with the IN THIS FOLDER section showing
 * 5 entries should narrow to only the Doc-prefixed entries.
 *
 * The filter uses the same case-insensitive substring match as static
 * sections (label OR subtitle). The applied query is the input filter query
 * (`inputBehavior.getFilterQueryFromInput(input)` if present, else input).
 */
/**
 * RUX-1 Issue 8: dynamic-section content swap animation. When the resolver
 * seed changes (e.g. drilling into a child directory in the path picker),
 * the body wraps the success rows in a SlideTransitionSwitch keyed by the
 * seed so the new rows cross-slide in instead of snapping. Test verifies
 * the transition wrapper mounts when the section is in a success state.
 */
describe('RUX-1 Issue 8: dynamic-section transitionKey wrapper', () => {
    it('mounts a SlideTransitionSwitch around the dynamic-section success rows when a resolver seed is present', async () => {
        const { act } = await import('react-test-renderer');
        const root = dynamicStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({
                options: [{ id: 'a', label: 'apple' }],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            // Filter query "app" matches "apple" so the section renders
            // in success state and the transition wrapper mounts.
            <SelectionList {...defaultProps(root)} inputValue="app" />,
        );
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        // The transition wrapper exposes a stable testID so other tests +
        // the popover surface can rely on the animation contract.
        const transitionWrapper = screen.findByTestId('sl:section:dyn:transition');
        expect(transitionWrapper).not.toBeNull();
    });
});

describe('SelectionList dynamic-section row filtering (R9 blocker 3)', () => {
    it('narrows dynamic success rows by the input filter (substring on label, case-insensitive)', async () => {
        const { act } = await import('react-test-renderer');
        const root = dynamicStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    { id: 'a', label: 'Apple' },
                    { id: 'b', label: 'Banana' },
                    { id: 'c', label: 'Cranberry' },
                    { id: 'd', label: 'Apricot' },
                    { id: 'e', label: 'Mango' },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        // Use uncontrolled input; type after mount.
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        // Wait for the resolver to flush its initial response.
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        // Initial render: all 5 rows present.
        expect(screen.findByTestId('sl:root:option:a')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:e')).not.toBeNull();

        // User types 'ap' — only Apple + Apricot should remain.
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', 'ap');
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:root:option:a')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:d')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:b')).toBeNull();
        expect(screen.findByTestId('sl:root:option:c')).toBeNull();
        expect(screen.findByTestId('sl:root:option:e')).toBeNull();
    });

    it('uses inputBehavior.getFilterQueryFromInput when set (mimics the path adapter trailing-leaf filter)', async () => {
        const { act } = await import('react-test-renderer');
        // Path-adapter-style behavior: filter query = trailing leaf after the
        // last "/" so typing "~/Doc" filters by "Doc".
        const root = dynamicStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    { id: 'documents', label: 'Documents' },
                    { id: 'downloads', label: 'Downloads' },
                    { id: 'desktop', label: 'Desktop' },
                    { id: 'movies', label: 'Movies' },
                    { id: 'music', label: 'Music' },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps(root, {
                    inputBehavior: {
                        getFilterQueryFromInput: (input) => {
                            const idx = input.lastIndexOf('/');
                            return idx >= 0 ? input.slice(idx + 1) : input;
                        },
                    },
                })}
            />,
        );
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        // Type a path-shaped input; filter query is "Doc".
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', '~/Doc');
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:root:option:documents')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:downloads')).toBeNull();
        expect(screen.findByTestId('sl:root:option:desktop')).toBeNull();
    });

    it('filters dynamic rows by the subtitle as well as the label (e.g. branch local + remote)', async () => {
        const { act } = await import('react-test-renderer');
        const root = dynamicStep({
            id: 'branches',
            title: 'BRANCHES',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    { id: 'main', label: 'main', subtitle: 'local' },
                    { id: 'origin/main', label: 'main', subtitle: 'remote · origin' },
                    { id: 'feature-x', label: 'feature-x', subtitle: 'local' },
                    { id: 'origin/feature-y', label: 'feature-y', subtitle: 'remote · origin' },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', 'remote');
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:root:option:origin/main')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:origin/feature-y')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:main')).toBeNull();
        expect(screen.findByTestId('sl:root:option:feature-x')).toBeNull();
    });
});
