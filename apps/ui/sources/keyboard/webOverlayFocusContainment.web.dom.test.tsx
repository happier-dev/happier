/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { FocusReturnTarget } from './focusReturn';
import {
    useWebOverlayFocusContainment,
    type WebOverlayFocusReturnStrategy,
} from './webOverlayFocusContainment';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type OverlayHarnessProps = Readonly<{
    active: boolean;
    includeTrigger?: boolean;
    /** The shell stays in the document after release, as a modal does while it animates out. */
    retainedShell?: boolean;
    hiddenOnRelease?: boolean;
    focusReturn?: WebOverlayFocusReturnStrategy;
}>;

type MountedHarness<TProps> = Readonly<{
    render: (props: TProps) => Promise<void>;
    unmount: () => Promise<void>;
}>;

const mountedHarnesses: Array<MountedHarness<unknown>> = [];

afterEach(async () => {
    while (mountedHarnesses.length > 0) {
        await mountedHarnesses.pop()?.unmount();
    }
});

describe('useWebOverlayFocusContainment', () => {
    it('captures opening focus and moves it into the overlay shell', async () => {
        const harness = await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: false,
            includeTrigger: true,
        });
        const trigger = getElement<HTMLButtonElement>('overlay-trigger');
        trigger.focus();

        await harness.render({ active: true, includeTrigger: true });

        expect(document.activeElement).toBe(getElement('overlay-shell'));
    });

    it('contains Tab and Shift+Tab within the active overlay', async () => {
        await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: true,
            includeTrigger: true,
        });
        const firstAction = getElement<HTMLButtonElement>('overlay-first-action');
        const lastAction = getElement<HTMLButtonElement>('overlay-last-action');

        lastAction.focus();
        dispatchTab();
        expect(document.activeElement).toBe(firstAction);

        firstAction.focus();
        dispatchTab({ shiftKey: true });
        expect(document.activeElement).toBe(lastAction);
    });

    it('leaves Tab to a code editor inside the overlay that uses it for indentation', async () => {
        await mountHarness(() => <EditorOverlayHarness />, undefined);
        const editor = getElement<HTMLDivElement>('overlay-editor');
        editor.focus();
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        editor.dispatchEvent(tab);
        // The editor consumed Tab (it indents); the overlay must not also move focus away from it.
        expect(tab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(editor);
        expect(getElement('overlay-editor').dataset.indents).toBe('1');
    });

    it('returns focus to the exact connected trigger when the overlay closes', async () => {
        const harness = await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: false,
            includeTrigger: true,
        });
        const trigger = getElement<HTMLButtonElement>('overlay-trigger');
        trigger.focus();

        await harness.render({ active: true, includeTrigger: true });
        expect(document.activeElement).toBe(getElement('overlay-shell'));
        await harness.render({ active: false, includeTrigger: true });

        expect(document.activeElement).toBe(trigger);
    });

    it('keeps focus on the trigger when the released overlay stays mounted and inert to animate out', async () => {
        // React restores the element that was focused before a commit once the commit's DOM work is done;
        // a shell still in the document would take focus back from the trigger the release just focused.
        const harness = await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: false,
            includeTrigger: true,
            retainedShell: true,
            hiddenOnRelease: true,
        });
        const trigger = getElement<HTMLButtonElement>('overlay-trigger');
        trigger.focus();
        await harness.render({ active: true, includeTrigger: true, retainedShell: true, hiddenOnRelease: true });
        getElement<HTMLButtonElement>('overlay-last-action').focus();

        await harness.render({ active: false, includeTrigger: true, retainedShell: true, hiddenOnRelease: true });

        expect(getElement('overlay-shell').hasAttribute('inert')).toBe(true);
        expect(document.activeElement).toBe(trigger);
    });

    it.each([false, true])('does not return focus from a retired lower overlay while the higher overlay owns it (self inert: %s)', async (lowerSelfInert) => {
        const harness = await mountHarness((props: NestedOverlayHarnessProps) => <NestedOverlayHarness {...props} />, {
            lowerActive: true,
            topActive: false,
            lowerSelfInert,
        });
        await harness.render({ lowerActive: true, topActive: true, lowerSelfInert });
        const topAction = getElement<HTMLButtonElement>('nested-top-last-action');
        topAction.focus();
        await harness.render({ lowerActive: false, topActive: true, lowerSelfInert });
        expect(document.activeElement).toBe(topAction);
        dispatchTab();
        expect(document.activeElement).toBe(getElement('nested-top-first-action'));
    });

    it('uses the pane fallback when the captured trigger disconnects before close', async () => {
        const harness = await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: false,
            includeTrigger: true,
        });
        getElement<HTMLButtonElement>('overlay-trigger').focus();

        await harness.render({ active: true, includeTrigger: true });
        await harness.render({ active: false, includeTrigger: false });

        expect(document.activeElement).toBe(getElement('overlay-pane-fallback'));
    });

    it('uses local fallback when a retained overlay receives an empty pre-mutation capture', async () => {
        const emptyCaptureRef: React.MutableRefObject<FocusReturnTarget> = { current: null };
        const focusReturn: WebOverlayFocusReturnStrategy = {
            kind: 'pre-mutation',
            ref: emptyCaptureRef,
            discardPendingCapture: false,
        };
        const harness = await mountHarness((props: OverlayHarnessProps) => <OverlayHarness {...props} />, {
            active: false,
            includeTrigger: true,
            focusReturn,
        });
        const trigger = getElement<HTMLButtonElement>('overlay-trigger');
        trigger.focus();

        await harness.render({ active: true, includeTrigger: true, focusReturn });
        expect(document.activeElement).toBe(getElement('overlay-shell'));
        await harness.render({ active: false, includeTrigger: true, focusReturn });

        expect(document.activeElement).toBe(getElement('overlay-pane-fallback'));
        expect(document.activeElement).not.toBe(trigger);
    });

    it('lets a top overlay own Tab containment while its retained lower overlay is inert', async () => {
        const harness = await mountHarness((props: NestedOverlayHarnessProps) => <NestedOverlayHarness {...props} />, {
            lowerActive: false,
            topActive: false,
        });
        getElement<HTMLButtonElement>('nested-trigger').focus();

        await harness.render({ lowerActive: true, topActive: false });
        const lowerShell = getElement('nested-lower-shell');
        expect(document.activeElement).toBe(lowerShell);

        await harness.render({ lowerActive: true, topActive: true });
        const topFirstAction = getElement<HTMLButtonElement>('nested-top-first-action');
        const topLastAction = getElement<HTMLButtonElement>('nested-top-last-action');
        topLastAction.focus();
        dispatchTab();
        expect(document.activeElement).toBe(topFirstAction);

        await harness.render({ lowerActive: true, topActive: false });
        expect(document.activeElement).toBe(lowerShell);
    });
});

function OverlayHarness(props: OverlayHarnessProps): React.ReactElement {
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackRef = React.useRef<HTMLButtonElement | null>(null);
    const focusReturn: WebOverlayFocusReturnStrategy = props.focusReturn ?? { kind: 'activation-time' };
    useWebOverlayFocusContainment({
        active: props.active,
        containerRef: shellRef,
        fallbackRef,
        focusReturn,
    });

    return (
        <>
            {props.includeTrigger ? <button data-testid="overlay-trigger">Trigger</button> : null}
            <button ref={fallbackRef} data-testid="overlay-pane-fallback">Pane fallback</button>
            {props.active || props.retainedShell ? (
                <div ref={shellRef} data-testid="overlay-shell" tabIndex={-1} inert={!props.active && props.hiddenOnRelease || undefined}>
                    <button data-testid="overlay-first-action">First</button>
                    <button data-testid="overlay-last-action">Last</button>
                </div>
            ) : null}
        </>
    );
}

/** The last focusable is an editor that, like Monaco and CodeMirror, handles Tab on its own element. */
function EditorOverlayHarness(): React.ReactElement {
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackRef = React.useRef<HTMLButtonElement | null>(null);
    useWebOverlayFocusContainment({ active: true, containerRef: shellRef, fallbackRef, focusReturn: { kind: 'activation-time' } });
    return (
        <>
            <button ref={fallbackRef} data-testid="overlay-pane-fallback">Pane fallback</button>
            <div ref={shellRef} data-testid="overlay-shell" tabIndex={-1}>
                <button data-testid="overlay-first-action">First</button>
                <div data-testid="overlay-editor" role="textbox" aria-multiline tabIndex={0} data-indents="0"
                    onKeyDown={(event) => {
                        if (event.key !== 'Tab') return;
                        event.preventDefault();
                        event.currentTarget.dataset.indents = String(Number(event.currentTarget.dataset.indents) + 1);
                    }} />
            </div>
        </>
    );
}

type NestedOverlayHarnessProps = Readonly<{
    lowerActive: boolean;
    topActive: boolean;
    lowerSelfInert?: boolean;
}>;

function NestedOverlayHarness(props: NestedOverlayHarnessProps): React.ReactElement {
    const lowerShellRef = React.useRef<HTMLDivElement | null>(null);
    const topShellRef = React.useRef<HTMLDivElement | null>(null);
    const fallbackRef = React.useRef<HTMLButtonElement | null>(null);
    useWebOverlayFocusContainment({
        active: props.lowerActive,
        containerRef: lowerShellRef,
        fallbackRef,
        focusReturn: { kind: 'activation-time' },
    });
    useWebOverlayFocusContainment({
        active: props.topActive,
        containerRef: topShellRef,
        fallbackRef,
        focusReturn: { kind: 'activation-time' },
    });

    return (
        <>
            <button data-testid="nested-trigger">Trigger</button>
            <div inert={props.topActive && !props.lowerSelfInert || undefined}>
                {props.lowerActive ? (
                    <div ref={lowerShellRef} data-testid="nested-lower-shell" tabIndex={-1} inert={props.topActive && props.lowerSelfInert || undefined}>
                        <button data-testid="nested-lower-first-action">Lower first</button>
                        <button data-testid="nested-lower-last-action">Lower last</button>
                    </div>
                ) : null}
            </div>
            <button ref={fallbackRef} data-testid="nested-pane-fallback">Pane fallback</button>
            {props.topActive ? (
                <div ref={topShellRef} data-testid="nested-top-shell" tabIndex={-1}>
                    <button data-testid="nested-top-first-action">Top first</button>
                    <button data-testid="nested-top-last-action">Top last</button>
                </div>
            ) : null}
        </>
    );
}

async function mountHarness<TProps>(
    renderElement: (props: TProps) => React.ReactNode,
    initialProps: TProps,
): Promise<MountedHarness<TProps>> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const harness: MountedHarness<TProps> = {
        render: async (props) => {
            await act(async () => {
                root.render(renderElement(props));
            });
        },
        unmount: () => unmountHarness(root, container),
    };
    mountedHarnesses.push(harness as MountedHarness<unknown>);
    await harness.render(initialProps);
    return harness;
}

async function unmountHarness(root: Root, container: HTMLDivElement): Promise<void> {
    await act(async () => {
        root.unmount();
    });
    container.remove();
}

function getElement<TElement extends HTMLElement = HTMLElement>(testId: string): TElement {
    const element = document.querySelector<TElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
}

function dispatchTab(options: Readonly<{ shiftKey?: boolean }> = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: options.shiftKey === true,
        bubbles: true,
        cancelable: true,
    }));
}
