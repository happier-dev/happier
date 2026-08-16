import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;


const routerReplaceSpy = vi.fn();
const processAuthUrlSpy = vi.fn();
const promptAccountConnectApprovalRequiredSpy = vi.fn();
let localSearchParams: Record<string, unknown> = {};
let isAuthenticated = false;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace: routerReplaceSpy },
        params: () => localSearchParams as Record<string, string | string[] | undefined>,
    });
    return expoRouterMock.module;
});

vi.mock('@/auth/context/AuthContext', async () => {
    const actual = await vi.importActual<typeof import('@/auth/context/AuthContext')>('@/auth/context/AuthContext');
    return {
        ...actual,
        useAuth: () => ({ isAuthenticated }),
    };
});

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({ processAuthUrl: processAuthUrlSpy, isLoading: false }),
}));

vi.mock('@/components/account/restore/accountConnectApprovalGuidance', () => ({
    promptAccountConnectApprovalRequired: promptAccountConnectApprovalRequiredSpy,
}));

afterEach(() => {
    localSearchParams = {};
    isAuthenticated = false;
    routerReplaceSpy.mockReset();
    processAuthUrlSpy.mockReset();
    promptAccountConnectApprovalRequiredSpy.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('Legacy /account route', () => {
    it('redirects to the canonical account settings route', async () => {
        const Screen = (await import('@/app/(app)/account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;

            expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/account');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('preserves server override query when redirecting', async () => {
        localSearchParams = { server: 'http://localhost:3014' };
        const Screen = (await import('@/app/(app)/account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;

            expect(routerReplaceSpy).toHaveBeenCalledWith({
                pathname: '/settings/account',
                params: { server: 'http://localhost:3014' },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('approves an account-connect request with the existing authenticated flow before opening settings', async () => {
        isAuthenticated = true;
        localSearchParams = { accountConnectKey: 'abc+123/=', server: 'https://ignored.example' };
        processAuthUrlSpy.mockResolvedValueOnce(true);
        const Screen = (await import('@/app/(app)/account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;

            expect(processAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc+123/=');
            expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/account');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('ignores array-valued account-connect keys instead of choosing an ambiguous request', async () => {
        localSearchParams = { accountConnectKey: ['first', 'second'] };
        const Screen = (await import('@/app/(app)/account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;

            expect(processAuthUrlSpy).not.toHaveBeenCalled();
            expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/account');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('explains an account-connect request to signed-out users and opens account restore when selected', async () => {
        localSearchParams = { accountConnectKey: 'abc123' };
        promptAccountConnectApprovalRequiredSpy.mockResolvedValueOnce('showQr');
        const Screen = (await import('@/app/(app)/account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            tree = (await renderScreen(<Screen />)).tree;

            expect(processAuthUrlSpy).not.toHaveBeenCalled();
            expect(promptAccountConnectApprovalRequiredSpy).toHaveBeenCalledOnce();
            expect(routerReplaceSpy).toHaveBeenCalledWith('/restore/show-qr');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
