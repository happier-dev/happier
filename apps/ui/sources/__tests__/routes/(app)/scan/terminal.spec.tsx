import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: {
                        OS: 'ios',
                        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
                    },
                    AppState: {
                        addEventListener: () => ({ remove: () => {} }),
                    },
                }
    );
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const routerBackSpy = vi.fn();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: routerBackSpy },
    });
    return routerMock.module;
});

const processAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (_opts?: any) => ({ processAuthUrl: processAuthUrlSpy, isLoading: false }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(async () => null),
        },
    }).module;
});

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('/scan/terminal', () => {
    it('processes scanned terminal URLs', async () => {
        routerBackSpy.mockClear();
        processAuthUrlSpy.mockClear();
        lastScannerProps = null;

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
