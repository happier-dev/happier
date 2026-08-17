import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * Lane C — roving focus is owned ONCE.
 *
 * Focus used to be owned twice: as an index inside
 * `useSelectionListKeyboardNav` and as an id mirrored back into
 * `SelectionList` through an effect. Each focus change therefore cost three
 * commits (the prop commit, the hook's index update, the id mirror). Both
 * follow-up commits were effect-driven, so the list also painted one frame of
 * stale focus before settling.
 *
 * These tests assert the commit COUNT directly, because that is the contract
 * that regresses silently: a future re-introduction of a mirror effect stays
 * behaviourally green while quietly tripling the work per keystroke.
 */

const ROOT_STEP: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search',
    sections: [
        {
            kind: 'static',
            id: 'section-a',
            options: [
                { id: 'opt-a', label: 'Alpha' },
                { id: 'opt-b', label: 'Bravo' },
                { id: 'opt-c', label: 'Charlie' },
            ],
        },
    ],
};

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: ROOT_STEP,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

type CommitCounter = Readonly<{ count: () => number; reset: () => void }>;

function makeCommitCounter(): CommitCounter & { onRender: () => void } {
    let commits = 0;
    return {
        onRender: () => { commits += 1; },
        count: () => commits,
        reset: () => { commits = 0; },
    };
}

function makeKeyEvent(key: string) {
    return {
        key,
        nativeEvent: { key },
        preventDefault: () => {},
        stopPropagation: () => {},
    };
}

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('SelectionList roving focus commit cost', () => {
    it('re-renders the list exactly once when the selected option changes', async () => {
        const { SelectionList } = await import('../SelectionList');
        const counter = makeCommitCounter();
        let setSelected: ((id: string) => void) | null = null;

        function Harness(): React.ReactElement {
            const [selectedOptionId, setSelectedOptionId] = React.useState('opt-a');
            setSelected = setSelectedOptionId;
            return (
                <React.Profiler id="selection-list" onRender={counter.onRender}>
                    <SelectionList {...defaultProps({ selectedOptionId })} />
                </React.Profiler>
            );
        }

        await renderScreen(<Harness />);
        await settle();
        counter.reset();

        await act(async () => {
            setSelected?.('opt-c');
        });
        await settle();

        expect(counter.count()).toBe(1);
    });

    it('re-renders the list exactly once per arrow-key focus move', async () => {
        const { SelectionList } = await import('../SelectionList');
        const counter = makeCommitCounter();

        const screen = await renderScreen(
            <React.Profiler id="selection-list" onRender={counter.onRender}>
                <SelectionList {...defaultProps()} />
            </React.Profiler>,
        );
        await settle();
        counter.reset();

        // The header component is the production key-event surface; on web the
        // header bridges DOM keydown into this same `onKeyPress`.
        const header = screen
            .findAllByTestId('sl:header')
            .find((node) => typeof node.props?.onKeyPress === 'function');
        expect(header).toBeDefined();
        await act(async () => {
            (header!.props.onKeyPress as (event: unknown) => void)(makeKeyEvent('ArrowDown'));
        });
        await settle();

        expect(counter.count()).toBe(1);
        const activeDescendant = screen
            .findAllByTestId('sl:header')
            .map((node) => node.props?.activeDescendantId)
            .find((value) => typeof value === 'string');
        expect(activeDescendant).toBe('sl:root:option:opt-b');
    });
});
