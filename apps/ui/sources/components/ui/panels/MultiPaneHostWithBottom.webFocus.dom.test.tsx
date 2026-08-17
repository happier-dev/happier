/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: <T,>(values: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('./MultiPaneHost', () => ({
    MultiPaneHost: (props: Readonly<{ main: React.ReactNode }>) => (
        <div data-testid="bottom-main-host">{props.main}</div>
    ),
}));

vi.mock('./resizable/ResizableDockedPaneVertical', () => ({
    ResizableDockedPaneVertical: (props: React.PropsWithChildren<Readonly<{ testID?: string }>>) => (
        <div data-testid={props.testID}>{props.children}</div>
    ),
}));

vi.mock('./motion/usePaneAnimatedPresence', () => ({
    usePaneAnimatedPresence: (input: Readonly<{ targetOpen: boolean; node: React.ReactNode }>) => ({
        present: input.targetOpen,
        node: input.targetOpen ? input.node : null,
        progress: { interpolate: () => 0 },
    }),
}));

vi.mock('./motion/PaneAnimatedScrimPressable', () => ({
    PaneAnimatedScrimPressable: (props: Readonly<{ testID?: string; onPress?: () => void }>) => (
        <button data-testid={props.testID} onClick={props.onPress}>Dismiss</button>
    ),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

type MountedSurface = Readonly<{
    render: (input: Readonly<{
        bottomOpen: boolean;
        includeTrigger: boolean;
        bottomPresentation?: 'docked' | 'overlay';
    }>) => Promise<void>;
    captureOpeningFocus: (target: FocusReturnTarget) => void;
    unmount: () => Promise<void>;
}>;

const mountedSurfaces: MountedSurface[] = [];

afterEach(async () => {
    while (mountedSurfaces.length > 0) {
        await mountedSurfaces.pop()?.unmount();
    }
});

describe('MultiPaneHostWithBottom web focus', () => {
    it('moves focus into the animated overlay, traps Tab, and restores the exact trigger', async () => {
        const surface = await mountSurface({ bottomOpen: false, includeTrigger: true });
        const trigger = requireElement<HTMLButtonElement>('bottom-focus-trigger');
        trigger.focus();
        surface.captureOpeningFocus(trigger);

        await surface.render({ bottomOpen: true, includeTrigger: true });

        const overlay = requireElement('multi-pane-bottom-overlay');
        const firstAction = requireElement<HTMLButtonElement>('bottom-focus-first-action');
        const lastAction = requireElement<HTMLButtonElement>('bottom-focus-last-action');
        expect(document.activeElement).toBe(overlay);
        expect(overlay.getAttribute('role')).toBe('dialog');
        expect(overlay.getAttribute('aria-modal')).toBe('true');
        expect(requireElement('multi-pane-bottom-underlay').hasAttribute('inert')).toBe(true);

        lastAction.focus();
        dispatchTab();
        expect(document.activeElement).toBe(firstAction);

        await surface.render({ bottomOpen: false, includeTrigger: true });
        expect(document.activeElement).toBe(trigger);
    });

    it('uses the retained pane shell when the original trigger disconnects before close', async () => {
        const surface = await mountSurface({ bottomOpen: false, includeTrigger: true });
        const trigger = requireElement<HTMLButtonElement>('bottom-focus-trigger');
        trigger.focus();
        surface.captureOpeningFocus(trigger);

        await surface.render({ bottomOpen: true, includeTrigger: true });
        const retainedUnderlay = requireElement('multi-pane-bottom-underlay');
        await surface.render({ bottomOpen: false, includeTrigger: false });

        expect(document.activeElement).toBe(retainedUnderlay);
    });

    it('discards a docked open capture before a later responsive overlay uses fallback focus', async () => {
        const surface = await mountSurface({ bottomOpen: false, includeTrigger: true });
        const trigger = requireElement<HTMLButtonElement>('bottom-focus-trigger');
        trigger.focus();
        surface.captureOpeningFocus(trigger);

        await surface.render({
            bottomOpen: true,
            includeTrigger: true,
            bottomPresentation: 'docked',
        });
        await surface.render({
            bottomOpen: true,
            includeTrigger: true,
            bottomPresentation: 'overlay',
        });

        const retainedUnderlay = requireElement('multi-pane-bottom-underlay');
        expect(document.activeElement).toBe(requireElement('multi-pane-bottom-overlay'));

        await surface.render({ bottomOpen: false, includeTrigger: true });
        expect(document.activeElement).toBe(retainedUnderlay);
        expect(document.activeElement).not.toBe(trigger);
    });
});

async function mountSurface(initialInput: Readonly<{
    bottomOpen: boolean;
    includeTrigger: boolean;
    bottomPresentation?: 'docked' | 'overlay';
}>): Promise<MountedSurface> {
    const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const openingFocusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: null };
    const surface: MountedSurface = {
        captureOpeningFocus: (target) => {
            openingFocusReturnRef.current = target;
        },
        render: async (input) => {
            await act(async () => {
                root.render(
                    <MultiPaneHostWithBottom
                        main={input.includeTrigger ? (
                            <button data-testid="bottom-focus-trigger">Trigger</button>
                        ) : null}
                        rightPane={null}
                        detailsPane={null}
                        layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                        rightDockWidthPx={360}
                        detailsDockWidthPx={520}
                        onCloseRight={() => {}}
                        onCloseDetails={() => {}}
                        onCommitRightDockWidthPx={() => {}}
                        onCommitDetailsDockWidthPx={() => {}}
                        bottomPane={input.bottomOpen ? (
                            <>
                                <button data-testid="bottom-focus-first-action">First</button>
                                <button data-testid="bottom-focus-last-action">Last</button>
                            </>
                        ) : null}
                        bottomPresentation={input.bottomPresentation ?? 'overlay'}
                        bottomDockHeightPx={320}
                        bottomDockMinHeightPx={200}
                        bottomDockMaxHeightPx={600}
                        onCloseBottom={() => {}}
                        onCommitBottomDockHeightPx={() => {}}
                        bottomOverlayFocusReturnRef={openingFocusReturnRef}
                    />,
                );
            });
        },
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        },
    };
    mountedSurfaces.push(surface);
    await surface.render(initialInput);
    return surface;
}

function requireElement<TElement extends HTMLElement = HTMLElement>(testId: string): TElement {
    const element = document.querySelector<TElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
}

function dispatchTab(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
    }));
}
