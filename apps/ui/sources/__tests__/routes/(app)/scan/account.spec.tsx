import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installScanRouteCommonModuleMocks,
} from './scanRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const processAccountAuthUrlSpy = vi.fn(async (_url: string) => true);
const processTerminalAuthUrlSpy = vi.fn(async (_url: string) => true);
const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);
const alertAsyncSpy = vi.fn(async (..._args: unknown[]) => undefined);
let lastAccountConnectOptions: any = null;
let lastTerminalConnectOptions: any = null;

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: (opts?: any) => {
        lastAccountConnectOptions = opts ?? null;
        return { processAuthUrl: processAccountAuthUrlSpy, isLoading: false };
    },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (opts?: any) => {
        lastTerminalConnectOptions = opts ?? null;
        return { processAuthUrl: processTerminalAuthUrlSpy, isLoading: false };
    },
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

vi.mock('@/components/onboarding/ui/WizardModalShell', () => ({
    WizardModalShell: (props: any) => React.createElement('WizardModalShell', props, props.children),
}));

installScanRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: routerBackSpy,
                replace: routerReplaceSpy,
                canGoBack: () => false,
            },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: (...args: unknown[]) => promptSpy(...args),
                alertAsync: (...args: unknown[]) => alertAsyncSpy(...args),
            },
        }).module;
    },
});

describe('/scan/account', () => {
    beforeEach(() => {
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        promptSpy.mockClear();
        alertAsyncSpy.mockClear();
        processAccountAuthUrlSpy.mockClear();
        processTerminalAuthUrlSpy.mockClear();
        lastScannerProps = null;
        lastAccountConnectOptions = null;
        lastTerminalConnectOptions = null;
    });

    it('renders the account scan wizard shell and account-specific scanner copy', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        const screen = await renderScreen(<Screen />);

        const wizard = screen.findByType('WizardModalShell' as never);
        expect(wizard.props.testID).toBe('scan-account-wizard');
        expect(wizard.props.stepIndex).toBe(1);
        expect(wizard.props.stepCount).toBe(1);
        expect(wizard.props.showSkip).toBe(false);

        expect(lastScannerProps?.embedded).toBe(true);
        expect(lastScannerProps?.title).toBe('connect.linkNewDeviceTitle');
        expect(lastScannerProps?.subtitle).toBe('connect.linkNewDeviceSubtitle');
        expect(lastScannerProps?.permissionRequiredMessage).toBe('modals.cameraPermissionsRequiredToScanQr');
    });

    it('processes scanned account link URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(processAccountAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAccountAuthUrlSpy).toHaveBeenCalledWith('happier:///account?abc123');
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('rejects scanned terminal URLs from the account scanner', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
        expect(alertAsyncSpy).toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', [{ text: 'common.ok' }]);
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
        expect(processAccountAuthUrlSpy).not.toHaveBeenCalled();
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
        expect(promptSpy).toHaveBeenCalledWith(
            'connect.enterUrlManually',
            undefined,
            {
                placeholder: 'connect.accountUrlPlaceholder',
                confirmText: 'common.continue',
                cancelText: 'common.cancel',
            },
        );
        expect(processAccountAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processAccountAuthUrlSpy).toHaveBeenCalledWith('happier:///account?manual');
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('uses safe fallback navigation when cancelling without history', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        await act(async () => {
            await lastScannerProps.onCancel();
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('uses safe fallback navigation after a successful account link when there is no back stack', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/account');

        await renderScreen(<Screen />);

        expect(typeof lastAccountConnectOptions?.onSuccess).toBe('function');

        await act(async () => {
            await lastAccountConnectOptions.onSuccess();
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(lastTerminalConnectOptions?.onSuccess).toBe(lastAccountConnectOptions?.onSuccess);
    });
});
