import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedFlashList, state: flashListState } = createCapturingFlashListMock({
    componentName: 'FlashListMock',
    itemWrapperName: 'FlashListItemMock',
    renderItems: true,
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: capturedFlashList.FlashList,
    flashListRuntime: { usingFallback: true },
}));

function makeRootStep(): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 'sessions',
                options: [
                    { id: 'opt-pending', label: 'Linking session', loading: true },
                    { id: 'opt-idle', label: 'Other session' },
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
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

/**
 * A row whose selection kicks off async work (linking a session, resolving a
 * reference) needs a pending affordance that keeps the row's identity — a
 * skeleton would destroy it, and removing the row would move every sibling.
 * `Item` already owns that affordance; the option descriptor must be able to
 * ask for it, on BOTH row paths (mapped and virtualized), and a pending row
 * must not stay activatable.
 */
describe('SelectionList option loading', () => {
    it('renders the canonical pending affordance on the mapped row path and blocks re-activation', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        const pendingRow = screen.findByTestId('sl:root:option:opt-pending');
        const idleRow = screen.findByTestId('sl:root:option:opt-idle');
        expect(pendingRow).not.toBeNull();
        expect(idleRow).not.toBeNull();

        expect(pendingRow!.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(idleRow!.findAllByType(ActivitySpinner)).toHaveLength(0);

        expect(pendingRow!.props.disabled).toBe(true);
        expect(idleRow!.props.disabled).toBeFalsy();
    });

    it('renders the same pending affordance on the virtualized row path', async () => {
        flashListState.props = null;
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={{
                    id: 'sessions',
                    options: [
                        { id: 'opt-pending', label: 'Linking session', loading: true },
                        { id: 'opt-idle', label: 'Other session' },
                    ],
                }}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelectOption={() => {}}
                virtualization="force"
            />,
        );

        expect(flashListState.props).not.toBeNull();

        const pendingRow = screen.findByTestId('sl:root:option:opt-pending');
        const idleRow = screen.findByTestId('sl:root:option:opt-idle');
        expect(pendingRow!.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(idleRow!.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(pendingRow!.props.disabled).toBe(true);
    });
});
