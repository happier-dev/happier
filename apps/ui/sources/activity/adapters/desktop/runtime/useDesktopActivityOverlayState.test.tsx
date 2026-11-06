import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { type DesktopActivityOverlayWindowStatePayload } from './desktopActivityOverlayBridge';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { reconcileDesktopActivityOverlayState, useDesktopActivityOverlayField, useDesktopActivityOverlayState } from './useDesktopActivityOverlayState';

// Native command/event transport is the system boundary; the hook and bridge stay real.
const native = vi.hoisted(() => ({
    isDesktopHost: vi.fn(() => true),
    invoke: vi.fn<(command: string) => Promise<DesktopActivityOverlayWindowStatePayload | null>>(),
    listen: vi.fn<(event: string, handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => native.isDesktopHost(),
    requireDesktopHostRole: async () => {},
    invokeDesktopHost: (command: string) => native.invoke(command),
    listenDesktopHostEvent: (event: string, handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        native.listen(event, handler),
}));

function windowState(overrides: Partial<DesktopActivityOverlayWindowStatePayload> = {}): DesktopActivityOverlayWindowStatePayload {
    return {
        visible: true,
        surface: 'collapsed',
        model: {
            visible: true,
            generatedAt: 1,
            faces: { faces: [], overflowCount: 0 },
            conversation: null,
            collapsed: { title: 'Sessions', statusText: null, defaultTarget: 'open-primary-session', sessionCount: 1, activity: 'quiet' },
            expanded: { title: 'Sessions', rows: [] },
        },
        policy: resolveDesktopOverlayPolicy({ desktopOverlayEnabled: true }),
        ...overrides,
    };
}

describe('useDesktopActivityOverlayState', () => {
    it('retains transport-equivalent optional facts and publishes a changed sibling', () => {
        const previous = windowState({ frame: {
            dock: 'top', growth: { x: null, y: 'down' }, anchorOffset: { x: 0, y: 0 },
            screenOrigin: undefined,
        } });
        const next = windowState({ frame: {
            dock: 'top', growth: { x: null, y: 'down' }, anchorOffset: { x: 0, y: 0 },
        } });
        expect(reconcileDesktopActivityOverlayState(previous, next)).toBe(previous);
        const changed = reconcileDesktopActivityOverlayState(previous, { ...next, visible: false });
        expect(changed.visible).toBe(false);
        expect(changed.frame).toBe(previous.frame);
    });
    it('keeps unchanged face identities when a changed Bot moves in the shared order', () => {
        const face = (sessionId: string) => ({ serverId: 'home', sessionId, face: { seed: sessionId, face: null },
            name: sessionId, activity: 'quiet' as const, currentLine: null, meaningfulActivityAt: 1,
            live: true, agentId: null, machineId: null });
        // Same bare Session id on two Homes must remain two independent identities.
        const a = face('a'); const b = { ...face('a'), serverId: 'other-home' }; const c = face('c');
        const initial = windowState();
        const previous = { ...initial, model: { ...initial.model, faces: { faces: [a, b, c], overflowCount: 0 } } };
        const next = { ...initial, model: { ...initial.model, faces: {
            faces: [{ ...b, activity: 'needsYou' as const }, { ...a }, { ...c }], overflowCount: 0,
        } } };
        const reconciled = reconcileDesktopActivityOverlayState(previous, next);
        expect(reconciled.model.faces.faces[1]).toBe(a);
        expect(reconciled.model.faces.faces[2]).toBe(c);
        expect(reconciled.model.faces.faces[0]).not.toBe(b);
    });
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('window', { location: { href: 'https://happier.test/desktop/activity-overlay' } });
        native.isDesktopHost.mockReturnValue(true);
        native.invoke.mockResolvedValue(windowState());
        native.listen.mockResolvedValue(() => {});
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        native.invoke.mockReset();
        native.listen.mockReset();
    });

    it('gives the overlay route the applied screen origin without rerendering on content updates', async () => {
        const initial = windowState({ frame: {
            dock: 'top', growth: { x: null, y: 'down' }, anchorOffset: { x: 0, y: 0 },
            screenOrigin: { x: -200, y: -100, scaleFactor: 2 },
        } });
        native.invoke.mockResolvedValue(initial);
        let receive: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | undefined;
        native.listen.mockImplementation(async (_event, handler) => { receive = handler; return () => {}; });
        let renders = 0;
        const origin = await renderHook(() => { renders += 1; return useDesktopActivityOverlayField('screenOrigin'); });
        await flushHookEffects();
        expect(origin.getCurrent()).toEqual({ x: -200, y: -100, scaleFactor: 2 });
        const before = renders;
        const changedContent = { ...initial, model: { ...initial.model, generatedAt: 2,
            collapsed: { ...initial.model.collapsed, statusText: 'Working' } } };
        await act(async () => { receive?.(changedContent); });
        expect(renders).toBe(before);
        const nextFrame = { ...initial.frame!, screenOrigin: { x: -150, y: 30, scaleFactor: 1.5 } };
        await act(async () => { receive?.({ ...initial, frame: nextFrame }); });
        expect(origin.getCurrent()).toEqual({ x: -150, y: 30, scaleFactor: 1.5 });
        expect(renders).toBe(before + 1);
        origin.unmount();
    });

    it('catches up changes during listener registration, then stays idle until native events', async () => {
        const subscription = createDeferred<() => void>();
        const initial = windowState();
        const expanded = windowState({ surface: 'expanded' });
        native.invoke.mockResolvedValueOnce(initial).mockResolvedValue(expanded);
        native.listen.mockReturnValue(subscription.promise);

        const hook = await renderHook(useDesktopActivityOverlayState);
        expect(hook.getCurrent()).toEqual(initial);

        subscription.resolve(() => {});
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expanded);
        const readsAfterCatchUp = native.invoke.mock.calls.length;

        await flushHookEffects({ cycles: 1, advanceTimersMs: 10_000 });
        expect(native.invoke).toHaveBeenCalledTimes(readsAfterCatchUp);
        expect(native.listen).toHaveBeenCalledWith('activityOverlay://state', expect.any(Function));

        const onState = native.listen.mock.calls[0][1];
        const hidden = windowState({ visible: false });
        await act(async () => onState(hidden));
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(hidden);
    });

    it('runs listener-gap catch-up even while the initial native read was still pending', async () => {
        const initialRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        const subscription = createDeferred<() => void>();
        native.invoke.mockReturnValueOnce(initialRead.promise).mockResolvedValue(windowState({ surface: 'expanded' }));
        native.listen.mockReturnValue(subscription.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);

        subscription.resolve(() => {});
        await flushHookEffects();
        initialRead.resolve(windowState());
        await flushHookEffects();
        expect(hook.getCurrent()?.surface).toBe('expanded');
    });

    it('does not let initial or catch-up snapshots overwrite newer native events', async () => {
        const initialRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        const catchUpRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        native.invoke.mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(catchUpRead.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);

        const expanded = windowState({ surface: 'expanded' });
        await act(async () => native.listen.mock.calls[0][1](expanded));
        await flushHookEffects();
        initialRead.resolve(windowState());
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expanded);

        const hidden = windowState({ visible: false });
        await act(async () => native.listen.mock.calls[0][1](hidden));
        await flushHookEffects();
        catchUpRead.resolve(expanded);
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(hidden);
    });

    it('retains unchanged snapshot identity for duplicate native publication', async () => {
        const hook = await renderHook(useDesktopActivityOverlayState);
        const current = hook.getCurrent();
        await act(async () => native.listen.mock.calls[0][1](windowState()));
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(current);
    });

    it('shares observation across scoped consumers and preserves unchanged leaves on detail changes', async () => {
        let visibleRenders = 0;
        let wordRenders = 0;
        let detailRenders = 0;
        const visible = await renderHook(() => { visibleRenders += 1; return useDesktopActivityOverlayField('visible'); });
        const word = await renderHook(() => { wordRenders += 1; return useDesktopActivityOverlayField('word'); });
        const detail = await renderHook(() => { detailRenders += 1; return useDesktopActivityOverlayField('listDetail'); });
        const oldWord = word.getCurrent();
        const oldDetail = detail.getCurrent();
        const before = { visibleRenders, wordRenders, detailRenders };
        expect(native.listen).toHaveBeenCalledTimes(1);
        const changed = windowState();
        const next = { ...changed, model: { ...changed.model, generatedAt: 99,
            expanded: { ...changed.model.expanded, rows: [{ sessionId: 'detail-session', serverId: 'home', title: 'Changed', subtitle: null, statusText: null, previewText: null }] } } };
        await act(async () => native.listen.mock.calls[0][1](next));
        await flushHookEffects();
        expect(visibleRenders).toBe(before.visibleRenders);
        expect(wordRenders).toBe(before.wordRenders);
        expect(detailRenders).toBe(before.detailRenders + 1);
        expect(word.getCurrent()).toBe(oldWord);
        expect(detail.getCurrent()).not.toBe(oldDetail);
        await act(async () => native.listen.mock.calls[0][1]({ ...next, model: { ...next.model, generatedAt: 100 } }));
        await flushHookEffects();
        expect(detailRenders).toBe(before.detailRenders + 1);
        await act(async () => native.listen.mock.calls[0][1]({ ...next, visible: false }));
        await flushHookEffects();
        expect(visible.getCurrent()).toBe(false);
        expect(visibleRenders).toBe(before.visibleRenders + 1);
        await visible.unmount();
        await word.unmount();
        await detail.unmount();
    });

    it('renders the blocking-card summary only when a request appears or the last one leaves', async () => {
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useDesktopActivityOverlayField('blockingCard');
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(false);
        const before = renders;
        const initial = windowState();
        for (let index = 0; index < 40; index += 1) {
            await act(async () => native.listen.mock.calls[0][1]({ ...initial, model: { ...initial.model,
                expanded: { title: 'Sessions', rows: [{ sessionId: 's', serverId: 'home', title: `Update ${index}`,
                    subtitle: null, statusText: null, previewText: null }] },
            } }));
        }
        expect(renders - before).toBe(0);
        const { buildDesktopActivityOverlayQaModel } = await import('./desktopActivityOverlayQaFixtures.mjs');
        const asking = { ...initial, model: { ...buildDesktopActivityOverlayQaModel('permission_request'), generatedAt: 1 } };
        await act(async () => native.listen.mock.calls[0][1](asking));
        expect(hook.getCurrent()).toBe(true);
        expect(renders - before).toBe(1);
        await act(async () => native.listen.mock.calls[0][1]({ ...asking, model: { ...asking.model,
            expanded: { ...asking.model.expanded, title: 'A different list title' },
        } }));
        expect(renders - before).toBe(1);
        await act(async () => native.listen.mock.calls[0][1](initial));
        expect(hook.getCurrent()).toBe(false);
        expect(renders - before).toBe(2);
        hook.unmount();
    });

    it('disposes a subscription that resolves after unmount without issuing catch-up', async () => {
        const subscription = createDeferred<() => void>();
        native.listen.mockReturnValue(subscription.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);
        await hook.unmount();
        const dispose = vi.fn();
        subscription.resolve(dispose);
        await flushHookEffects();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(native.invoke).toHaveBeenCalledTimes(1);
    });

    it('leaves browser and main-window contexts without native observation', async () => {
        native.isDesktopHost.mockReturnValue(false);
        const browser = await renderHook(useDesktopActivityOverlayState);
        expect(browser.getCurrent()).toBeNull();
        await browser.unmount();
        native.isDesktopHost.mockReturnValue(true);
        vi.stubGlobal('window', { location: { href: 'https://happier.test/' } });
        const main = await renderHook(useDesktopActivityOverlayState);
        expect(main.getCurrent()).toBeNull();
        expect(native.invoke).not.toHaveBeenCalled();
        expect(native.listen).not.toHaveBeenCalled();
    });
});
