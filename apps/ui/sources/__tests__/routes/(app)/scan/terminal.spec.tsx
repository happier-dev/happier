import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
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

const processAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (_opts?: any) => ({ processAuthUrl: processAuthUrlSpy, isLoading: false }),
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
        processAuthUrlSpy.mockClear();
        lastScannerProps = null;
    });

    it('processes scanned terminal URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
    });
});
