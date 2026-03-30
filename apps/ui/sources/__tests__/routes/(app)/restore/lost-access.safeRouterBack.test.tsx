import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { flushHookEffects, renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({
    back: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {},
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => ({
        features: {
            auth: {
                recovery: {
                    providerReset: { enabled: true },
                },
            },
        },
        capabilities: {
            auth: {
                recovery: {
                    providerReset: {
                        providers: [],
                    },
                },
            },
        },
    })),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router,
    }).module;
});

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('LostAccess route', () => {
    it('falls back to replace when router back is a no-op', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('location', { href: 'https://example.com/restore/lost-access' });

        const { default: LostAccess } = await import('@/app/(app)/restore/lost-access');
        const screen = await renderScreen(<LostAccess />);
        try {
            await flushHookEffects({ cycles: 4, turns: 2 });

            const backButton = screen.find((node) => node.props?.title === 'common.back' && typeof node.props?.onPress === 'function');
            expect(backButton).toBeTruthy();

            backButton.props.onPress();

            await vi.advanceTimersByTimeAsync(75);
            expect(router.replace).toHaveBeenCalledWith('/');
        } finally {
            vi.useRealTimers();
            await screen.unmount();
        }
    });
});
