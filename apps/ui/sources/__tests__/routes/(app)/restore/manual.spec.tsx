import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const authLoginSpy = vi.hoisted(() => vi.fn(async () => {}));
const normalizeSecretKeySpy = vi.hoisted(() => vi.fn((input: string) => input.trim()));

vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: 'Ionicons',
}));

installRestoreRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: routerBackSpy, replace: routerReplaceSpy },
        });
        return routerMock.module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: authLoginSpy }),
}));

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: vi.fn(async () => 'token'),
}));

vi.mock('@/auth/recovery/secretKeyBackup', () => ({
    normalizeSecretKey: normalizeSecretKeySpy,
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: vi.fn((_value: string, _encoding: string) => new Uint8Array(32)),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

afterEach(() => {
    vi.restoreAllMocks();
    standardCleanup();
});

async function renderManualRestoreScreen() {
    vi.resetModules();
    const { default: Screen } = await import('@/app/(app)/restore/manual');
    return renderScreen(<Screen />);
}

describe('/restore/manual', () => {
    it('does not auto-capitalize secret key input (supports case-sensitive base64url input)', async () => {
        const screen = await renderManualRestoreScreen();
        const input = screen.findByTestId('restore-manual-secret-input');
        expect(input).not.toBeNull();
        expect(input?.props?.autoCapitalize).toBe('none');
    });

    it('masks the secret key input by default and allows toggling visibility', async () => {
        const screen = await renderManualRestoreScreen();

        const input = screen.findByTestId('restore-manual-secret-input');
        expect(input).not.toBeNull();
        expect(input?.props?.secureTextEntry).toBe(true);
        expect(input?.props?.multiline).toBe(false);

        await screen.pressByTestIdAsync('restore-manual-secret-reveal');

        const revealedInput = screen.findByTestId('restore-manual-secret-input');
        expect(revealedInput?.props?.secureTextEntry).toBe(false);
    });

    it('replaces navigation to home after a successful restore (does not return to link-new-device QR screen)', async () => {
        const screen = await renderManualRestoreScreen();

        const submit = screen.findByTestId('restore-manual-submit');
        expect(submit).not.toBeNull();

        await act(async () => {
            screen.changeTextByTestId('restore-manual-secret-input', 'secret-key');
        });

        await act(async () => {
            await submit?.props?.action?.();
        });

        expect(authLoginSpy).toHaveBeenCalled();
        expect(normalizeSecretKeySpy).toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });
});
