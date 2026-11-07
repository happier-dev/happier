import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeRootStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'root',
        title: 'Events',
        inputPlaceholder: 'Choose an event',
        sections: [{
            kind: 'static',
            id: 'events',
            options: [
                { id: 'event-a', label: 'Event A', openStep: { id: 'detail', title: 'Detail', sections: [{ kind: 'static', id: 's', options: [{ id: 'x', label: 'X' }] }] } },
                { id: 'event-b', label: 'Event B' },
            ],
        }],
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

describe('SelectionList controlled active step', () => {
    it('reports the active step through onActiveStepChange and shows the back chip after an openStep push', async () => {
        const onActiveStepChange = vi.fn<(step: SelectionListStep) => void>();
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ onActiveStepChange })} />,
        );
        expect(onActiveStepChange.mock.calls.map((call) => (call[0] as SelectionListStep).id))
            .toEqual(['root']);

        await screen.pressByTestIdAsync('sl:root:option:event-a');

        expect(onActiveStepChange.mock.calls.map((call) => (call[0] as SelectionListStep).id))
            .toEqual(['root', 'detail']);
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();
    });

    it('refreshes a pushed same-id step in place when the consumer republishes its content', async () => {
        const pushedStep: SelectionListStep = {
            id: 'detail',
            title: 'Detail',
            inputPlaceholder: 'Search destinations',
            sections: [{ kind: 'static', id: 's', options: [{ id: 'x', label: 'X' }] }],
        };
        const onActiveStepChange = vi.fn<(step: SelectionListStep) => void>();
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    onActiveStepChange,
                    syncActiveStep: null,
                    rootStep: makeRootStep({
                        sections: [{
                            kind: 'static',
                            id: 'events',
                            options: [{ id: 'event-a', label: 'Event A', openStep: pushedStep }],
                        }],
                    }),
                })}
            />,
        );

        await screen.pressByTestIdAsync('sl:root:option:event-a');
        expect(screen.findByTestId('sl:detail:option:x')).not.toBeNull();

        // The consumer rebuilt the same-id step with hydrated rows: the pushed
        // entry must be refreshed in place, keeping the step mounted and the
        // back affordance intact (a refresh is not navigation).
        const rerenderWithHydratedRows = makeRootStep({
            sections: [{
                kind: 'static',
                id: 'events',
                options: [{ id: 'event-a', label: 'Event A', openStep: pushedStep }],
            }],
        });
        await screen.update(
            <SelectionList
                {...defaultProps({
                    onActiveStepChange,
                    syncActiveStep: {
                        id: 'detail',
                        title: 'Detail',
                        inputPlaceholder: 'Search destinations',
                        sections: [{
                            kind: 'static',
                            id: 's',
                            options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
                        }],
                    },
                    rootStep: rerenderWithHydratedRows,
                })}
            />,
        );

        expect(screen.findByTestId('sl:detail:option:y')).not.toBeNull();
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();
        // A same-id content refresh is not navigation: no new step reports.
        expect(onActiveStepChange.mock.calls.map((call) => (call[0] as SelectionListStep).id))
            .toEqual(['root', 'detail']);
    });

    it('pops back to the root when the consumer republishes a null active step', async () => {
        const detailStep: SelectionListStep = {
            id: 'detail',
            title: 'Detail',
            sections: [{ kind: 'static', id: 's', options: [{ id: 'x', label: 'X' }] }],
        };
        const onActiveStepChange = vi.fn<(step: SelectionListStep) => void>();
        const props = (overrides: Partial<SelectionListProps>) => defaultProps({
            onActiveStepChange,
            rootStep: makeRootStep({
                sections: [{
                    kind: 'static',
                    id: 'events',
                    options: [{ id: 'event-a', label: 'Event A', openStep: detailStep }],
                }],
            }),
            ...overrides,
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...props({})} />);

        // The list pushes on its own when the row is activated; the consumer
        // learns the new active step through onActiveStepChange and follows it
        // by publishing the step as its active mirror.
        await screen.pressByTestIdAsync('sl:root:option:event-a');
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();
        await screen.update(
            <SelectionList
                {...props({ syncActiveStep: detailStep })}
            />,
        );
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();

        // The consumer leaves the step: republishing null pops back to the
        // root with the same contract as an internal pop.
        await screen.update(
            <SelectionList
                {...props({ syncActiveStep: null })}
            />,
        );

        expect(screen.findByTestId('sl:header:leading:back-chip')).toBeNull();
        expect(screen.findByTestId('sl:root:option:event-a')).not.toBeNull();
        expect(onActiveStepChange.mock.calls.map((call) => (call[0] as SelectionListStep).id))
            .toEqual(['root', 'detail', 'root']);
    });

    it('pushes when the consumer republishes an unmounted active step id', async () => {
        const destinationStep: SelectionListStep = {
            id: 'destination',
            title: 'Destination',
            sections: [{ kind: 'static', id: 's', options: [{ id: 'd', label: 'D' }] }],
        };
        const onActiveStepChange = vi.fn<(step: SelectionListStep) => void>();
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    onActiveStepChange,
                    syncActiveStep: destinationStep,
                })}
            />,
        );

        expect(screen.findByTestId('sl:destination:option:d')).not.toBeNull();
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();
        expect(onActiveStepChange.mock.calls.map((call) => (call[0] as SelectionListStep).id))
            .toEqual(['destination']);
    });

    it('keeps the consumer\'s per-step pagination off the root while its step mirror still names the popped step (R88)', async () => {
        const detailStep: SelectionListStep = {
            id: 'detail',
            title: 'Detail',
            sections: [{ kind: 'static', id: 's', options: [{ id: 'x', label: 'X' }] }],
        };
        const pagination = { hasMore: true, loadingMore: false, requestKey: 'c1', onEndReached: vi.fn(),
            loadingLabel: 'Loading', moreLabel: 'More', retryLabel: 'Retry', endReachedLabel: 'All loaded' };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ syncActiveStep: detailStep, pagination })} />,
        );
        // An internal pop lands before the consumer's effect clears its mirror and the step's pagination.
        await screen.pressByTestIdAsync('sl:header:leading:back-chip');
        expect(screen.findByTestId('sl:header:leading:back-chip')).toBeNull();
        // The root keeps its own (content-sized) body instead of latching the directory's virtualized viewport.
        expect(screen.findByTestId('sl:bodyVirtualizedList')).toBeNull();
    });
});
