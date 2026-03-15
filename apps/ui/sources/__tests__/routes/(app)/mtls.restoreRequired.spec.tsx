import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceSpy = vi.fn();
const useLocalSearchParamsMock = vi.fn(() => ({ error: 'restore_required' }));

vi.mock('expo-router', () => ({
    router: { replace: replaceSpy },
    useLocalSearchParams: () => useLocalSearchParamsMock(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        loginWithCredentials: vi.fn(async () => {}),
    }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => {}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('/mtls (restore required)', () => {
    it('routes to /restore when the server redirects with error=restore_required', async () => {
        replaceSpy.mockReset();
        useLocalSearchParamsMock.mockReturnValue({ error: 'restore_required' });

        const { default: MtlsCallbackScreen } = await import('@/app/(app)/mtls');
        await act(async () => {
            renderer.create(<MtlsCallbackScreen />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(replaceSpy).toHaveBeenCalledWith('/restore');
    });
});

