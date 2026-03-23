import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceSpy = vi.fn();
const useLocalSearchParamsMock = vi.fn(() => ({ error: 'restore_required' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace: replaceSpy },
        params: useLocalSearchParamsMock(),
    });
    return expoRouterMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        loginWithCredentials: vi.fn(async () => {}),
    }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('/mtls (restore required)', () => {
    it('routes to /restore when the server redirects with error=restore_required', async () => {
        replaceSpy.mockReset();
        useLocalSearchParamsMock.mockReturnValue({ error: 'restore_required' });

        const { default: MtlsCallbackScreen } = await import('@/app/(app)/mtls');
        await renderScreen(<MtlsCallbackScreen />);
        await act(async () => {
            await Promise.resolve();
        });

        expect(replaceSpy).toHaveBeenCalledWith('/restore');
    });
});

