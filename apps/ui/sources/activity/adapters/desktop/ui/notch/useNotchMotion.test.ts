import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useNotchMotion, type NotchMotionTarget } from './useNotchMotion';

// Drive the animation runtime's completion notifications independently, as it can finish an
// unchanged width before a height spring. The hook owns when native may shrink its window.
const springFinished = vi.hoisted(() => new Map<number, (finished: boolean) => void>());
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        withSpring: (value: number, _config: unknown, callback?: (finished: boolean) => void) => {
            if (callback) springFinished.set(value, callback);
            return value;
        },
    };
});

afterEach(() => {
    springFinished.clear();
    standardCleanup();
});

describe('notch motion', () => {
    it('holds the native paint envelope until a height-only shrink finishes', async () => {
        const present = vi.fn<(settled: boolean) => void>();
        const open: NotchMotionTarget = {
            form: 'open',
            body: { width: 464, height: 780 },
            centre: { x: 0, y: 0 },
            corner: 24,
            shoulder: 8,
            standardShown: false,
            openShown: true,
        };
        const hook = await renderHook((target: NotchMotionTarget) => useNotchMotion({
            target,
            placementKey: 'left',
            reduceMotion: false,
            present,
        }), { initialProps: open });
        present.mockClear();
        springFinished.clear();

        await hook.rerender({ ...open, body: { ...open.body, height: 70 } });
        await act(async () => { springFinished.get(open.body.width)?.(true); });
        expect(present.mock.calls).toEqual([[false]]);

        await act(async () => { springFinished.get(70)?.(true); });
        expect(present.mock.calls).toEqual([[false], [true]]);
        await hook.unmount();
    });
});
