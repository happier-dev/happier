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
            {props.active ? (
                <div ref={shellRef} data-testid="overlay-shell" tabIndex={-1}>
                    <button data-testid="overlay-first-action">First</button>
                    <button data-testid="overlay-last-action">Last</button>
                </div>
            ) : null}
        </>
    );
}

type NestedOverlayHarnessProps = Readonly<{
    lowerActive: boolean;
    topActive: boolean;
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
            <div inert={props.topActive || undefined}>
                {props.lowerActive ? (
                    <div ref={lowerShellRef} data-testid="nested-lower-shell" tabIndex={-1}>
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
