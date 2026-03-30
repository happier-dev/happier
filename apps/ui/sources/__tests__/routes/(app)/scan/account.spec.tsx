import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installScanRouteCommonModuleMocks,
} from './scanRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const processAuthUrlSpy = vi.fn(async (_url: string) => true);
const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);

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

installScanRouteCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: (...args: unknown[]) => promptSpy(...args),
            },
        }).module;
    },
});

describe('/scan/account', () => {
    beforeEach(() => {
        promptSpy.mockClear();
        processAuthUrlSpy.mockClear();
        lastScannerProps = null;
    });

    it('processes scanned account link URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc123');
    });

    it('supports manually entering an account link URL when the scanner is unavailable', async () => {
        promptSpy.mockResolvedValueOnce(' happier:///account?manual ');

        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        const footerElement = lastScannerProps?.footer;
        expect(footerElement).toBeTruthy();
        const footerView = footerElement as React.ReactElement<{ children?: React.ReactNode }>;
        const footerChildren = React.Children.toArray(footerView.props.children);
        const roundButton = footerChildren.find(
            (
                child,
            ): child is React.ReactElement<{ action?: () => Promise<void>; testID?: string }> => {
                if (!React.isValidElement(child)) {
                    return false;
                }
                const button = child as React.ReactElement<{ action?: () => Promise<void>; testID?: string }>;
                return button.props.testID === 'scan-account-enter-url';
            },
        );
        expect(roundButton).toBeTruthy();
        if (!roundButton) throw new Error('Expected RoundButton in footer');

        await act(async () => {
            await roundButton.props.action?.();
        });

        expect(promptSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAuthUrlSpy).toHaveBeenCalledWith('happier:///account?manual');
    });
});
