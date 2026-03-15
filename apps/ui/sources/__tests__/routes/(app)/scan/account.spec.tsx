import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);
vi.mock('@/modal', () => ({
    Modal: {
        prompt: (...args: unknown[]) => promptSpy(...args),
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

const routerBackSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackSpy }),
}));

const processAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: (_opts?: any) => ({ processAuthUrl: processAuthUrlSpy, isLoading: false }),
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('/scan/account', () => {
    it('processes scanned account link URLs', async () => {
        routerBackSpy.mockClear();
        processAuthUrlSpy.mockClear();
        promptSpy.mockClear();
        lastScannerProps = null;

        const { default: Screen } = await import('@/app/(app)/scan/account');

        await act(async () => {
            renderer.create(<Screen />);
        });

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc123');
    });

    it('supports manually entering an account link URL when the scanner is unavailable', async () => {
        routerBackSpy.mockClear();
        processAuthUrlSpy.mockClear();
        promptSpy.mockClear();
        lastScannerProps = null;

        promptSpy.mockResolvedValueOnce(' happier:///account?manual ');

        const { default: Screen } = await import('@/app/(app)/scan/account');

        await act(async () => {
            renderer.create(<Screen />);
        });

        const footerElement = lastScannerProps?.footer;
        expect(footerElement).toBeTruthy();

        let footerTree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            footerTree = renderer.create(footerElement);
        });
        if (!footerTree) throw new Error('Expected footer renderer');

        const button = footerTree.root.findByType('RoundButton');

        await act(async () => {
            await button.props.action();
        });

        act(() => {
            footerTree?.unmount();
        });

        expect(promptSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier:///account?manual');
    });
});
