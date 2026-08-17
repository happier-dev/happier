/**
 * @vitest-environment jsdom
 */
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

const platformState = vi.hoisted(() => ({ os: 'web' }));
const springCalls = vi.hoisted(() => [] as unknown[]);
const timingCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const base = createReanimatedModuleMock() as Record<string, unknown>;
    return {
        ...base,
        default: (base as { default?: unknown }).default,
        withSpring: <T,>(value: T, config?: unknown): T => {
            springCalls.push(config);
            return value;
        },
        withTiming: <T,>(value: T, config?: unknown): T => {
            timingCalls.push(config);
            return value;
        },
    };
});

import { useVoiceOrbDrag } from './useVoiceOrbDrag';

function pointerEvent(type: string, x: number, y: number, timeStamp: number): MouseEvent {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
    });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    return event;
}

describe('useVoiceOrbDrag reduced motion', () => {
    beforeEach(() => {
        platformState.os = 'web';
        springCalls.length = 0;
        timingCalls.length = 0;
    });

    it('snaps web lift and release while keeping pointer movement direct', async () => {
        const hook = await renderHook(() => useVoiceOrbDrag({
            bounds: { minX: 12, maxX: 282, minY: 71, maxY: 394 },
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            onDragRelease: vi.fn(),
            motionPolicy: 'snap',
        }));
        const handle = document.createElement('div');
        handle.setAttribute('data-voice-orb', 'true');
        document.body.appendChild(handle);
        hook.getCurrent().dragTargetRef(handle as never);

        await act(async () => {
            handle.dispatchEvent(pointerEvent('pointerdown', 120, 200, 0));
            window.dispatchEvent(pointerEvent('pointermove', 155, 180, 20));
        });
        expect(hook.getCurrent().translateX.value).toBe(155);
        expect(hook.getCurrent().translateY.value).toBe(180);
        expect(hook.getCurrent().dragProgress.value).toBe(1);

        await act(async () => {
            window.dispatchEvent(pointerEvent('pointerup', 155, 180, 40));
        });

        expect(springCalls).toHaveLength(0);
        expect(timingCalls).toHaveLength(0);
        expect(hook.getCurrent().dragProgress.value).toBe(0);

        hook.getCurrent().dragTargetRef(null);
        handle.remove();
        await hook.unmount();
    });

    it('does not attach or start the web pointer session while drag is disabled', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook((enabled: boolean) => useVoiceOrbDrag({
            bounds: { minX: 12, maxX: 282, minY: 71, maxY: 394 },
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            onDragRelease,
            motionPolicy: 'snap',
            enabled,
        }), { initialProps: true });
        const handle = document.createElement('div');
        handle.setAttribute('data-voice-orb', 'true');
        document.body.appendChild(handle);
        const removeEventListener = vi.spyOn(handle, 'removeEventListener');
        hook.getCurrent().dragTargetRef(handle as never);

        // Expanded can be entered after a collapsed mount, so the transition must detach the
        // listener that was already live rather than only declining to attach a new one.
        await hook.rerender(false);
        expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));

        const pointerDown = pointerEvent('pointerdown', 120, 200, 0);
        await act(async () => {
            handle.dispatchEvent(pointerDown);
            window.dispatchEvent(pointerEvent('pointermove', 175, 150, 20));
            window.dispatchEvent(pointerEvent('pointerup', 175, 150, 40));
        });

        expect(pointerDown.defaultPrevented).toBe(false);
        expect(hook.getCurrent().translateX.value).toBe(120);
        expect(hook.getCurrent().translateY.value).toBe(200);
        expect(hook.getCurrent().dragProgress.value).toBe(0);
        expect(hook.getCurrent().shouldSuppressPress()).toBe(false);
        expect(onDragRelease).not.toHaveBeenCalled();

        hook.getCurrent().dragTargetRef(null);
        handle.remove();
        await hook.unmount();
    });
});
