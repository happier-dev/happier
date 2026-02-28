import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'ios', select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const routerBackSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackSpy }),
}));

const processAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (_opts?: any) => ({ processAuthUrl: processAuthUrlSpy, isLoading: false }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(async () => null),
    },
}));

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

        await act(async () => {
            renderer.create(<Screen />);
        });

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
    });
});
