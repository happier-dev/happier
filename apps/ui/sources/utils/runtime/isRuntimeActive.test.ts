import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            get currentState() {
                return appState.currentState;
            },
        },
    });
});

describe('isRuntimeActive', () => {
    it('treats the web appState "unknown" as active (so probes can run)', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'unknown';
        expect(isRuntimeActive()).toBe(true);
    });

    it('treats the web appState "background" as inactive', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'background';
        expect(isRuntimeActive()).toBe(false);
    });
});
