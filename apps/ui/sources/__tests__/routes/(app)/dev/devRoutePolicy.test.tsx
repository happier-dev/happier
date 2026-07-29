import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/voice/qa/VoiceQaScreen', () => ({
    default: () => React.createElement('VoiceQaControllerMounted'),
}));

type DevGlobal = typeof globalThis & { __DEV__?: boolean };

async function withDevRouteEnvironment<T>(
    dev: boolean,
    debug: string | undefined,
    run: () => Promise<T>,
): Promise<T> {
    const target = globalThis as DevGlobal;
    const hadDev = Object.prototype.hasOwnProperty.call(target, '__DEV__');
    const previousDev = target.__DEV__;
    const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
    vi.stubGlobal('__DEV__', dev);
    if (debug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
    else process.env.EXPO_PUBLIC_DEBUG = debug;
    try {
        return await run();
    } finally {
        if (hadDev) vi.stubGlobal('__DEV__', previousDev);
        else Reflect.deleteProperty(target, '__DEV__');
        if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
        else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
    }
}

describe('dev route policy', () => {
    it('fails closed outside dev and explicit debug-export builds', async () => {
        const { isDevRouteEnabled } = await import('@/auth/routing/devRoutePolicy');

        await withDevRouteEnvironment(false, undefined, async () => {
            expect(isDevRouteEnabled()).toBe(false);
        });
        await withDevRouteEnvironment(true, undefined, async () => {
            expect(isDevRouteEnabled()).toBe(true);
        });
        await withDevRouteEnvironment(false, '1', async () => {
            expect(isDevRouteEnabled()).toBe(true);
        });
    });

    it('does not mount the dev navigator when the route policy is disabled', async () => {
        const { default: DevLayout } = await import('@/app/(app)/dev/_layout');

        await withDevRouteEnvironment(false, undefined, async () => {
            const screen = await renderScreen(<DevLayout />);
            expect(screen.tree.toJSON()).toBeNull();
        });
    });

    it('does not mount the voice QA controller when its route policy is disabled', async () => {
        const { default: VoiceQaRoute } = await import('@/app/(app)/dev/voice-qa');

        await withDevRouteEnvironment(false, undefined, async () => {
            const screen = await renderScreen(<VoiceQaRoute />);
            expect(screen.tree.root.findAllByType('VoiceQaControllerMounted')).toHaveLength(0);
        });
    });
});
