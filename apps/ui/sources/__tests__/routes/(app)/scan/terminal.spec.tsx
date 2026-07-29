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
const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);
const alertAsyncSpy = vi.fn(async (..._args: unknown[]) => undefined);
let lastAccountConnectOptions: any = null;
let lastTerminalConnectOptions: any = null;
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

const processTerminalAuthUrlSpy = vi.fn(async (_url: string) => true);
const processAccountAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (opts?: any) => {
        lastTerminalConnectOptions = opts ?? null;
        return { processAuthUrl: processTerminalAuthUrlSpy, isLoading: false };
    },
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: (opts?: any) => {
        lastAccountConnectOptions = opts ?? null;
        return { processAuthUrl: processAccountAuthUrlSpy, isLoading: false };
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

describe('/scan/terminal', () => {
    beforeEach(() => {
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        promptSpy.mockClear();
        alertAsyncSpy.mockClear();
        processTerminalAuthUrlSpy.mockClear();
        processAccountAuthUrlSpy.mockClear();
        lastScannerProps = null;
        lastAccountConnectOptions = null;
        lastTerminalConnectOptions = null;
    });

    it('renders the terminal scan wizard shell and terminal-specific scanner copy', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScreen(<Screen />);

        const wizard = screen.findByType('WizardModalShell' as never);
        expect(wizard.props.testID).toBe('scan-terminal-wizard');
        expect(wizard.props.stepIndex).toBe(1);
        expect(wizard.props.stepCount).toBe(1);
        expect(wizard.props.showSkip).toBe(false);

        expect(lastScannerProps?.embedded).toBe(true);
        expect(lastScannerProps?.title).toBe('modals.authenticateTerminal');
        expect(lastScannerProps?.subtitle).toBe('connect.scanQrCodeOnDevice');
        expect(lastScannerProps?.permissionRequiredMessage).toBe('modals.cameraPermissionsRequiredToConnectTerminal');
    });

    it('processes scanned terminal URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processTerminalAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        expect(processAccountAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('rejects scanned account URLs from the terminal scanner', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
        expect(alertAsyncSpy).toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', [{ text: 'common.ok' }]);
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
        expect(processAccountAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('uses the terminal-specific manual-entry prompt copy', async () => {
        promptSpy.mockResolvedValueOnce(' happier://terminal?key=manual&server=https%3A%2F%2Fapi.happier.dev ');

        const { default: Screen } = await import('@/app/(app)/scan/terminal');

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
                return button.props.testID === 'scan-terminal-enter-url';
            },
        );
        expect(roundButton).toBeTruthy();
        if (!roundButton) throw new Error('Expected RoundButton in footer');

        await act(async () => {
            await roundButton.props.action?.();
        });

        expect(promptSpy).toHaveBeenCalledWith(
            'modals.authenticateTerminal',
            'modals.pasteUrlFromTerminal',
            {
                placeholder: 'connect.terminalUrlPlaceholder',
                confirmText: 'common.authenticate',
                cancelText: 'common.cancel',
            },
        );
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=manual&server=https%3A%2F%2Fapi.happier.dev');
    });

    it('uses safe fallback navigation after a successful terminal approval when there is no back stack', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScreen(<Screen />);

        expect(typeof lastTerminalConnectOptions?.onSuccess).toBe('function');

        await act(async () => {
            await lastTerminalConnectOptions.onSuccess();
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(lastAccountConnectOptions?.onSuccess).toBe(lastTerminalConnectOptions?.onSuccess);
    });
});
