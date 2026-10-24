import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import {
    installScanRouteCommonModuleMocks,
} from './scanRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
installScanRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: routerBackSpy },
        }).module;
    },
});

const processTerminalAuthUrlSpy = vi.fn(async (_url: string) => true);
const processAccountAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (_opts?: any) => ({ processAuthUrl: processTerminalAuthUrlSpy, isLoading: false }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: (_opts?: any) => ({ processAuthUrl: processAccountAuthUrlSpy, isLoading: false }),
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('/scan/terminal', () => {
    beforeEach(() => {
        routerBackSpy.mockClear();
        processTerminalAuthUrlSpy.mockClear();
        processAccountAuthUrlSpy.mockClear();
        lastScannerProps = null;
    });

    it('processes scanned terminal URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processTerminalAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        expect(processAccountAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('routes scanned account URLs to account auth even from the terminal scanner', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(processAccountAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAccountAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc123');
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });
});
