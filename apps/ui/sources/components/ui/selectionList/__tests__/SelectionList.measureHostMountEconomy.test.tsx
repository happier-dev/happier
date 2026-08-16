/**
 * Measure-host mount economy.
 *
 * The natural height of the current step's body is ONE fact with TWO
 * consumers:
 *   - `useSelectionListMeasuredPopoverHeight` (the native popover height gate,
 *     which keeps the surface at `opacity: 0` until a height is known), and
 *   - `SelectionListAnimatedHeight` (the step-transition height animation).
 *
 * It used to be measured TWICE — one offscreen mirror rendered by the
 * orchestrator and a second one rendered inside the animator — so every option
 * row mounted THREE times per open on native (two of them invisible). That is
 * pure mount cost on the popover-open critical path, and it left two competing
 * owners of the same measurement.
 *
 * Contract asserted here: exactly ONE measure host exists, so each row mounts
 * exactly twice (one visible + one measure mirror), in every configuration
 * that needs a measurement.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import { PlanOptionRow } from '../SelectionListOptionRow';
import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeRootStep(): SelectionListStep {
    return {
        id: 'root',
        title: 'Worktrees',
        inputPlaceholder: 'Search worktrees',
        sections: [
            {
                kind: 'static',
                id: 'recent',
                title: 'RECENT',
                options: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'b', label: 'Bravo' },
                    { id: 'c', label: 'Charlie' },
                ],
            },
        ],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeRootStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        testID: 'sl',
        ...overrides,
    };
}

const OPTION_COUNT = 3;

describe('SelectionList measure-host mount economy', () => {
    it('mounts every option row exactly twice (one visible + one measure mirror) in the native measured-popover configuration', async () => {
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    // The native popover path: `resolvePopoverSelectionListHeightBehavior`
                    // forces this behavior for every non-web platform, so this is
                    // what every iOS/Android chip actually renders.
                    heightBehavior: 'measuredToMaxHeight' as SelectionListProps['heightBehavior'],
                    maxHeight: 320,
                })}
            />,
        );

        expect(screen.findAllByType(PlanOptionRow).length).toBe(OPTION_COUNT * 2);
    });

    it('renders exactly one measure host in the native measured-popover configuration', async () => {
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    heightBehavior: 'measuredToMaxHeight' as SelectionListProps['heightBehavior'],
                    maxHeight: 320,
                })}
            />,
        );

        const measureHosts = screen.findAll((node) => (
            typeof node.type === 'string'
            && typeof node.props?.testID === 'string'
            && (node.props.testID as string).endsWith(':measure')
        ));
        expect(measureHosts.length).toBe(1);
        expect(measureHosts[0].props.testID).toBe('sl:measure');
    });

    it('still measures once (rows mounted twice) when only the step-transition animator needs a height', async () => {
        // No `heightBehavior` — the popover height gate is off, but transitions
        // are on, so the animator still needs the incoming step's height.
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        expect(screen.findAllByType(PlanOptionRow).length).toBe(OPTION_COUNT * 2);
    });

    it('mounts rows exactly once when nothing needs a measurement (transitions disabled, no height gate)', async () => {
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ disableTransitions: true })} />,
        );

        expect(screen.findAllByType(PlanOptionRow).length).toBe(OPTION_COUNT);
        expect(screen.findAllByTestId('sl:measure').length).toBe(0);
    });
});
