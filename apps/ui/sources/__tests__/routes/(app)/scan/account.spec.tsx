import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import {
    installScanRouteCommonModuleMocks,
} from './scanRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const processAccountAuthUrlSpy = vi.fn(async (_url: string) => true);
const processTerminalAuthUrlSpy = vi.fn(async (_url: string) => true);
const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: (_opts?: any) => ({ processAuthUrl: processAccountAuthUrlSpy, isLoading: false }),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (_opts?: any) => ({ processAuthUrl: processTerminalAuthUrlSpy, isLoading: false }),
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
        processAccountAuthUrlSpy.mockClear();
        processTerminalAuthUrlSpy.mockClear();
        lastScannerProps = null;
    });

    it('processes scanned account link URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(processAccountAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAccountAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc123');
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('routes scanned terminal URLs to terminal auth even from the account scanner', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processTerminalAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        expect(processAccountAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('supports manually entering an account link URL when the scanner is unavailable', async () => {
        promptSpy.mockResolvedValueOnce(' happier:///account?manual ');

        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);

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
        expect(processAccountAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAccountAuthUrlSpy).toHaveBeenCalledWith('happier:///account?manual');
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });
});
