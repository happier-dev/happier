/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { gestureTokens } from '@/components/ui/motion/gestureTokens';
import { getDesktopHostAvailability } from '@/utils/platform/desktopHost';
import type { DesktopOverlayDock } from '../runtime/resolveDesktopOverlayPolicy';
import { useNotchDrag, type NotchDragPointerEvent } from './useNotchDrag';

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
// Tauri event delivery is a native transport boundary; host role admission stays real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const handle = document.createElement('div');
handle.setPointerCapture = vi.fn();
handle.releasePointerCapture = vi.fn();
handle.hasPointerCapture = vi.fn();

function pointer(screenX: number, screenY: number, pointerId = 1): NotchDragPointerEvent {
    return { button: 0, isPrimary: true, pointerId, screenX, screenY, currentTarget: handle,
        preventDefault: vi.fn(), stopPropagation: vi.fn() };
}
async function frame() {
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback(0);
    await Promise.resolve();
    await Promise.resolve();
}
function moves() { return invoke.mock.calls.filter(([command]) => command === 'desktop_activity_overlay_move').map(([, args]) => args); }

beforeEach(async () => {
    const captured = new Set<number>();
    vi.mocked(handle.setPointerCapture).mockReset().mockImplementation(id => { captured.add(id); });
    vi.mocked(handle.releasePointerCapture).mockReset().mockImplementation(id => { captured.delete(id); });
    vi.mocked(handle.hasPointerCapture).mockReset().mockImplementation(id => captured.has(id));
    nextFrame = 0;
    frames = new Map();
    invoke.mockImplementation(async command => command === 'desktop_host_get_availability'
        ? { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } } : undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    await getDesktopHostAvailability();
});
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); invoke.mockReset(); });

describe('notch movement at the native IPC boundary', () => {
    it.each(['top', 'left', 'right', 'floating'] as const)('notch.F6.drag%s masks movement and coalesces 120 samples into frame calls', async dock => {
        const hook = await renderHook(() => useNotchDrag(dock));
        hook.getCurrent().onPointerDown(pointer(300, 200));
        for (let index = 1; index <= 120; index++) {
            hook.getCurrent().onPointerMove(pointer(300 + index * 2, 200 + index));
            if (index % 2 === 0) {
                const previousCalls = moves().length;
                await frame();
                expect(moves().length - previousCalls).toBeLessThanOrEqual(1);
            }
        }
        expect(moves().length).toBeGreaterThan(1);
        expect(moves().every(args => args?.commit === false)).toBe(true);
        hook.getCurrent().onPointerUp(pointer(540, 320));
        await frame();
        const commands = moves();
        expect(commands.length).toBeGreaterThan(0);
        expect(commands.length).toBeLessThanOrEqual(61);
        const sum = commands.reduce<{ x: number; y: number }>((total, args) => {
            const delta = args?.delta as { x: number; y: number };
            return { x: total.x + delta.x, y: total.y + delta.y };
        }, { x: 0, y: 0 });
        expect(sum).toEqual({ x: dock === 'left' || dock === 'right' ? 0 : 240, y: dock === 'top' ? 0 : 120 });
        expect(commands.filter(args => args?.commit === true)).toHaveLength(1);
        expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
        expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
        const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        hook.getCurrent().onClickCapture(click);
        expect(click.preventDefault).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
    });

    it('keeps a press within the shared slop and movement perpendicular to an edge as clicks', async () => {
        const hook = await renderHook(() => useNotchDrag('top'));
        hook.getCurrent().onPointerDown(pointer(100, 100));
        hook.getCurrent().onPointerMove(pointer(100 + gestureTokens.slopPx, 300));
        hook.getCurrent().onPointerUp(pointer(100 + gestureTokens.slopPx, 300));
        await frame();
        const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        hook.getCurrent().onClickCapture(click);
        expect(click.preventDefault).not.toHaveBeenCalled();
        expect(moves()).toEqual([]);
    });

    it('notch.F6.drag-floating merges the release sample into the pending frame and ignores another pointer', async () => {
        const hook = await renderHook(() => useNotchDrag('floating'));
        hook.getCurrent().onPointerDown(pointer(20, 30));
        hook.getCurrent().onPointerMove(pointer(40, 60));
        hook.getCurrent().onPointerMove(pointer(900, 900, 2));
        hook.getCurrent().onPointerUp(pointer(45, 70));
        expect(moves()).toEqual([]);
        await frame();
        expect(moves()).toEqual([{ delta: { x: 25, y: 40 }, commit: true }]);
    });

    it('commits consecutive gestures once each and cancels scheduled work on unmount', async () => {
        const hook = await renderHook(() => useNotchDrag('floating'));
        for (const x of [0, 40]) {
            hook.getCurrent().onPointerDown(pointer(x, 0));
            hook.getCurrent().onPointerMove(pointer(x + 20, 30));
            hook.getCurrent().onPointerUp(pointer(x + 20, 30));
        }
        await frame();
        expect(moves()).toHaveLength(1);
        await frame();
        expect(moves().filter(args => args?.commit)).toHaveLength(2);
        hook.getCurrent().onPointerDown(pointer(100, 100));
        hook.getCurrent().onPointerMove(pointer(150, 150));
        await hook.unmount();
        expect(frames.size).toBe(0);
    });

    it('commits capture loss without releasing an already lost native pointer', async () => {
        const hook = await renderHook(() => useNotchDrag('floating'));
        hook.getCurrent().onPointerDown(pointer(0, 0));
        hook.getCurrent().onPointerMove(pointer(30, 20));
        handle.hasPointerCapture = vi.fn(() => false);
        vi.mocked(handle.releasePointerCapture).mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
        expect(() => hook.getCurrent().onLostPointerCapture(pointer(30, 20))).not.toThrow();
        await frame();
        expect(moves()).toEqual([{ delta: { x: 30, y: 20 }, commit: true }]);
    });
});
