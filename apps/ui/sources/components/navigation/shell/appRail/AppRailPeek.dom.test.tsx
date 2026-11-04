/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

// The host's reduce-motion preference (a media query on the web) is the boundary.
const hostMotion = {
    reduced: false,
    listeners: new Set<(event: Readonly<{ matches: boolean }>) => void>(),
};
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
    get matches() { return query === '(prefers-reduced-motion: reduce)' && hostMotion.reduced; },
    addEventListener: (_type: string, listener: (event: Readonly<{ matches: boolean }>) => void) => {
        if (query === '(prefers-reduced-motion: reduce)') hostMotion.listeners.add(listener);
    },
}) });

function setHostReducedMotion(reduced: boolean) {
    hostMotion.reduced = reduced;
    for (const listener of hostMotion.listeners) listener({ matches: reduced });
}
afterAll(() => {
    if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
});

const { View } = await import('react-native');
const { appShellColumnSurface } = await import('./appShellColumnSurface');
const { AppRailPeek } = await import('./AppRailPeek');
const { AppRailHoverScope, AppShellPeekCovered, AppShellPeekLayer, AppShellPeekProvider } = await import('./AppShellPeek');
const { useHoverPreviewPopover } = await import('@/components/ui/popover/useHoverPreviewPopover');
type AppShellShownColumn = import('./appRailModel').AppShellShownColumn;
const { motionTokens } = await import('@/components/ui/motion');

const COLUMN_WIDTH_PX = 320;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigate = vi.fn();
const openRow = vi.fn();

/** A rail popover (Usage, Machines): its own hover preview, inside the rail's one hover intent. */
function RailPopoverProbe() {
    const { mode, hoverProps } = useHoverPreviewPopover({ enabled: true });
    return <View testID="rail-popover-trigger" {...hoverProps}>{mode !== 'closed' ? <View testID="rail-popover" /> : null}</View>;
}

/**
 * The shell as `SidebarNavigator` and the frame compose it: rail triggers in the rail's hover scope, and
 * the peek layer in the column's place — on the open column's plane over its covered content, or
 * floating after the rail while the column is collapsed.
 */
/** Peeks are keyed by destination: a plugin page with its own column peeks exactly like a built-in. */
const COLUMNS_BY_DESTINATION: Record<string, AppShellShownColumn> = {
    sessions: { kind: 'builtin', id: 'sessions' },
    plugins: { kind: 'builtin', id: 'plugins' },
    'plugin:acme.triage:triage': { kind: 'plugin', destinationId: 'plugin:acme.triage:triage' },
};

async function renderShell(params: Readonly<{ currentId: string; columnShown: boolean }>) {
    const layer = (
        <AppShellPeekLayer
            widthPx={COLUMN_WIDTH_PX}
            resolveColumn={(destinationId) => COLUMNS_BY_DESTINATION[destinationId] ?? null}
            renderColumn={(column) => {
                const name = column.kind === 'builtin' ? column.id : column.destinationId;
                return <button data-testid={`column:${name}`} onClick={openRow}>{name}</button>;
            }}
        />
    );
    await act(async () => {
        root.render(
            <AppShellPeekProvider enabled currentId={params.currentId} columnShown={params.columnShown}>
                <AppRailHoverScope>
                    {(['sessions', 'plugins', 'plugin:acme.triage:triage'] as const).map((kind) => (
                        <AppRailPeek key={kind} testID={`rail-peek:${kind}`} destinationId={kind}>
                            {() => <button data-testid={`rail-item:${kind}`} onClick={navigate}>{kind}</button>}
                        </AppRailPeek>
                    ))}
                    <RailPopoverProbe />
                </AppRailHoverScope>
                <View testID="plane-reference" style={appShellColumnSurface.plane} />
                <View testID="sheet" style={{ position: 'relative', width: 1000, height: 800 }}>
                    {params.columnShown ? (
                        <View testID="docked-column" style={[appShellColumnSurface.column, { width: COLUMN_WIDTH_PX, height: 800 }]}>
                            <AppShellPeekCovered><View testID="docked-content" /></AppShellPeekCovered>
                            {layer}
                        </View>
                    ) : <View testID="floating-host">{layer}</View>}
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
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The coat a surface paints: the first opaque-ish background on it or below it. */
const coatOf = (el: HTMLElement) => [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]
    .map((node) => getComputedStyle(node).backgroundColor)
    .find((color) => color !== '' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)');
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
    await rest(motionTokens.overlay.popover.dockHoverOpenDelayMs + 10);
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

    it("stands in the open column's place, on its plane: the two cross-fade, nothing travels and no edge appears", async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        // The open column's content rests where it is when it mounts; only a peek moves it.
        expect(animationsOf(byTestId('docked-content')!.parentElement!)).toHaveLength(0);

        // The open destination's own icon does not peek its own column.
        await hoverOpen(item('plugins'));
        expect(peek()).toBeNull();
        await act(async () => { pointerLeave(item('plugins')); });
        await rest(1000);

        animations.length = 0;
        await hoverOpen(item('sessions'));
        const layer = peek()!;
        const docked = byTestId('docked-column')!;
        expect(layer.getAttribute('data-testid')).toBe('app-shell-peek:sessions');
        expect(layer.querySelector('[data-testid="column:sessions"]')).not.toBeNull();
        // On the open column's plane, filling it: no coat, no lift and no width of its own.
        expect(docked.contains(layer)).toBe(true);
        const style = getComputedStyle(layer);
        expect([style.position, style.left, style.right, style.top, style.bottom]).toEqual(['absolute', '0px', '0px', '0px', '0px']);
        expect(layer.querySelector('[data-happy-glass-backdrop]')).toBeNull();
        expect(getComputedStyle(layer).backgroundColor).toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/);
        expect(style.boxShadow).toBe('');
        // Once the peeked column has rendered (the place never stands empty), it fades in while the open
        // one fades out under it, over the same time.
        const content = byTestId('docked-content')!.parentElement!;
        expect(animationsOf(layer)).toEqual([expect.objectContaining({
            keyframes: [{ opacity: 0 }, { opacity: 1 }],
            options: expect.objectContaining({ duration: motionTokens.overlay.panel.crossfadeMs }),
            columnRendered: true,
        })]);
        expect(animationsOf(content)).toEqual([expect.objectContaining({
            keyframes: [{ opacity: 1 }, { opacity: 0 }],
            options: expect.objectContaining({ duration: motionTokens.overlay.panel.crossfadeMs }),
        })]);
        expect(animations.some((a) => a.keyframes.some((frame) => 'transform' in frame))).toBe(false);

        // Crossing into it keeps it, and it is the real, usable column.
        await act(async () => { pointerLeave(item('sessions')); });
        await act(async () => { pointerEnter(peek()!); });
        await rest(1000);
        expect(peek()).not.toBeNull();
        await act(async () => { byTestId('column:sessions')!.click(); });
        expect(openRow).toHaveBeenCalledTimes(1);

        // Leaving fades it out and the open column back in.
        await act(async () => { pointerLeave(peek()!); });
        await rest(motionTokens.durationMs.fast + 1);
        expect(animationsOf(layer).at(-1)).toMatchObject({ keyframes: [expect.anything(), { opacity: 0 }] });
        expect(animationsOf(content).at(-1)).toMatchObject({ keyframes: [expect.anything(), { opacity: 1 }] });
        await rest(motionTokens.overlay.panel.crossfadeMs + 10);
        expect(peek()).toBeNull();
    });

    it('floats the collapsed column at the same width in the column plane, lifted, closes on Escape, and a click still navigates', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: false });

        await hoverOpen(item('plugins'));
        const layer = peek()!;
        expect(byTestId('floating-host')!.contains(layer)).toBe(true);
        const style = getComputedStyle(layer);
        expect([style.left, style.width]).toEqual(['0px', `${COLUMN_WIDTH_PX}px`]);
        // The same plane as the docked column, so it reads as the column itself; its lift falls on the page.
        expect(coatOf(layer)).toBe(getComputedStyle(byTestId('plane-reference')!).backgroundColor);
        expect(style.boxShadow).not.toBe('');

        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        await rest(motionTokens.overlay.panel.exitMs + 10);
        expect(peek()).toBeNull();

        await act(async () => { item('sessions').click(); });
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(peek()).toBeNull();
    });

    it("peeks a plugin page's own column from its rail icon, keyed by the destination", async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'sessions', columnShown: true });
        await hoverOpen(item('plugin:acme.triage:triage'));
        expect(peek()?.getAttribute('data-testid')).toBe('app-shell-peek:plugin:acme.triage:triage');
        expect(byTestId('column:plugin:acme.triage:triage')).not.toBeNull();
    });

    it('is a dock: a short rest opens the first peek, shorter than a popover rest', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        expect(motionTokens.overlay.popover.dockHoverOpenDelayMs).toBeLessThan(motionTokens.overlay.popover.hoverOpenDelayMs);
        await act(async () => { pointerEnter(item('sessions')); });
        await rest(motionTokens.overlay.popover.dockHoverOpenDelayMs - 10);
        expect(peek()).toBeNull();
        await rest(20);
        expect(peek()?.getAttribute('data-testid')).toBe('app-shell-peek:sessions');
    });

    it('does not flash a peek while the pointer passes across the rail', async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        const passMs = motionTokens.overlay.popover.dockHoverOpenDelayMs / 2;
        animations.length = 0;
        for (const kind of ['sessions', 'plugin:acme.triage:triage'] as const) {
            await act(async () => { pointerEnter(item(kind)); });
            await rest(passMs);
            expect(peek()).toBeNull();
            await act(async () => { pointerLeave(item(kind)); });
        }
        await act(async () => { pointerEnter(byTestId('rail-popover-trigger')!); });
        await rest(passMs);
        await act(async () => { pointerLeave(byTestId('rail-popover-trigger')!); });
        await rest(1000);
        expect(peek()).toBeNull();
        expect(byTestId('rail-popover')).toBeNull();
        expect(animations).toHaveLength(0);
    });

    it("answers one intent across the rail: moving between a peek and a rail popover opens the next at once and the other goes", async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: true });
        await hoverOpen(item('sessions'));
        expect(peek()).not.toBeNull();

        // Onto a rail popover's icon: it opens with no rest, and the peek leaves at once (no grace overlap).
        await act(async () => { pointerLeave(item('sessions')); });
        await act(async () => { pointerEnter(byTestId('rail-popover-trigger')!); });
        expect(byTestId('rail-popover')).not.toBeNull();
        expect(getComputedStyle(peek()!).pointerEvents).toBe('none');

        // And back onto a column icon: the peek opens at once and the popover closes.
        await act(async () => { pointerLeave(byTestId('rail-popover-trigger')!); });
        await act(async () => { pointerEnter(item('plugin:acme.triage:triage')); });
        expect(peek()?.getAttribute('data-testid')).toBe('app-shell-peek:plugin:acme.triage:triage');
        expect(getComputedStyle(peek()!).pointerEvents).not.toBe('none');
        expect(byTestId('rail-popover')).toBeNull();

        // Leaving the rail closes it; a rail icon entered just after reopens at once, a later one rests again.
        await act(async () => { pointerLeave(item('plugin:acme.triage:triage')); });
        await rest(motionTokens.durationMs.fast + 1);
        await act(async () => { pointerEnter(byTestId('rail-popover-trigger')!); });
        expect(byTestId('rail-popover')).not.toBeNull();
        await act(async () => { pointerLeave(byTestId('rail-popover-trigger')!); });
        await rest(motionTokens.durationMs.fast + motionTokens.overlay.popover.hoverOpenDelayMs + 10);
        await act(async () => { pointerEnter(item('sessions')); });
        expect(peek() === null || getComputedStyle(peek()!).pointerEvents === 'none').toBe(true);
        await rest(motionTokens.overlay.popover.dockHoverOpenDelayMs + 10);
        expect(peek()?.getAttribute('data-testid')).toBe('app-shell-peek:sessions');
    });

    it("slides out from under the rail's edge when the column is collapsed, and moving to another icon swaps the column without entering again", async () => {
        fakeTimers();
        const item = await renderShell({ currentId: 'plugins', columnShown: false });
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
        const item = await renderShell({ currentId: 'plugins', columnShown: false });
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
        await act(async () => { setHostReducedMotion(true); });
        try {
            const item = await renderShell({ currentId: 'plugins', columnShown: false });
            await hoverOpen(item('sessions'));
            expect(animationsOf(peek()!)).toEqual([expect.objectContaining({
                keyframes: [{ opacity: 0 }, { opacity: 1 }],
                options: expect.objectContaining({ duration: motionTokens.overlay.panel.reducedMotionFadeMs }),
            })]);
        } finally {
            await act(async () => { setHostReducedMotion(false); });
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
