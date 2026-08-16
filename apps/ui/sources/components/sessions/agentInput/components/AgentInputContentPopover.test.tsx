import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import {
    useHostListMotionQuiet,
    type ListMotionQuiet,
} from '@/components/sessions/agentActivity/list/listMotionQuiet';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

// The popover surface + selection overlay are boundaries here; mock them so the test asserts the
// F2 seam only: the keyboard inset spacer is reserved beneath the content when the software keyboard
// reports a height, and omitted otherwise (web returns 0 → no spacer, so web is unaffected).
let keyboardHeightValue = 0;

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => keyboardHeightValue,
}));

vi.mock('@/components/sessions/agentInput/selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: Record<string, any>) =>
        props.open
            ? React.createElement('AgentInputSelectionPopover', props, props.children({ maxHeight: 400 }))
            : null,
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, any>) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

import { AgentInputContentPopover } from './AgentInputContentPopover';

const anchorRef = { current: null } as React.RefObject<any>;

function renderPopover(reserveKeyboardInset?: boolean) {
    return renderScreen(
        <AgentInputContentPopover
            open
            anchorRef={anchorRef}
            onRequestClose={vi.fn()}
            reserveKeyboardInset={reserveKeyboardInset}
            content={<Content />}
        />,
    );
}

function Content() {
    return React.createElement('Content');
}

describe('AgentInputContentPopover', () => {
    it('reserves a bottom inset equal to the keyboard height when a consumer opts in (U-4)', async () => {
        keyboardHeightValue = 312;
        const screen = await renderPopover(true);

        const spacer = screen.findByTestId('agent-input-popover-keyboard-inset');
        expect(spacer).toBeTruthy();
        expect(spacer?.props.style).toEqual({ height: 312 });
    });

    it('renders no inset spacer when the keyboard is closed (web returns 0, unaffected)', async () => {
        keyboardHeightValue = 0;
        const screen = await renderPopover(true);

        expect(screen.findAllByTestId('agent-input-popover-keyboard-inset')).toHaveLength(0);
    });

    it('reserves no inset for consumers that do not opt in, even with the keyboard up (no regression)', async () => {
        keyboardHeightValue = 312;
        const screen = await renderPopover(false);

        expect(screen.findAllByTestId('agent-input-popover-keyboard-inset')).toHaveLength(0);
    });

    /**
     * The surface owns the scroller; its content only ever receives a node.
     *
     * A list inside a popover therefore cannot know it is being flicked, and a roster that
     * re-groups itself mid-flick moves rows out from under the finger doing the flicking. The pane
     * hands its own window to the roster directly; a popover host has nothing to hand, so the
     * scroller publishes it here instead of every host remembering to drill it through.
     */
    it('publishes its scroller to the content it is showing', async () => {
        keyboardHeightValue = 0;
        let published: ListMotionQuiet | null = null;

        function QuietProbe() {
            published = useHostListMotionQuiet();
            return React.createElement('QuietProbe');
        }

        const screen = await renderScreen(
            <AgentInputContentPopover
                open
                anchorRef={anchorRef}
                onRequestClose={vi.fn()}
                content={<QuietProbe />}
            />,
        );

        expect(published).not.toBeNull();
        expect(published!.isQuiet()).toBe(true);

        const surface = screen.findByType('AgentInputPopoverSurface');
        expect(typeof surface?.props.onScroll).toBe('function');

        // The scroller moving is what closes the window — the one signal a list inside cannot see.
        surface!.props.onScroll();
        expect(published!.isQuiet()).toBe(false);
    });
});
