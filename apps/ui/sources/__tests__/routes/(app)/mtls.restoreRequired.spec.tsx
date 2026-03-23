import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceSpy = vi.hoisted(() => vi.fn());
const useLocalSearchParamsMock = vi.hoisted(() => vi.fn(() => ({ error: 'restore_required' })));

const expoRouterMock = createExpoRouterMock({
    router: { replace: replaceSpy },
    params: () => useLocalSearchParamsMock(),
});

vi.mock('expo-router', async () => {
    return expoRouterMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        loginWithCredentials: vi.fn(async () => {}),
    }),
}));

vi.mock('@/modal', () => createModalModuleMock().module);

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));

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
