import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const scheduler = vi.hoisted(() => ({ runtime: 'js' as 'js' | 'ui' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default } });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        // Native worklets and JS have separate frame queues. A busy JS runtime must not
        // prevent the UI runtime from completing the composer's arrival.
        runOnUI: (worklet: () => void) => () => {
            scheduler.runtime = 'ui';
            try { worklet(); } finally { scheduler.runtime = 'js'; }
        },
    };
});

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

it('settles the card and scrim on a native frame while JS frame callbacks are delayed', async () => {
    const frames = { js: [] as FrameRequestCallback[], ui: [] as FrameRequestCallback[] };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames[scheduler.runtime].push(callback));
    const { useFloatingComposerEntrance } = await import('./useFloatingComposerEntrance');
    const hook = await renderHook(() => useFloatingComposerEntrance(true));

    await act(async () => { hook.getCurrent().onComposerLayout?.(); });
    // Deliver the platform's next UI frame without delivering the stalled JS frames.
    await act(async () => { for (const frame of frames.ui.splice(0)) frame(16); });

    expect(hook.getCurrent().enterProgress.value).toBe(1);
});
