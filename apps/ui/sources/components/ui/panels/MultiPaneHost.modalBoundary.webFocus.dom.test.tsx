/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

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

vi.mock('./ResizableDockedPane', () => ({
    ResizableDockedPane: (props: React.PropsWithChildren<Readonly<{ testID?: string }>>) => (
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
    PaneAnimatedScrimPressable: (props: Readonly<{
        testID?: string;
        onPress?: () => void;
        accessibilityLabel?: string;
    }>) => (
        <button data-testid={props.testID} aria-label={props.accessibilityLabel} onClick={props.onPress}>
            Dismiss
        </button>
    ),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

type PaneKind = 'right' | 'details';

type MountedSurface = Readonly<{
    render: (open: boolean, includeHigherEscapeLayer?: boolean) => Promise<void>;
    captureOpeningFocus: (target: FocusReturnTarget) => void;
    getCloseCount: () => number;
    getHigherEscapeCount: () => number;
    unmount: () => Promise<void>;
}>;

const mountedSurfaces: MountedSurface[] = [];

afterEach(async () => {
    while (mountedSurfaces.length > 0) {
        await mountedSurfaces.pop()?.unmount();
    }
});

describe('MultiPaneHost modal-pane boundary', () => {
    it.each([
        ['right', 'Right sidebar'],
        ['details', 'Details panel'],
    ] as const)('%s gives a retained pane one named modal boundary with exact focus return', async (kind, label) => {
        const surface = await mountSurface(kind, false);
        const trigger = requireElement<HTMLButtonElement>(`${kind}-modal-trigger`);
        trigger.focus();
        surface.captureOpeningFocus(trigger);

        await surface.render(true);

        const modal = requireElement(`multi-pane-${kind}-modal`);
        const scrim = requireElement(`multi-pane-${kind}-scrim`);
        const firstAction = requireElement<HTMLButtonElement>(`${kind}-modal-first-action`);
        const lastFocusableControl = requireElement<HTMLInputElement>(`${kind}-modal-editable`);

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-label')).toBe(label);
        expect(requireElement('multi-pane-main-underlay').hasAttribute('inert')).toBe(true);
        expect(scrim.getAttribute('aria-label')).toBe(`Close ${label}`);
        expect(document.activeElement).toBe(modal);

        lastFocusableControl.focus();
        dispatchTab();
        expect(document.activeElement).toBe(firstAction);

        await surface.render(false);
        expect(document.activeElement).toBe(trigger);
    });

    it('leaves Escape in an editable pane control to a higher popover layer before closing the pane', async () => {
        const surface = await mountSurface('right', false);
        await surface.render(true, true);

        const editable = requireElement<HTMLInputElement>('right-modal-editable');
        editable.focus();
        dispatchEscape(editable);

        expect(surface.getHigherEscapeCount()).toBe(1);
        expect(surface.getCloseCount()).toBe(0);

        await surface.render(true);
        const editableAfterPopoverClose = requireElement<HTMLInputElement>('right-modal-editable');
        editableAfterPopoverClose.focus();
        dispatchEscape(editableAfterPopoverClose);

        expect(surface.getCloseCount()).toBe(1);
    });
});

async function mountSurface(kind: PaneKind, open: boolean): Promise<MountedSurface> {
    const { MultiPaneHost } = await import('./MultiPaneHost');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const openingFocusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: null };
    let closeCount = 0;
    let higherEscapeCount = 0;

    const surface: MountedSurface = {
        captureOpeningFocus: (target) => {
            openingFocusReturnRef.current = target;
        },
        render: async (isOpen, includeHigherEscapeLayer = false) => {
            const rightPane = kind === 'right' && isOpen
                ? renderPaneContent(kind, includeHigherEscapeLayer, () => { higherEscapeCount += 1; })
                : null;
            const detailsPane = kind === 'details' && isOpen
                ? renderPaneContent(kind, includeHigherEscapeLayer, () => { higherEscapeCount += 1; })
                : null;
            await act(async () => {
                root.render(
                    <MultiPaneHost
                        main={<button data-testid={`${kind}-modal-trigger`}>Open {kind}</button>}
                        rightPane={rightPane}
                        detailsPane={detailsPane}
                        layout={kind === 'right'
                            ? { kind: 'overlayStack', right: 'overlay', details: 'hidden' }
                            : { kind: 'twoPane', right: 'hidden', details: 'overlay' }}
                        rightDockWidthPx={360}
                        detailsDockWidthPx={520}
                        onCloseRight={() => { closeCount += 1; }}
                        onCloseDetails={() => { closeCount += 1; }}
                        onCommitRightDockWidthPx={() => {}}
                        onCommitDetailsDockWidthPx={() => {}}
                        rightOverlayFocusReturnRef={kind === 'right' ? openingFocusReturnRef : undefined}
                        detailsOverlayFocusReturnRef={kind === 'details' ? openingFocusReturnRef : undefined}
                    />,
                );
            });
        },
        getCloseCount: () => closeCount,
        getHigherEscapeCount: () => higherEscapeCount,
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        },
    };
    mountedSurfaces.push(surface);
    await surface.render(open);
    return surface;
}

function renderPaneContent(
    kind: PaneKind,
    includeHigherEscapeLayer: boolean,
    onHigherEscape: () => void,
): React.ReactNode {
    return (
        <>
            {includeHigherEscapeLayer ? <HigherEscapeLayer onEscape={onHigherEscape} /> : null}
            <button data-testid={`${kind}-modal-first-action`}>First</button>
            <button data-testid={`${kind}-modal-last-action`}>Last</button>
            <input data-testid={`${kind}-modal-editable`} />
        </>
    );
}

function HigherEscapeLayer(props: Readonly<{ onEscape: () => void }>): null {
    useEscapeLayer({
        enabled: true,
        priority: ESCAPE_LAYER_PRIORITIES.popover,
        allowEditableTarget: true,
        onEscape: () => {
            props.onEscape();
            return true;
        },
    });
    return null;
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

function dispatchEscape(target: EventTarget): void {
    target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));
}
