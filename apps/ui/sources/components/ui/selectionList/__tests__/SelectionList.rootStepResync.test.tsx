import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeStep(id: string, optionId: string, optionLabel: string): SelectionListStep {
    return {
        id,
        title: id,
        inputPlaceholder: `Search ${id}`,
        sections: [
            {
                kind: 'static',
                id: `${id}-section`,
                title: `${id.toUpperCase()}`,
                options: [{ id: optionId, label: optionLabel }],
            },
        ],
    };
}

describe('SelectionList rootStep prop-change resync (Phase 1A)', () => {
    it('resets the displayed step stack when rootStep identity changes after mount', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const rootA = makeStep('rootA', 'a-1', 'Alpha');
        const rootB = makeStep('rootB', 'b-1', 'Bravo');

        function Host(props: { which: 'a' | 'b' }): React.ReactElement {
            return (
                <SelectionList
                    rootStep={props.which === 'a' ? rootA : rootB}
                    onSelect={vi.fn()}
                    onRequestClose={vi.fn()}
                    keyboardHintsEnabled={false}
                    disableTransitions
                    testID="sl"
                />
            );
        }

        const screen = await renderScreen(<Host which="a" />);
        // Initial: rootA's option is rendered.
        expect(screen.findByTestId('sl:rootA:option:a-1')).not.toBeNull();
        expect(screen.findByTestId('sl:rootB:option:b-1')).toBeNull();

        // Swap rootStep to a new identity — the displayed step MUST resync.
        await act(async () => {
            screen.update(<Host which="b" />);
        });

        expect(screen.findByTestId('sl:rootB:option:b-1')).not.toBeNull();
        expect(screen.findByTestId('sl:rootA:option:a-1')).toBeNull();
    });

    it('drops a pushed sub-step when rootStep changes (back chip clears)', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const detail: SelectionListStep = makeStep('detail', 'detail-1', 'Detail');
        const rootA: SelectionListStep = {
            id: 'rootA',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 's',
                    options: [{ id: 'go', label: 'Open detail', openStep: detail }],
                },
            ],
        };
        const rootB = makeStep('rootB', 'b-1', 'Bravo');

        function Host(props: { which: 'a' | 'b' }): React.ReactElement {
            return (
                <SelectionList
                    rootStep={props.which === 'a' ? rootA : rootB}
                    onSelect={vi.fn()}
                    onRequestClose={vi.fn()}
                    keyboardHintsEnabled={false}
                    disableTransitions
                    testID="sl"
                />
            );
        }

        const screen = await renderScreen(<Host which="a" />);
        await screen.pressByTestIdAsync('sl:rootA:option:go');
        // Pushed: detail step is showing + back chip visible.
        expect(screen.findByTestId('sl:detail:option:detail-1')).not.toBeNull();
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();

        // Swap root identity — stack must reset to [rootB], no back chip.
        await act(async () => {
            screen.update(<Host which="b" />);
        });
        expect(screen.findByTestId('sl:rootB:option:b-1')).not.toBeNull();
        expect(screen.findByTestId('sl:detail:option:detail-1')).toBeNull();
        expect(screen.findByTestId('sl:header:leading:back-chip')).toBeNull();
    });
});
