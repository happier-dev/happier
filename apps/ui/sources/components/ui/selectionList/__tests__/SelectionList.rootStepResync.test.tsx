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

type FiredInput = { props: Record<string, ((arg?: unknown) => void) | undefined> };

describe('SelectionList rootStep prop-change resync (Phase 1A)', () => {
    /**
     * A consumer that rebuilds `rootStep` is not asking to navigate. The worktree
     * picker rebuilds its whole step tree once a minute (the relative-time clock is
     * one of its memo inputs) and again on every SCM snapshot refresh, so a rebuild
     * with the SAME step id is a CONTENT refresh of the root the user is already on.
     * Draining the stack there threw the user out of a pushed step and cleared the
     * name they were typing into it.
     */
    it('keeps a pushed sub-step and its in-progress input when the root is rebuilt for the same step', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');

        const onCommitInputValue = vi.fn();
        // Mirrors the real worktree "name your worktree" step: a value-mode step whose
        // synthesized row carries the live input into the commit.
        const nameStep: SelectionListStep = {
            id: 'worktree-name',
            inputPlaceholder: 'Type a name',
            inputMode: 'value',
            disableInputFilter: true,
            onCommitInputValue,
            buildInputRow: (input) => ({
                id: 'create',
                label: `Create worktree: ${input}`,
                onSelect: () => onCommitInputValue(input),
            }),
            sections: [],
        };
        const buildRoot = (): SelectionListStep => ({
            id: 'worktree-root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 's',
                    options: [{ id: 'go', label: 'New worktree', openStep: nameStep }],
                },
            ],
        });

        function Host(props: Readonly<{ root: SelectionListStep }>): React.ReactElement {
            return (
                <SelectionList
                    rootStep={props.root}
                    onSelect={vi.fn()}
                    onRequestClose={vi.fn()}
                    keyboardHintsEnabled={false}
                    disableTransitions
                    testID="sl"
                />
            );
        }

        const screen = await renderScreen(<Host root={buildRoot()} />);
        await screen.pressByTestIdAsync('sl:worktree-root:option:go');
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();

        const input = screen.findByTestId('sl:header:input') as never as FiredInput;
        await act(async () => {
            input.props.onChangeText?.('half-typed-name');
        });

        // The minute tick: same root step, rebuilt object.
        await act(async () => {
            screen.update(<Host root={buildRoot()} />);
        });

        // Still on the pushed step (its back chip and its own placeholder)...
        expect(screen.findByTestId('sl:header:leading:back-chip')).not.toBeNull();
        const inputAfterTick = screen.findByTestId('sl:header:input') as never as FiredInput;
        expect((inputAfterTick.props as never as Record<string, unknown>).placeholder).toBe('Type a name');
        // ...and the half-typed name is still in the field, so the step's own commit
        // still creates the worktree the user was naming.
        expect((inputAfterTick.props as never as Record<string, unknown>).value).toBe('half-typed-name');
        await screen.pressByTestIdAsync('sl:worktree-name:option:create');
        expect(onCommitInputValue).toHaveBeenCalledWith('half-typed-name');
    });

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
