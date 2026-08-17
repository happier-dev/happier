/**
 * R1 — ONE owner of the offscreen height measurement.
 *
 * `SelectionList` needs the body's NATURAL height twice over:
 *
 *  1. `useSelectionListMeasuredPopoverHeight` turns it into the container's
 *     concrete native height (`measuredToMaxHeight`), and gates the popover's
 *     visibility on it.
 *  2. `SelectionListAnimatedHeight` animates the container from the outgoing
 *     step's height to the incoming step's height.
 *
 * Both questions are about the SAME subtree, and each used to mount its own
 * hidden mirror of it. With the visible body that is THREE mounts of every
 * row per open on the native popover path — two of them invisible, and both
 * of them in front of the user on the critical open path, because the
 * container stays `opacity: 0` until the first measurement lands.
 *
 * The contract asserted here: the body subtree is mounted exactly TWICE on
 * the measured-native path — the visible one, plus ONE offscreen measure
 * mirror whose single layout feeds both consumers.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeStep(): SelectionListStep {
    return {
        id: 'root',
        title: 'Worktrees',
        inputPlaceholder: 'Search worktrees',
        sections: [
            {
                kind: 'static',
                id: 'opts',
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
        rootStep: makeStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        // Transitions ON: this is the shipped popover configuration, and the
        // configuration in which the second measure mirror used to appear.
        testID: 'sl',
        heightBehavior: 'measuredToMaxHeight',
        maxHeight: 320,
        ...overrides,
    };
}

function countMeasureHosts(screen: { findAll: (predicate: (node: { props: Record<string, unknown> }) => boolean) => unknown[] }): number {
    return screen.findAll((node) => {
        const testID = node.props?.testID;
        return typeof testID === 'string' && testID.endsWith(':measure');
    }).length;
}

describe('SelectionList measurement ownership (R1)', () => {
    it('mounts the body subtree exactly twice on the measured-native path', async () => {
        const { SelectionList } = await import('../SelectionList');
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        // One visible body + one offscreen measure mirror. A third mount is a
        // second measurer, i.e. a second owner of the same question.
        expect(screen.findAllByType(SelectionListBody).length).toBe(2);
    });

    it('renders exactly one offscreen measure host on the measured-native path', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        expect(countMeasureHosts(screen)).toBe(1);
    });

    it('mounts the body subtree exactly twice when only the step animator needs a measurement', async () => {
        const { SelectionList } = await import('../SelectionList');
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ heightBehavior: undefined, maxHeight: 320 })} />,
        );

        expect(screen.findAllByType(SelectionListBody).length).toBe(2);
        expect(countMeasureHosts(screen)).toBe(1);
    });

    it('mounts the body subtree exactly once when nothing needs a measurement', async () => {
        const { SelectionList } = await import('../SelectionList');
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    heightBehavior: undefined,
                    disableTransitions: true,
                    maxHeight: 320,
                })}
            />,
        );

        expect(screen.findAllByType(SelectionListBody).length).toBe(1);
        expect(countMeasureHosts(screen)).toBe(0);
    });
});
