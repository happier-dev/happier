import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { installRestoreRouteCommonModuleMocks, resetRestoreRouteTestState } from './restoreRouteTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

installRestoreRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: vi.fn(), push: pushSpy, replace: vi.fn() },
            params: {
                provider: 'github',
                reason: 'provider_already_linked',
            },
        });
        return routerMock.module;
    },
});

const authState = vi.hoisted(() => ({ isAuthenticated: false }));

vi.mock('@/components/onboarding/unauthShell', async () => {
    const React = await import('react');
    return {
        UnauthenticatedSplitShell: (props: {
            children?: React.ReactNode;
            stepId: string;
            isWelcomeStep: boolean;
            allowMobileBrandHero?: boolean;
            onOpenRelayCustomFlow: () => void;
            onBrandHeroGetStarted: () => void;
            onBack?: () => void;
        }) =>
            React.createElement(
                'UnauthenticatedSplitShell',
                {
                    stepId: props.stepId,
                    isWelcomeStep: props.isWelcomeStep,
                    allowMobileBrandHero: props.allowMobileBrandHero,
                    hasBack: typeof props.onBack === 'function',
                    testID: `unauth-shell-route-${props.stepId}`,
                },
                props.children,
            ),
    };
});

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        launchScanner: vi.fn(),
        dismissScanner: vi.fn(async () => {}),
        onModernBarcodeScanned: vi.fn(() => ({ remove: () => {} })),
    },
}));
const pushSpy = vi.fn();

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authState.isAuthenticated,
        login: vi.fn(async () => {}),
    }),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getRestoreRedirectNotice: () => ({
            title: 'GitHub verified',
            body: 'Restore your account key to finish signing in.',
        }),
    }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => false),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => null),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        void promise;
    },
}));

afterEach(() => {
    authState.isAuthenticated = false;
    vi.restoreAllMocks();
    resetRestoreRouteTestState();
});

describe('/restore', () => {
    it('renders the restore route inside the unauthenticated split shell without mobile hero', async () => {
        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<Screen />);
            tree = screen.tree;

            const shell = screen.findByTestId('unauth-shell-route-restore');
            expect(shell).toBeTruthy();
            expect(shell?.props.stepId).toBe('restore');
            expect(shell?.props.isWelcomeStep).toBe(false);
            expect(shell?.props.allowMobileBrandHero).toBe(false);
            expect(shell?.props.hasBack).toBe(true);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('renders restore content without unauthenticated chrome when already signed in', async () => {
        authState.isAuthenticated = true;
        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<Screen />);
            tree = screen.tree;

            expect(screen.findByTestId('unauth-shell-route-restore')).toBeNull();
            expect(screen.findByTestId('restore-route-content')).not.toBeNull();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('cancels QR restore polling after the QR view unmounts', async () => {
        vi.resetModules();
        const { authQRStart } = await import('@/auth/flows/qrStart');
        const { authQRWait } = await import('@/auth/flows/qrWait');
        vi.mocked(authQRStart).mockResolvedValue(true);

        let shouldCancel: (() => boolean) | undefined;
        vi.mocked(authQRWait).mockImplementation(async (_keypair, _onProgress, cancel) => {
            shouldCancel = cancel;
            return null;
        });

        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<Screen />);
            tree = screen.tree;

            await act(async () => {});

            expect(authQRWait).toHaveBeenCalled();
            expect(shouldCancel).toBeTypeOf('function');
            expect(shouldCancel?.()).toBe(false);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

        expect(shouldCancel?.()).toBe(true);
    });

    it('shows provider-specific restore notice when redirected after external auth', async () => {
        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<Screen />);
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const joined = screen.getTextContent();

            expect(joined).toContain('GitHub verified');
            expect(joined).toContain('Restore your account key to finish signing in.');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('renders the QR image on an opaque themed surface so finder rings stay scannable', async () => {
        vi.resetModules();
        const { authQRStart } = await import('@/auth/flows/qrStart');
        const { authQRWait } = await import('@/auth/flows/qrWait');
        vi.mocked(authQRStart).mockResolvedValue(true);
        vi.mocked(authQRWait).mockImplementation(async () => new Promise<null>(() => {}));
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<Screen />);
            tree = screen.tree;

            await act(async () => {});

            const qrCode = screen.findByType('QRCode' as never);
            expect(qrCode.props.backgroundColor).toBe(lightTheme.colors.surface.base);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
