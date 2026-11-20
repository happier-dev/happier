import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';

import { RestoreIndexEmbedded } from './RestoreIndexEmbedded';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => true,
    canUseCurrentDeviceQrScanner: () => true,
}));

// The recovery key is its own owner (a credential journey with custody boundaries beneath);
// this spec is about which view the step shows, so it renders as a marker.
vi.mock('@/components/account/restore/SecretKeyLoginForm', () => ({
    SecretKeyLoginForm: () => React.createElement('secret-key-form'),
}));

let lastScanProps: any = null;
vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: (props: any) => {
        lastScanProps = props;
        return React.createElement('scan');
    },
}));

let lastQrProps: any = null;
vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: (props: any) => {
        lastQrProps = props;
        return React.createElement('qr');
    },
}));

describe('RestoreIndexEmbedded', () => {
    it('returns from the active terminal-link way through the shell Back button', async () => {
        const leaveRestore = vi.fn();
        try {
            const screen = await renderScreen(<AuthRouteStepFrame testID="restore" title="Restore" onBack={leaveRestore}>
                <RestoreIndexEmbedded entryIntent="enter_home" initialView="qr" reverseTargetProfileId="home-b" onBack={leaveRestore} />
            </AuthRouteStepFrame>);
            await act(async () => lastQrProps.onOpenTerminalLink());
            expect(screen.findByTestId('restore-pairing-link-input')).toBeTruthy();
            await screen.pressByTestIdAsync('unauth-shell-back-chevron');
            expect(screen.findByTestId('restore-pairing-link-input')).toBeNull();
            expect(screen.tree.root.findByType('qr')).toBeTruthy();
            expect(leaveRestore).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('unauth-shell-back-chevron');
            expect(leaveRestore).toHaveBeenCalledOnce();
        } finally { await standardCleanup(); }
    });

    it('uses a routine step when restore is entered with an authenticated Account', async () => {
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={{ token: 'signed-in' }}>
                <AuthRouteStepFrame testID="restore" title="Restore" onBack={() => {}}>
                    <RestoreIndexEmbedded entryIntent="add_home" initialView="qr" reverseTargetProfileId="home-b" onBack={() => {}} />
                </AuthRouteStepFrame>
            </InjectedAuthProvider>);
            await act(async () => lastQrProps.onOpenPairingLinkEntry());
            expect(screen.findByTestId('restore-pairing-link-input')).toBeTruthy();
            expect(screen.tree.root.findAllByType(StepMotionLayer)).toHaveLength(0);
        } finally { await standardCleanup(); }
    });

    it('switches from scanner-first to the QR view via an embedded callback (no route push)', async () => {
        lastScanProps = null;
        lastQrProps = null;

        const onBack = vi.fn();
        const onOpenSecretKeyLogin = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded entryIntent="enter_home" reverseTargetProfileId="home-b" onBack={onBack} onOpenSecretKeyLogin={onOpenSecretKeyLogin} />,
                );
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect(lastScanProps?.embedded).toBe(true);
            expect(lastScanProps?.entryIntent).toBe('enter_home');
            expect(lastScanProps?.onShowQrInstead).toBeInstanceOf(Function);

            await act(async () => {
                lastScanProps.onShowQrInstead();
            });

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect(lastQrProps?.embedded).toBe(true);
            expect(lastQrProps?.entryIntent).toBe('enter_home');
            expect(lastQrProps?.onOpenSecretKeyLogin).toBe(onOpenSecretKeyLogin);
            expect(lastQrProps?.onOpenPairingLinkEntry).toBeInstanceOf(Function);

            await act(async () => {
                lastQrProps.onOpenPairingLinkEntry();
            });

            expect(tree.root.findByProps({ testID: 'restore-pairing-link-input' })).toBeTruthy();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('forces the restore scanner and forwards an initial V2 pairing link unchanged', async () => {
        lastScanProps = null;
        const initialPairingLink = 'happier:///pair?v=2&payload=opaque';
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded entryIntent="enter_home" onBack={vi.fn()} initialPairingLink={initialPairingLink} />,
                );
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect(lastScanProps?.initialPairingLink).toBe(initialPairingLink);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('hands a terminal URL from Approve to the same embedded link processor', async () => {
        lastScanProps = null;
        const terminalLink = 'happier://terminal?example';
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded entryIntent="enter_home" initialView="qr" reverseTargetProfileId="home-b" onBack={vi.fn()} />,
                );
            });

            await act(async () => lastQrProps.onOpenTerminalLink());
            const input = tree.root.findAllByProps({ testID: 'restore-pairing-link-input' })
                .find((node) => typeof node.props.onChangeText === 'function');
            expect(input).toBeDefined();
            await act(async () => input?.props.onChangeText(terminalLink));

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect(lastScanProps?.initialPairingLink).toBe(terminalLink);
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('hands a pasted link to the embedded scanner instead of routing away', async () => {
        lastScanProps = null;
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreIndexEmbedded entryIntent="enter_home" onBack={vi.fn()} />);
            });
            await act(async () => {
                lastScanProps.onOpenPairingLinkEntry();
            });

            // A pasted link proceeds on its own.
            const input = tree.root.findByProps({ testID: 'restore-pairing-link-input' });
            await act(async () => {
                input.props.onChangeText('happier:///pair?v=2&payload=opaque');
            });

            // The scanner is the one owner that classifies and enrolls scanned
            // and pasted links; the paste form only hands the link over.
            expect(tree.root.findByType('scan')).toBeTruthy();
            expect(lastScanProps.initialPairingLink).toBe('happier:///pair?v=2&payload=opaque');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
