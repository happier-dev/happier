import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const rootStep: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search machines',
    sections: [{
        kind: 'static',
        id: 'machines',
        title: 'This Home',
        options: [
            { id: 'macbook', label: 'MacBook Pro', subtitle: 'Online · this computer' },
            { id: 'devbox', label: 'devbox', subtitle: 'Offline · 4 days ago' },
        ],
    }],
};

/** A fine pointer with no touch points is how the web platform reports a hardware keyboard. */
function stubHardwareKeyboard() {
    vi.stubGlobal('window', { ...(globalThis as { window?: object }).window, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal('navigator', { ...(globalThis as { navigator?: object }).navigator, maxTouchPoints: 0 });
}

// K1 picker anatomy: the current choice of a single-choice picker carries a check, drawn once by the
// row owner so every picker (machine, path, profile, resume, server, …) marks it the same way.
describe('SelectionList current-choice mark', () => {
    // Unstub after every test, failing ones included, so a stubbed keyboard never leaks into the next.
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    it('marks only the current choice of a single-choice list', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectedOptionId="macbook"
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:root:option-selected-mark:macbook')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-selected-mark:devbox')).toBeFalsy();
    });

    // One choice per group (an account per connected service): every group's current row is current,
    // so each carries the same check and selected state the list draws for a single choice.
    it('marks every row its owner reports as current, one per group', async () => {
        const grouped: SelectionListStep = {
            id: 'root',
            sections: [
                { kind: 'static', id: 'claude', title: 'Claude subscription', options: [
                    { id: 'work', label: 'Work', selected: true },
                    { id: 'bot', label: 'Bot' },
                ] },
                { kind: 'static', id: 'api', title: 'Anthropic API key', options: [
                    { id: 'native', label: 'Its own sign-in', selected: true },
                ] },
            ],
        };
        const screen = await renderScreen(
            <SelectionList
                rootStep={grouped}
                selectedOptionId="work"
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:root:option-selected-mark:work')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-selected-mark:native')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-selected-mark:bot')).toBeFalsy();
    });

    // A fill alone reads like a hover: every chosen row of a multiple-choice list carries the same check.
    it('marks every chosen row of a multiple-choice list', async () => {
        const threeRows: SelectionListStep = { ...rootStep, sections: [{ kind: 'static', id: 'machines', options: [
            { id: 'macbook', label: 'MacBook Pro' }, { id: 'devbox', label: 'devbox' }, { id: 'nas', label: 'nas' },
        ] }] };
        const screen = await renderScreen(
            <SelectionList
                rootStep={threeRows}
                selection={{ kind: 'multiple', selectedIds: new Set(['macbook', 'nas']) }}
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:root:option-selected-mark:macbook')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-selected-mark:nas')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-selected-mark:devbox')).toBeFalsy();
        // The check marks the choices; the fill stays the list's one highlight (the focused row), never every choice.
        const filledRows = screen.tree.root.findAll((node) => (
            typeof node.type !== 'string' && typeof node.props?.title === 'string'
            && ((node.props?.selected === true && node.props?.selectedFill !== false) || node.props?.focused === true)
        )).map((node) => node.props.title as string);
        // A row's composite owners repeat its props; the set is the rows.
        expect(new Set(filledRows)).toEqual(new Set(['MacBook Pro']));
    });

    it('fills the one current choice of a single-choice list', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectedOptionId="macbook"
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );
        const filledRows = screen.tree.root.findAll((node) => (
            typeof node.type !== 'string' && typeof node.props?.title === 'string'
            && ((node.props?.selected === true && node.props?.selectedFill !== false) || node.props?.focused === true)
        )).map((node) => node.props.title as string);
        // A row's composite owners repeat its props; the set is the rows.
        expect(new Set(filledRows)).toEqual(new Set(['MacBook Pro']));
    });

    it('leaves lists whose rows draw their own selection state unmarked', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectedOptionId="macbook"
                selectionMark="none"
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:root:option-selected-mark:macbook')).toBeFalsy();
    });

    it('leaves card presentation to its corner overlay', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectedOptionId="macbook"
                optionPresentation="card"
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:root:option-selected-mark:macbook')).toBeFalsy();
    });

    // P1 command palette: rows are commands, not choices. The row the keyboard is on shows the ↵ it
    // would run with, and only when there is a hardware keyboard to press it.
    it('marks the keyboard row with ↵ instead of a check when the list asks for the enter mark', async () => {
        const render = (keyboardHintsEnabled: boolean) => renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectionMark="enter"
                keyboardHintsEnabled={keyboardHintsEnabled}
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );
        stubHardwareKeyboard();
        const withKeyboard = await render(true);
        expect(withKeyboard.findByTestId('sl:root:option-enter-mark:macbook')).toBeTruthy();
        expect(withKeyboard.findByTestId('sl:root:option-enter-mark:devbox')).toBeFalsy();
        expect(withKeyboard.findByTestId('sl:root:option-selected-mark:macbook')).toBeFalsy();

        const touch = await render(false);
        expect(touch.findByTestId('sl:root:option-enter-mark:macbook')).toBeFalsy();
    });

    // The ⌘K palette draws its commands as menu rows (inset, rounded); the row the keyboard is on
    // still shows the ↵ that runs it (Find lab G1).
    it('keeps the ↵ mark on menu-presentation rows', async () => {
        stubHardwareKeyboard();
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selectionMark="enter"
                optionPresentation="menu"
                keyboardHintsEnabled
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );
        expect(screen.findByTestId('sl:root:option-enter-mark:macbook')).toBeTruthy();
        expect(screen.findByTestId('sl:root:option-enter-mark:devbox')).toBeFalsy();
    });
});
