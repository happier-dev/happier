import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

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

type FiredInput = { props: Record<string, ((arg?: unknown) => void) | undefined> };

function makeValueStep(onCommitInputValue: (input: string) => void): SelectionListStep {
    return {
        id: 'value-step',
        inputPlaceholder: 'Type a name',
        inputMode: 'value',
        onCommitInputValue,
        sections: [],
    };
}

function makeRoot(valueStep: SelectionListStep): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 's',
                options: [{ id: 'go', label: 'Go', openStep: valueStep }],
            },
        ],
    };
}

function makeProps(
    valueStep: SelectionListStep,
    overrides: Partial<SelectionListProps> = {},
): SelectionListProps {
    return {
        rootStep: makeRoot(valueStep),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

const ENTER = { key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} };

async function renderAndEnterValueStep(props: SelectionListProps, text: string): Promise<FiredInput> {
    const { act } = await import('react-test-renderer');
    const { SelectionList } = await import('../SelectionList');
    const screen = await renderScreen(<SelectionList {...props} />);

    // Root step is search mode: Enter activates the focused 'go' row, which has
    // `openStep` and therefore pushes the value step.
    const rootInput = screen.findByTestId('sl:header:input') as never as FiredInput;
    await act(async () => {
        rootInput.props.onKeyPress?.(ENTER);
    });

    // Now on the value step. Type the candidate value.
    const valueInput = screen.findByTestId('sl:header:input') as never as FiredInput;
    await act(async () => {
        valueInput.props.onChangeText?.(text);
    });
    return valueInput;
}

describe('SelectionList per-step value mode (worktree custom naming)', () => {
    it("commits the typed value via the active step's onCommitInputValue when it declares inputMode:'value'", async () => {
        const { act } = await import('react-test-renderer');
        const stepCommit = vi.fn();
        const input = await renderAndEnterValueStep(makeProps(makeValueStep(stepCommit)), 'my-custom-name');

        await act(async () => {
            input.props.onKeyPress?.(ENTER);
        });

        expect(stepCommit).toHaveBeenCalledWith('my-custom-name');
    });

    it('prefers the step-level onCommitInputValue over the prop-level handler', async () => {
        const { act } = await import('react-test-renderer');
        const stepCommit = vi.fn();
        const propCommit = vi.fn();
        const input = await renderAndEnterValueStep(
            makeProps(makeValueStep(stepCommit), { onCommitInputValue: propCommit }),
            'name-x',
        );

        await act(async () => {
            input.props.onKeyPress?.(ENTER);
        });

        expect(stepCommit).toHaveBeenCalledWith('name-x');
        expect(propCommit).not.toHaveBeenCalled();
    });

    it('closes the popover after a per-step value commit (fixes the redirect-to-root bug)', async () => {
        const { act } = await import('react-test-renderer');
        const stepCommit = vi.fn();
        const onRequestClose = vi.fn();
        const input = await renderAndEnterValueStep(
            makeProps(makeValueStep(stepCommit), { onRequestClose }),
            'my-name',
        );

        await act(async () => {
            input.props.onKeyPress?.(ENTER);
        });

        expect(stepCommit).toHaveBeenCalledWith('my-name');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('commits via onSubmitEditing on native (soft-keyboard return, no hardware Enter)', async () => {
        const { act } = await import('react-test-renderer');
        const stepCommit = vi.fn();
        const input = await renderAndEnterValueStep(makeProps(makeValueStep(stepCommit)), 'mobile-name');

        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(stepCommit).toHaveBeenCalledWith('mobile-name');
    });
});
