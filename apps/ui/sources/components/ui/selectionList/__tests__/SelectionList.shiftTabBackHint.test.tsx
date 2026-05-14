/**
 * RUX-13 — Shift+Tab back/up footer hint synthesis.
 *
 * The orchestrator augments the step's `footerHints` with a synthesized
 * "⇧⇥ back" entry whenever a back action is available:
 *   - the step stack can pop (sub-step is active), OR
 *   - path-mode `inputBehavior` is present AND `onBackUp(inputValue)` is
 *     non-null (i.e. there's a parent path to walk up to)
 *
 * The hint is NOT rendered when there is genuinely nothing to back to (root
 * step + no path-mode OR root path) so the footer stays free of dead chips.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';
import { makeStoryPathInputBehavior } from '../storySurface/_shared';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeRootStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'root',
        title: 'Worktrees',
        inputPlaceholder: 'Search worktrees',
        sections: [
            {
                kind: 'static',
                id: 'options',
                title: 'OPTIONS',
                options: [{ id: 'opt-a', label: 'Option A' }],
            },
        ],
        footerHints: [
            { id: 'navigate', label: '↑↓', description: 'navigate' },
            { id: 'enter', label: '↵', description: 'select' },
        ],
        ...overrides,
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeRootStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: true,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList — Shift+Tab back hint (RUX-13)', () => {
    it('does NOT render the back hint at the root step when no path-mode is active', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        expect(screen.findByTestId('sl:footer:hint:back')).toBeNull();
    });

    it('renders the back hint when a sub-step is active (canPop is true)', async () => {
        const { act } = await import('react-test-renderer');
        const detailStep: SelectionListStep = {
            id: 'detail',
            title: 'Detail',
            backLabel: 'Worktrees',
            sections: [
                {
                    kind: 'static',
                    id: 'detail-section',
                    title: 'BRANCHES',
                    options: [{ id: 'branch-a', label: 'main' }],
                },
            ],
        };
        const root = makeRootStep({
            sections: [
                {
                    kind: 'static',
                    id: 'root-section',
                    title: 'ROOT',
                    options: [{ id: 'go', label: 'Open detail', openStep: detailStep }],
                },
            ],
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ rootStep: root })} />,
        );
        // Root step: no back hint yet.
        expect(screen.findByTestId('sl:footer:hint:back')).toBeNull();
        await screen.pressByTestIdAsync('sl:root:option:go');
        // The footer cross-fades hint set changes over 120ms (R6 polish).
        // Advance past the fade-out → swap so the new hint is rendered.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });
        // Sub-step is active: back hint must be visible.
        expect(screen.findByTestId('sl:footer:hint:back')).not.toBeNull();
    });

    it('renders the back hint at the root step when path-mode is active AND the input has segments to back up', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const inputBehavior = makeStoryPathInputBehavior();
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    inputBehavior,
                    inputMode: 'value',
                    rootStep: makeRootStep({ inputPlaceholder: 'Type a path' }),
                })}
            />,
        );
        // Empty input → no back hint (nothing to back up to).
        expect(screen.findByTestId('sl:footer:hint:back')).toBeNull();
        // Type a path with at least one parent.
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', '~/Documents/dev');
        });
        // Wait for the footer cross-fade swap.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });
        expect(screen.findByTestId('sl:footer:hint:back')).not.toBeNull();
    });

    it('does NOT render the back hint at root path "/" (no parent to walk up to)', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const inputBehavior = makeStoryPathInputBehavior();
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    inputBehavior,
                    inputMode: 'value',
                    rootStep: makeRootStep({ inputPlaceholder: 'Type a path' }),
                })}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', '/');
        });
        expect(screen.findByTestId('sl:footer:hint:back')).toBeNull();
    });

    it('does NOT render the back hint at home shorthand "~/"', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const inputBehavior = makeStoryPathInputBehavior();
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    inputBehavior,
                    inputMode: 'value',
                    rootStep: makeRootStep({ inputPlaceholder: 'Type a path' }),
                })}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', '~/');
        });
        expect(screen.findByTestId('sl:footer:hint:back')).toBeNull();
    });
});
