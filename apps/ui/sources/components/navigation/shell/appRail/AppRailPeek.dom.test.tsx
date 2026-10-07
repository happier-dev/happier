/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

// The host's reduce-motion preference (a media query on the web) is the boundary.
const hostMotion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => hostMotion.reduced }));

const { View } = await import('react-native');
const { AppRailPeek } = await import('./AppRailPeek');
const { AppShellPeekLayer, AppShellPeekProvider } = await import('./AppShellPeek');
type AppShellShownColumn = import('./appRailModel').AppShellShownColumn;
const { motionTokens } = await import('@/components/ui/motion');

const COLUMN_WIDTH_PX = 320;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigate = vi.fn();
const openRow = vi.fn();

/** The shell as `SidebarNavigator` composes it: rail triggers, and the peek layer in the column's place. */
/** Peeks are keyed by destination: a plugin page with its own column peeks exactly like a built-in. */
const COLUMNS_BY_DESTINATION: Record<string, AppShellShownColumn> = {
    sessions: { kind: 'builtin', id: 'sessions' },
    plugins: { kind: 'builtin', id: 'plugins' },
    'plugin:acme.triage:triage': { kind: 'plugin', destinationId: 'plugin:acme.triage:triage' },
};

async function renderShell(params: Readonly<{ currentId: string; columnShown: boolean }>) {
    await act(async () => {
        root.render(
            <AppShellPeekProvider enabled currentId={params.currentId} columnShown={params.columnShown}>
                {(['sessions', 'plugins', 'plugin:acme.triage:triage'] as const).map((kind) => (
                    <AppRailPeek key={kind} testID={`rail-peek:${kind}`} destinationId={kind}>
                        {() => <button data-testid={`rail-item:${kind}`} onClick={navigate}>{kind}</button>}
                    </AppRailPeek>
                ))}
                <View testID="sheet" style={{ position: 'relative', width: 1000, height: 800 }}>
                    <AppShellPeekLayer
                        widthPx={COLUMN_WIDTH_PX}
                        resolveColumn={(destinationId) => COLUMNS_BY_DESTINATION[destinationId] ?? null}
                        renderColumn={(column) => {
                            const name = column.kind === 'builtin' ? column.id : column.destinationId;
                            return <button data-testid={`column:${name}`} onClick={openRow}>{name}</button>;
                        }}
                    />
                </View>
            </AppShellPeekProvider>,
        );
    });
    return (kind: string) => container.querySelector<HTMLElement>(`[data-testid="rail-item:${kind}"]`)!;
}

// React derives pointerenter/leave from pointerover/out; jsdom may lack PointerEvent itself.
const pointerEnter = (el: Element) => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }));
const pointerLeave = (el: Element) => el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
const peek = () => container.querySelector<HTMLElement>('[data-testid^="app-shell-peek:"]');
const rest = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
/**
 * The Web Animations API is the browser boundary the peek moves through (jsdom has none): record each
 * animation the peek asks for — its keyframes and timing — as a running animation on its element.
 */
type RecordedAnimation = Readonly<{ target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; columnRendered: boolean }>;
const animations: RecordedAnimation[] = [];
const animationsOf = (el: Element) => animations.filter((a) => a.target === el);
(Element.prototype as unknown as { animate: unknown }).animate = function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    animations.push({ target: this, keyframes, options, columnRendered: this.querySelector('[data-testid^="column:"]') !== null });
    return { playState: 'running', effect: { target: this }, cancel: () => {} } as unknown as Animation;
};
const HIDDEN = `translate(-${COLUMN_WIDTH_PX}px, 0px)`;
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const hoverOpen = async (el: Element) => {
    await act(async () => { pointerEnter(el); });
    await rest(motionTokens.overlay.popover.hoverOpenDelayMs + 10);
};

describe('AppShellPeek', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        navigate.mockReset();
        openRow.mockReset();
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.useRealTimers();
    });

    it("shows another destination's column in the open column's place and size, and the current one again on leave", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const item = await renderShell({ currentId: 'plugins', columnShown: true });

        // The open destination's own icon does not peek its own column.
        await hoverOpen(item('plugins'));
        expect(peek()).toBeNull();
        await act(async () => { pointerLeave(item('plugins')); });

        await hoverOpen(item('sessions'));
        const layer = peek()!;
        expect(layer.getAttribute('data-testid')).toBe('app-shell-peek:sessions');
        expect(layer.querySelector('[data-testid="column:sessions"]')).not.toBeNull();
        const style = getComputedStyle(layer);
        expect([style.position, style.left, style.top, style.bottom, style.width]).toEqual(['absolute', '0px', '0px', '0px', `${COLUMN_WIDTH_PX}px`]);
        // A layer above the open column: its lift shows on the trailing edge.
        expect(style.boxShadow).not.toBe('');

        // Crossing into it keeps it, and it is the real, usable column.
        await act(async () => { pointerLeave(item('sessions')); });
        await act(async () => { pointerEnter(peek()!); });
        await rest(1000);
        expect(peek()).not.toBeNull();
        await act(async () => { container.querySelector<HTMLElement>('[data-testid="column:sessions"]')!.click(); });
        expect(openRow).toHaveBeenCalledTimes(1);

        await act(async () => { pointerLeave(peek()!); });
        await rest(1000);
        await rest(motionTokens.overlay.panel.exitMs + 10);
        expect(peek()).toBeNull();
    });

    it('floats the collapsed column at the same place and width, closes on Escape, and a click still navigates', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const item = await renderShell({ currentId: 'plugins', columnShown: false });

        await hoverOpen(item('plugins'));
        const style = getComputedStyle(peek()!);
        expect([style.left, style.width]).toEqual(['0px', `${COLUMN_WIDTH_PX}px`]);
        expect(style.boxShadow).not.toBe('');

        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        await rest(motionTokens.overlay.panel.exitMs + 10);
        expect(peek()).toBeNull();

        await act(async () => { item('sessions').click(); });
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(peek()).toBeNull();
    });

    it("peeks a plugin page's own column from its rail icon, keyed by the destination", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const item = await renderShell({ currentId: 'sessions', columnShown: true });
        await hoverOpen(item('plugin:acme.triage:triage'));
        expect(peek()?.getAttribute('data-testid')).toBe('app-shell-peek:plugin:acme.triage:triage');
        expect(container.querySelector('[data-testid="column:plugin:acme.triage:triage"]')).not.toBeNull();
    });

    it('does not flash a peek while the pointer passes across the rail', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        const passMs = motionTokens.overlay.popover.hoverOpenDelayMs / 2;
        animations.length = 0;
        for (const kind of ['sessions', 'plugin:acme.triage:triage'] as const) {
            await act(async () => { pointerEnter(item(kind)); });
            await rest(passMs);
            expect(peek()).toBeNull();
            await act(async () => { pointerLeave(item(kind)); });
        }
        await rest(1000);
        expect(peek()).toBeNull();
        expect(animations).toHaveLength(0);
    });

    it('slides in from under the rail, and moving to another icon swaps the column without entering again', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        await hoverOpen(item('sessions'));
        const layer = peek()!;
        expect(animationsOf(layer)).toEqual([expect.objectContaining({
            keyframes: [{ transform: HIDDEN }, { transform: 'none' }],
            options: expect.objectContaining({ duration: motionTokens.overlay.panel.enterMs }),
            // The plane starts sliding before the column renders, so a heavy column never holds the slide.
            columnRendered: false,
        })]);
        expect(layer.querySelector('[data-testid="column:sessions"]')).not.toBeNull();

        await act(async () => { pointerLeave(item('sessions')); });
        await act(async () => { pointerEnter(item('plugin:acme.triage:triage')); });
        expect(peek()).toBe(layer);
        expect(layer.querySelector('[data-testid="column:plugin:acme.triage:triage"]')).not.toBeNull();
        expect(animationsOf(layer)).toHaveLength(1);
    });

    it('leaves with a short exit that keeps the column, inert, and coming back during it turns it around at once', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        await hoverOpen(item('sessions'));
        const layer = peek()!;

        await act(async () => { pointerLeave(item('sessions')); });
        await rest(motionTokens.durationMs.fast + 1);
        // Leaving: sliding back under the rail with the column it showed, no longer taking the pointer.
        expect(peek()).toBe(layer);
        expect(animationsOf(layer).at(-1)).toMatchObject({
            keyframes: [expect.anything(), { transform: HIDDEN }],
            options: { duration: motionTokens.overlay.panel.exitMs },
        });
        expect(layer.querySelector('[data-testid="column:sessions"]')).not.toBeNull();
        expect(getComputedStyle(layer).pointerEvents).toBe('none');

        // Back on an icon before it is gone: it turns around from where it is, without a new rest.
        await act(async () => { pointerEnter(item('sessions')); });
        expect(peek()).toBe(layer);
        expect(getComputedStyle(layer).pointerEvents).not.toBe('none');
        const turn = animationsOf(layer).at(-1)!;
        expect(turn.keyframes[1]).toEqual({ transform: 'none' });
        expect(turn.keyframes[0]).toEqual({ transform: getComputedStyle(layer).transform });

        await act(async () => { pointerLeave(item('sessions')); });
        await rest(motionTokens.durationMs.fast + 1);
        await rest(motionTokens.overlay.panel.exitMs + 1);
        expect(peek()).toBeNull();
    });

    it('fades without moving when the host asks for reduced motion', async () => {
        fakeTimers();
        hostMotion.reduced = true;
        try {
            const item = await renderShell({ currentId: 'plugins', columnShown: true });
            await hoverOpen(item('sessions'));
            expect(animationsOf(peek()!)).toEqual([expect.objectContaining({
                keyframes: [{ opacity: 0 }, { opacity: 1 }],
                options: expect.objectContaining({ duration: motionTokens.overlay.panel.reducedMotionFadeMs }),
            })]);
        } finally {
            hostMotion.reduced = false;
        }
    });

    it('moves keyboard focus into the peeked column with the right arrow', async () => {
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        await act(async () => { item('sessions').focus(); });
        await act(async () => { item('sessions').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        await vi.waitFor(() => expect(peek()).not.toBeNull());
        await vi.waitFor(() => expect(peek()!.contains(document.activeElement)).toBe(true));
    });
});
