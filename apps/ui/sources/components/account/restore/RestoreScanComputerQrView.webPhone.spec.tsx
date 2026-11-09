import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllHostTestInstances, renderScreen } from '@/dev/testkit';
import type { AuthQrStartResult, QRAuthKeyPair } from '@/auth/flows/qrStart';
import type { AuthQrWaitOptions, AuthQrWaitResult } from '@/auth/flows/qrWait';
import type {
    PairingConsumeResult,
    PairingRequestResult,
    PairingStartResult,
    PairingStatusResult,
} from '@/sync/api/account/apiPairingAuth';
import type { HomeQrEnrollmentTarget } from '@/auth/flows/qrStart';
import type { AuthCredentials, ServerCredentialLookupOptions } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import {
    deriveHomeQrRendezvousSecretV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
    type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol/auth/accountDirectory';
import {
    installRestoreScanComputerQrViewCommonModuleMocks,
    resetRestoreScanComputerQrViewCommonModuleMockState,
} from './restoreScanComputerQrViewTestHelpers';

type PairingRequestParams = {
    pairId: string;
    secret: string;
    publicKey: string;
    deviceLabel?: string;
    homeServerIdentityId: string;
    expiresAtMs: number;
    bindingProof: string;
};

type EnrollmentRequestOptions = Readonly<{ signal?: AbortSignal }>;
type AdoptHomeProfileInput = Parameters<
    (typeof import('@/sync/domains/server/serverProfiles'))['adoptHomeProfile']
>[0];
type UpsertActivateAndSwitchServer =
    (typeof import('@/sync/domains/server/activeServerSwitch'))['upsertActivateAndSwitchServer'];
type SetActiveServerAndSwitch =
    (typeof import('@/sync/domains/server/activeServerSwitch'))['setActiveServerAndSwitch'];
type PairingStart = (typeof import('@/sync/api/account/apiPairingAuth'))['pairingStart'];
type PairingStatus = (typeof import('@/sync/api/account/apiPairingAuth'))['pairingStatus'];
type PairingConsumeParams = { pairId: string; intent?: 'reject' | 'cancel' };
type CompleteTrustedHomeQrPairingRequest =
    (typeof import('@/auth/pairing/completeTrustedHomeQrPairingRequest'))['completeTrustedHomeQrPairingRequest'];

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const navigationState = vi.hoisted(() => ({
    isFocused: true,
}));
const featureDecisionState = vi.hoisted(() => ({
    focusedDecision: { state: 'enabled', blockedBy: null } as {
        state: 'enabled' | 'disabled' | 'unknown';
        blockedBy: string | null;
    },
    targetEnabled: true,
    targetProbeMode: 'ready' as 'ready' | 'identity_mismatch' | 'identity_conflict' | 'invalid_payload' | 'network_error' | 'bad_request',
    targetProbeTransientFailuresRemaining: 0,
    targetProbeSpy: vi.fn(),
    publishedDescriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
    } as HomeConnectionDescriptorV1 | undefined,
}));
const transportResolutionState = vi.hoisted(() => ({
    transientFailuresRemaining: 0,
    browserIroh: false,
    homeCarrier: {
        endpointId: 'iroh-home-b',
        request: vi.fn(),
        close: vi.fn(async () => {}),
    },
    calls: [] as Array<{ homeServerIdentityId: string; canonicalServerUrl: string }>,
}));
const modalAlertSpy = vi.hoisted(() => vi.fn(async (
    _title?: string,
    _message?: string,
    _buttons?: Array<{ text?: string; onPress?: () => void }>,
) => {}));
const routerNavigationState = vi.hoisted(() => ({
    replaceSpy: vi.fn<(path: unknown) => void>(),
}));
const focusMutationState = vi.hoisted(() => ({
    upsertActivateAndSwitchServerSpy: vi.fn<UpsertActivateAndSwitchServer>(async () => 'switched'),
    setActiveServerAndSwitchSpy: vi.fn<SetActiveServerAndSwitch>(async () => 'switched'),
    preventRemoveSpy: vi.fn(),
}));

const restoreScanSuccessState = vi.hoisted(() => ({
    trackAccountRestoredSpy: vi.fn(),
    trackAuthEnrollmentTransientRetrySpy: vi.fn(),
    setCredentialsForServerUrlSpy: vi.fn<(
        serverUrl: string,
        options: ServerCredentialLookupOptions,
        credentials: AuthCredentials,
    ) => Promise<boolean>>(async () => true),
    rollbackCredentialWriteSpy: vi.fn<() => Promise<boolean>>(async () => true),
    getCredentialsForServerUrlSpy: vi.fn(async (_serverUrl: string) => null as AuthCredentials | null),
    removeCredentialsForServerUrlSpy: vi.fn(async (_serverUrl: string) => true),
    storedHomeCanonicalServerUrl: 'https://home-b.test',
    adoptHomeProfileSpy: vi.fn<(input: AdoptHomeProfileInput) => Promise<unknown>>(async () => ({
        id: 'profile-home-b',
        serverUrl: 'https://home-b.test',
        serverIdentityId: 'srv_home_b',
    })),
    pairingRequestSpy: vi.fn<(params: PairingRequestParams, target?: HomeQrEnrollmentTarget, options?: EnrollmentRequestOptions) => Promise<PairingRequestResult>>(async (_params) => ({
        ok: false,
        reason: 'not_found',
        status: 404,
    })),
    pairingStartSpy: vi.fn<PairingStart>(),
    pairingStatusSpy: vi.fn<PairingStatus>(),
    pairingConsumeSpy: vi.fn<(params: PairingConsumeParams, target?: HomeQrEnrollmentTarget) => Promise<PairingConsumeResult>>(async () => ({ ok: true })),
    completeTrustedPairingSpy: vi.fn<CompleteTrustedHomeQrPairingRequest>(async () => 'completed'),
    authQRStartSpy: vi.fn<(keypair: QRAuthKeyPair, target: unknown, options?: EnrollmentRequestOptions) => Promise<AuthQrStartResult>>(async () => ({ ok: true })),
    authQRWaitSpy: vi.fn<(keypair: QRAuthKeyPair, target: unknown, options?: AuthQrWaitOptions) => Promise<AuthQrWaitResult>>(async () => ({
        ok: false,
        reason: 'cancelled',
    })),
    getActiveServerUrlSpy: vi.fn(() => 'https://stack.example.test'),
}));

installRestoreScanComputerQrViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { replace: routerNavigationState.replaceSpy },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alertAsync: modalAlertSpy } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
        });
    },
    reactNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return {
            ...createReactNavigationNativeMock({
                usePreventRemove: (locked) => focusMutationState.preventRemoveSpy(locked),
            }),
            useIsFocused: () => navigationState.isFocused,
        };
    },
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => featureDecisionState.focusedDecision,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    probeServerFeaturesAtUrl: async (input: unknown) => {
        featureDecisionState.targetProbeSpy(input);
        if (featureDecisionState.targetProbeTransientFailuresRemaining > 0) {
            featureDecisionState.targetProbeTransientFailuresRemaining -= 1;
            return { status: 'error', reason: 'network' };
        }
        if (featureDecisionState.targetProbeMode === 'network_error') {
            return { status: 'error', reason: 'network' };
        }
        if (featureDecisionState.targetProbeMode === 'bad_request') {
            return { status: 'error', reason: 'response_status', httpStatus: 400 };
        }
        if (featureDecisionState.targetProbeMode === 'identity_conflict') {
            return { status: 'error', reason: 'identity_conflict' };
        }
        if (featureDecisionState.targetProbeMode === 'identity_mismatch') {
            return {
                status: 'ready',
                serverIdentityId: 'srv_wrong_home',
                features: {
                    features: {
                        auth: {
                            pairing: {
                                desktopQrMobileScan: { enabled: true },
                                boundQrV2: { enabled: true },
                            },
                        },
                    },
                },
            };
        }
        if (featureDecisionState.targetProbeMode === 'invalid_payload') {
            return { status: 'unsupported', reason: 'invalid_payload' };
        }
        return {
            status: 'ready',
            serverIdentityId: 'srv_home_b',
            features: {
                features: {
                    auth: {
                        pairing: {
                            desktopQrMobileScan: { enabled: featureDecisionState.targetEnabled },
                            boundQrV2: { enabled: featureDecisionState.targetEnabled },
                        },
                    },
                },
                homeConnectionDescriptor: featureDecisionState.publishedDescriptor,
            },
        };
    },
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

const authRefreshSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: authRefreshSpy }),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    loadHomeViewState: () => null,
    getActiveServerSnapshot: () => ({
        serverId: 'profile-home-b',
        serverUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
        generation: 1,
        isSelectionExplicit: true,
    }),
    subscribeActiveServer: () => () => {},
    getActiveServerUrl: () => restoreScanSuccessState.getActiveServerUrlSpy(),
    preflightHomeProfileAdoption: (input: {
        descriptor: { canonicalServerUrl: string; homeServerIdentityId: string };
    }) => ({
        canonicalServerUrl: input.descriptor.canonicalServerUrl,
        serverIdentityId: input.descriptor.homeServerIdentityId,
    }),
    adoptHomeProfile: (input: AdoptHomeProfileInput) => restoreScanSuccessState.adoptHomeProfileSpy(input),
    adoptHomeProfileUnderMutationAuthority: (input: AdoptHomeProfileInput) => restoreScanSuccessState.adoptHomeProfileSpy(input),
    getServerProfileById: (identity: string) => identity === 'srv_home_b'
        ? {
            id: 'profile-home-b',
            name: 'Home B',
            serverUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
            canonicalServerUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
            serverIdentityId: identity,
        }
        : null,
    listServerProfiles: () => [{
        id: 'profile-home-b',
        name: 'Home B',
        serverUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
        canonicalServerUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
        serverIdentityId: 'srv_home_b',
    }],
    resolveServerProfileForPortableIdentity: (identity: string) => identity === 'srv_home_b'
        ? {
            kind: 'resolved',
            serverIdentityId: identity,
            profile: {
                id: 'profile-home-b',
                serverUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
                canonicalServerUrl: restoreScanSuccessState.storedHomeCanonicalServerUrl,
                serverIdentityId: identity,
            },
        }
        : { kind: 'missing', serverIdentityId: identity },
    buildHomeConnectionDescriptorForProfile: (profile: { serverIdentityId: string }) => ({
        v: 1,
        homeServerIdentityId: profile.serverIdentityId,
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
    }),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    subscribeHomeCredentialMutations: () => () => {},
    getHomeCredentialsUnderMutationAuthority: (
        _authority: unknown,
        serverUrl: string,
    ) => restoreScanSuccessState.getCredentialsForServerUrlSpy(serverUrl),
    setHomeCredentialsWithRollbackUnderMutationAuthority: async (
        _authority: unknown,
        serverUrl: string,
        options: ServerCredentialLookupOptions,
        credentials: AuthCredentials,
    ) => {
        const written = await restoreScanSuccessState.setCredentialsForServerUrlSpy(
            serverUrl,
            options,
            credentials,
        );
        return written ? { rollback: restoreScanSuccessState.rollbackCredentialWriteSpy } : null;
    },
    removeHomeCredentialsUnderMutationAuthority: (
        _authority: unknown,
        serverUrl: string,
    ) => restoreScanSuccessState.removeCredentialsForServerUrlSpy(serverUrl),
    TokenStorage: {
        setCredentialsForServerUrl: (
            serverUrl: string,
            options: ServerCredentialLookupOptions,
            credentials: AuthCredentials,
        ) => restoreScanSuccessState.setCredentialsForServerUrlSpy(serverUrl, options, credentials),
        setCredentialsForServerUrlWithRollback: async (
            serverUrl: string,
            options: ServerCredentialLookupOptions,
            credentials: AuthCredentials,
        ) => {
            const written = await restoreScanSuccessState.setCredentialsForServerUrlSpy(
                serverUrl,
                options,
                credentials,
            );
            return written ? { rollback: restoreScanSuccessState.rollbackCredentialWriteSpy } : null;
        },
        getCredentialsForServerUrl: (serverUrl: string) => (
            restoreScanSuccessState.getCredentialsForServerUrlSpy(serverUrl)
        ),
        removeCredentialsForServerUrl: (serverUrl: string) => (
            restoreScanSuccessState.removeCredentialsForServerUrlSpy(serverUrl)
        ),
    },
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: focusMutationState.upsertActivateAndSwitchServerSpy,
    setActiveServerAndSwitch: focusMutationState.setActiveServerAndSwitchSpy,
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingConsume: (params: PairingConsumeParams, target?: HomeQrEnrollmentTarget) => restoreScanSuccessState.pairingConsumeSpy(params, target),
    pairingRequest: (params: PairingRequestParams, target?: HomeQrEnrollmentTarget, options?: EnrollmentRequestOptions) => restoreScanSuccessState.pairingRequestSpy(params, target, options),
    pairingStart: restoreScanSuccessState.pairingStartSpy,
    pairingStatus: restoreScanSuccessState.pairingStatusSpy,
}));

vi.mock('@/auth/pairing/completeTrustedHomeQrPairingRequest', () => ({
    completeTrustedHomeQrPairingRequest: restoreScanSuccessState.completeTrustedPairingSpy,
    InvalidTrustedHomeQrRequestError: class InvalidTrustedHomeQrRequestError extends Error {},
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }),
    authQRStart: (keypair: QRAuthKeyPair, target: unknown, options?: EnrollmentRequestOptions) => restoreScanSuccessState.authQRStartSpy(keypair, target, options),
}));

vi.mock('@/auth/enrollment/homeEnrollmentTransport', () => ({
    resolveHomeEnrollmentTransport: async (descriptor: {
        homeServerIdentityId: string;
        canonicalServerUrl: string;
    }) => {
        transportResolutionState.calls.push(descriptor);
        if (transportResolutionState.transientFailuresRemaining > 0) {
            transportResolutionState.transientFailuresRemaining -= 1;
            return {
                ok: false,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                reason: 'iroh_transport_unavailable',
            };
        }
        return {
            ok: true,
            transport: {
                endpointUrl: descriptor.canonicalServerUrl,
                runtimeOrigin: transportResolutionState.browserIroh
                    ? null
                    : descriptor.canonicalServerUrl,
                homeCarrier: transportResolutionState.browserIroh
                    ? transportResolutionState.homeCarrier
                    : null,
                descriptor,
                close: async () => {},
            },
        };
    },
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: (keypair: QRAuthKeyPair, target: unknown, options?: AuthQrWaitOptions) => restoreScanSuccessState.authQRWaitSpy(keypair, target, options),
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('div', { 'data-testid': 'QrCodeScannerView' }, props.footer ?? null);
    },
}));

vi.mock('@/track', () => ({
    trackAccountRestored: restoreScanSuccessState.trackAccountRestoredSpy,
    trackAuthEnrollmentTransientRetry: restoreScanSuccessState.trackAuthEnrollmentTransientRetrySpy,
}));

function createHomeBInvite() {
    return {
        v: 2 as const,
        intent: 'home_device' as const,
        direction: 'trusted_home_displays' as const,
        pairId: 'pair-b',
        home: {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://home-b.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
        },
        qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
        issuedAtMs: Date.now() - 1_000,
        expiresAtMs: Date.now() + 120_000,
    };
}

function createReverseInvite(pairId: string) {
    const requesterPublicKey = new Uint8Array(32).fill(8);
    return {
        requesterPublicKey,
        invite: {
            ...createHomeBInvite(),
            direction: 'requester_displays' as const,
            pairId,
            requesterPublicKeyBase64Url: encodeBase64(requesterPublicKey, 'base64url'),
            issuedAtMs: Date.now() - 1_000,
            expiresAtMs: Date.now() + 120_000,
        },
    };
}

// Install the shared boundaries before loading the owner, outside behavior deadlines.
const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

describe('RestoreScanComputerQrView (web phone)', () => {
    beforeEach(() => {
        resetRestoreScanComputerQrViewCommonModuleMockState();
        navigationState.isFocused = true;
        featureDecisionState.focusedDecision = { state: 'enabled', blockedBy: null };
        featureDecisionState.targetEnabled = true;
        featureDecisionState.targetProbeMode = 'ready';
        featureDecisionState.targetProbeTransientFailuresRemaining = 0;
        featureDecisionState.targetProbeSpy.mockClear();
        featureDecisionState.publishedDescriptor = createHomeBInvite().home;
        transportResolutionState.transientFailuresRemaining = 0;
        transportResolutionState.browserIroh = false;
        transportResolutionState.homeCarrier.request.mockReset();
        transportResolutionState.homeCarrier.close.mockClear();
        transportResolutionState.calls = [];
        lastScannerProps = null;
        modalAlertSpy.mockClear();
        routerNavigationState.replaceSpy.mockClear();
        focusMutationState.upsertActivateAndSwitchServerSpy.mockClear();
        focusMutationState.setActiveServerAndSwitchSpy.mockReset();
        focusMutationState.setActiveServerAndSwitchSpy.mockResolvedValue('switched');
        focusMutationState.preventRemoveSpy.mockClear();
        restoreScanSuccessState.trackAccountRestoredSpy.mockClear();
        restoreScanSuccessState.trackAuthEnrollmentTransientRetrySpy.mockClear();
        restoreScanSuccessState.setCredentialsForServerUrlSpy.mockClear();
        restoreScanSuccessState.rollbackCredentialWriteSpy.mockClear();
        restoreScanSuccessState.rollbackCredentialWriteSpy.mockResolvedValue(true);
        restoreScanSuccessState.getCredentialsForServerUrlSpy.mockReset();
        restoreScanSuccessState.getCredentialsForServerUrlSpy.mockResolvedValue(null);
        restoreScanSuccessState.removeCredentialsForServerUrlSpy.mockReset();
        restoreScanSuccessState.removeCredentialsForServerUrlSpy.mockResolvedValue(true);
        restoreScanSuccessState.storedHomeCanonicalServerUrl = 'https://home-b.test';
        restoreScanSuccessState.adoptHomeProfileSpy.mockClear();
        restoreScanSuccessState.adoptHomeProfileSpy.mockImplementation(async (params) => ({
            id: `profile-${params.descriptor.homeServerIdentityId}`,
            serverUrl: params.descriptor.canonicalServerUrl,
            serverIdentityId: params.descriptor.homeServerIdentityId,
        }));
        restoreScanSuccessState.pairingRequestSpy.mockClear();
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: false,
            reason: 'not_found',
            status: 404,
        });
        restoreScanSuccessState.authQRStartSpy.mockClear();
        restoreScanSuccessState.authQRStartSpy.mockResolvedValue({ ok: true });
        restoreScanSuccessState.authQRWaitSpy.mockClear();
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason: 'cancelled' });
        restoreScanSuccessState.pairingStartSpy.mockReset();
        restoreScanSuccessState.pairingStatusSpy.mockReset();
        restoreScanSuccessState.pairingConsumeSpy.mockClear();
        restoreScanSuccessState.completeTrustedPairingSpy.mockClear();
    });

    it('renders the QR scanner in idle state on web', async () => {
        const onOpenPairingLinkEntry = vi.fn();

        const screen = await renderScreen(
            <RestoreScanComputerQrView
                entryIntent="add_home"
                onOpenPairingLinkEntry={onOpenPairingLinkEntry}
            />,
        );

        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
        expect(screen.findByTestId('restore-open-manual')).toBeTruthy();
        expect(screen.findByTestId('restore-show-qr-instead')).toBeNull();
        expect(screen.findByTestId('restore-enter-pairing-link')).toBeTruthy();
        expect(screen.findByTestId('restore-pairing-link-details')).toBeNull();
        await screen.pressByTestIdAsync('restore-enter-pairing-link');
        expect(onOpenPairingLinkEntry).toHaveBeenCalledOnce();
        expect(lastScannerProps?.testIDPrefix).toBe('restore-scan');
        expect(lastScannerProps?.active).toBe(true);
    });

    it('does not let focused Home A disable scanning a feature-enabled Home B invite', async () => {
        featureDecisionState.focusedDecision = { state: 'disabled', blockedBy: 'server' };

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
    });

    it('fails closed against the parsed target Home when that Home disables QR enrollment', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        featureDecisionState.targetEnabled = false;

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(restoreScanSuccessState.authQRStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingRequestSpy).not.toHaveBeenCalled();
        expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-b.test',
            serverId: 'srv_home_b',
        }));
        expect(screen.getTextContent()).toContain('connect.updateRequiredBody');
        expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('probes a forward browser-Iroh Home through the exact resolved semantic carrier', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        transportResolutionState.browserIroh = true;

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-b.test',
            runtimeOrigin: null,
            homeCarrier: transportResolutionState.homeCarrier,
        }));
    });

    it('marks the QR scanner inactive when the restore route is covered by another screen', async () => {
        navigationState.isFocused = false;


        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        expect(lastScannerProps?.active).toBe(false);
    });

    it('routes an account-connect QR through the embedded restore owner instead of treating it as invalid', async () => {
        modalAlertSpy.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button: { text?: string }) => button.text === 'connect.showQrInstead')?.onPress?.();
        });
        const onShowQrInstead = vi.fn();

        await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" embedded onShowQrInstead={onShowQrInstead} />);
        await act(async () => {
            await lastScannerProps?.onScan('happier:///account?abc123');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'connect.restoreAccount',
            'connect.legacyAccountQrUnavailable',
            expect.any(Array),
        );
        expect(onShowQrInstead).toHaveBeenCalledOnce();
    });

    it('does not offer "Show QR instead" for an account-connect QR when this surface cannot show one', async () => {

        await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" embedded />);
        await act(async () => {
            await lastScannerProps?.onScan('happier:///account?abc123');
        });

        const buttons = modalAlertSpy.mock.calls.at(-1)?.[2] as Array<{ text?: string }> | undefined;
        expect(buttons?.map((button) => button.text)).toEqual(['common.ok']);
    });

    it('enrolls the exact V2 Home when advisory features omit a descriptor, without focused login or focus changes', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        featureDecisionState.publishedDescriptor = undefined;
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: 'srv_home_b',
        });


        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        // Start and wait are explicitly targeted at the scanned Home.
        expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledTimes(1);
        expect(restoreScanSuccessState.authQRStartSpy.mock.calls[0]?.[1]).toMatchObject({
            endpointUrl: 'https://home-b.test',
        });
        expect(restoreScanSuccessState.authQRWaitSpy.mock.calls[0]?.[1]).toMatchObject({
            endpointUrl: 'https://home-b.test',
            descriptor: expect.objectContaining({ homeServerIdentityId: 'srv_home_b' }),
        });
        const startSignal = restoreScanSuccessState.authQRStartSpy.mock.calls[0]?.[2]?.signal;
        expect(startSignal).toBeInstanceOf(AbortSignal);
        expect(restoreScanSuccessState.pairingRequestSpy.mock.calls[0]?.[2]?.signal).toBe(startSignal);
        expect(restoreScanSuccessState.authQRWaitSpy.mock.calls[0]?.[2]?.signal).toBe(startSignal);

        // Joining request derives the rendezvous secret from QR-only material.
        const pairingParams = restoreScanSuccessState.pairingRequestSpy.mock.calls[0]?.[0] as PairingRequestParams;
        expect(pairingParams.pairId).toBe('pair-b');
        expect(pairingParams.secret).toBe(encodeBase64(
            deriveHomeQrRendezvousSecretV2(new Uint8Array(32).fill(4)),
            'base64url',
        ));

        // Credentials are stored under the target Home; focus/adoption is non-mutating.
        expect(restoreScanSuccessState.adoptHomeProfileSpy).toHaveBeenCalledWith(expect.objectContaining({
            source: 'qr',
            preserveUserLabel: true,
            descriptor: expect.objectContaining({ homeServerIdentityId: 'srv_home_b' }),
        }));
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).toHaveBeenCalledWith(
            'https://home-b.test',
            { serverId: 'srv_home_b' },
            { token: 'tok_home_b' },
        );
        expect(restoreScanSuccessState.trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('ignores an advisory feature descriptor retarget and persists the exact V2 invite Home', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const invite = createHomeBInvite();
        featureDecisionState.publishedDescriptor = {
            ...invite.home,
            canonicalServerUrl: 'https://advisory-retarget.test',
            revision: invite.home.revision + 1,
            endpoints: [{ kind: 'https', url: 'https://advisory-retarget.test' }],
        };
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: invite.home.homeServerIdentityId,
        });

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite }));
        });

        expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                endpointUrl: invite.home.canonicalServerUrl,
                descriptor: invite.home,
            }),
            expect.anything(),
        );
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).toHaveBeenCalledWith(
            invite.home.canonicalServerUrl,
            { serverId: invite.home.homeServerIdentityId },
            { token: 'tok_home_b' },
        );
        expect(restoreScanSuccessState.adoptHomeProfileSpy).toHaveBeenCalledWith(expect.objectContaining({
            descriptor: invite.home,
            source: 'qr',
            preserveUserLabel: true,
        }));
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalledWith(
            'https://advisory-retarget.test',
            expect.anything(),
            expect.anything(),
        );
    });

    it('resolves and completes a known-target requester-displayed invite through the stored Home identity', async () => {
        transportResolutionState.browserIroh = true;
        const requesterPublicKey = new Uint8Array(32).fill(8);
        const issuedAtMs = Date.now() - 1_000;
        const expiresAtMs = Date.now() + 120_000;
        const reverseInvite = {
            ...createHomeBInvite(),
            direction: 'requester_displays' as const,
            pairId: 'pair-reverse-b',
            requesterPublicKeyBase64Url: encodeBase64(requesterPublicKey, 'base64url'),
            issuedAtMs,
            expiresAtMs,
        };
        const { computeHomeQrBindingProofV2} = await import('@happier-dev/protocol/crypto/qrProvisioningV2');
        const bindingProof = computeHomeQrBindingProofV2({
            direction: reverseInvite.direction,
            qrSecret: new Uint8Array(32).fill(4),
            pairId: reverseInvite.pairId,
            homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
            requesterPublicKey,
            expiresAtMs,
        });
        restoreScanSuccessState.pairingStartSpy.mockResolvedValue({
            ok: true,
            data: { pairId: reverseInvite.pairId, expiresAt: new Date(expiresAtMs).toISOString() },
        });
        restoreScanSuccessState.pairingStatusSpy.mockResolvedValue({
            ok: true,
            data: {
                state: 'requested',
                pairId: reverseInvite.pairId,
                expiresAt: new Date(expiresAtMs).toISOString(),
                requestedPublicKey: encodeBase64(requesterPublicKey),
                requestedDeviceLabel: null,
                bindingProof,
                homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
            },
        });
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const onInviteDirectionChange = vi.fn();
        const screen = await renderScreen(
            <RestoreScanComputerQrView entryIntent="add_home" onInviteDirectionChange={onInviteDirectionChange} />,
        );
        // Nothing is reported until an invite is actually active in place.
        expect(onInviteDirectionChange).not.toHaveBeenCalled();

        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
        });

        // The host chrome follows the in-place scanned direction, not only a routed link.
        expect(onInviteDirectionChange).toHaveBeenCalledWith('requester_displays');
        expect(onInviteDirectionChange).not.toHaveBeenCalledWith(null);
        expect(restoreScanSuccessState.pairingStartSpy).toHaveBeenCalledWith(
            {
                direction: 'requester_displays',
                secretHash: expect.any(String),
                pairId: reverseInvite.pairId,
                expiresAtMs,
            },
            expect.objectContaining({
                serverId: 'profile-home-b',
                endpointUrl: 'https://home-b.test',
                descriptor: expect.objectContaining({ homeServerIdentityId: 'srv_home_b' }),
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(restoreScanSuccessState.completeTrustedPairingSpy).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({
                direction: 'requester_displays',
                pairId: reverseInvite.pairId,
                expiresAtMs,
            }),
            requesterPublicKey,
        }));
        expect(restoreScanSuccessState.authQRStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.authQRWaitSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-b.test',
            runtimeOrigin: null,
            homeCarrier: transportResolutionState.homeCarrier,
        }));
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        expect(screen.getTextContent()).not.toContain('connect.confirmCodeComparisonBody');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(screen.getTextContent()).toContain('connect.requesterDeviceAddedBody');
        expect(screen.getTextContent()).toContain('homeDeviceApproval.deviceFallback');
        expect(screen.getTextContent()).not.toContain('connect.thisDevice');
        expect(modalAlertSpy).not.toHaveBeenCalledWith('home-b.test', 'connect.requesterDeviceAddedBody');
    });

    it('reports reverse-direction success once after a transient status failure', async () => {
        vi.useFakeTimers();
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const requesterPublicKey = new Uint8Array(32).fill(8);
            const issuedAtMs = Date.now() - 1_000;
            const expiresAtMs = Date.now() + 120_000;
            const reverseInvite = {
                ...createHomeBInvite(),
                direction: 'requester_displays' as const,
                pairId: 'pair-reverse-retry',
                requesterPublicKeyBase64Url: encodeBase64(requesterPublicKey, 'base64url'),
                issuedAtMs,
                expiresAtMs,
            };
            const { computeHomeQrBindingProofV2} = await import('@happier-dev/protocol/crypto/qrProvisioningV2');
            const bindingProof = computeHomeQrBindingProofV2({
                direction: reverseInvite.direction,
                qrSecret: new Uint8Array(32).fill(4),
                pairId: reverseInvite.pairId,
                homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
                requesterPublicKey,
                expiresAtMs,
            });
            restoreScanSuccessState.pairingStartSpy.mockResolvedValue({
                ok: true,
                data: { pairId: reverseInvite.pairId, expiresAt: new Date(expiresAtMs).toISOString() },
            });
            restoreScanSuccessState.pairingStatusSpy
                .mockResolvedValueOnce({ ok: false, reason: 'http_error', status: 503 })
                .mockResolvedValue({
                    ok: true,
                    data: {
                        state: 'requested',
                        pairId: reverseInvite.pairId,
                        expiresAt: new Date(expiresAtMs).toISOString(),
                        requestedPublicKey: encodeBase64(requesterPublicKey),
                        requestedDeviceLabel: null,
                        bindingProof,
                        homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
                    },
                });
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

            await act(async () => {
                void lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(restoreScanSuccessState.pairingStatusSpy).toHaveBeenCalledTimes(1));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
            });
            await vi.waitFor(() => expect(restoreScanSuccessState.completeTrustedPairingSpy).toHaveBeenCalled());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });

            // A recovered transient poll must not suppress the terminal success outcome
            // or re-drive the Home-authority completion boundary.
            expect(restoreScanSuccessState.completeTrustedPairingSpy).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
            expect(screen.getTextContent()).toContain('connect.requesterDeviceAddedBody');
            expect(modalAlertSpy).not.toHaveBeenCalledWith('home-b.test', 'connect.requesterDeviceAddedBody');
            expect(modalAlertSpy).not.toHaveBeenCalledWith(
                'modals.authRequestExpired',
                'modals.authRequestExpiredDescription',
            );
            await screen.unmount();
        } finally {
            randomSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('does not dispatch reverse completion UI after unmount', async () => {
        const requesterPublicKey = new Uint8Array(32).fill(8);
        const expiresAtMs = Date.now() + 120_000;
        const reverseInvite = {
            ...createHomeBInvite(),
            direction: 'requester_displays' as const,
            pairId: 'pair-reverse-unmount',
            requesterPublicKeyBase64Url: encodeBase64(requesterPublicKey, 'base64url'),
            expiresAtMs,
        };
        const { computeHomeQrBindingProofV2} = await import('@happier-dev/protocol/crypto/qrProvisioningV2');
        const bindingProof = computeHomeQrBindingProofV2({
            direction: reverseInvite.direction,
            qrSecret: new Uint8Array(32).fill(4),
            pairId: reverseInvite.pairId,
            homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
            requesterPublicKey,
            expiresAtMs,
        });
        restoreScanSuccessState.pairingStartSpy.mockResolvedValue({
            ok: true,
            data: { pairId: reverseInvite.pairId, expiresAt: new Date(expiresAtMs).toISOString() },
        });
        restoreScanSuccessState.pairingStatusSpy.mockResolvedValue({
            ok: true,
            data: {
                state: 'requested',
                pairId: reverseInvite.pairId,
                expiresAt: new Date(expiresAtMs).toISOString(),
                requestedPublicKey: encodeBase64(requesterPublicKey),
                requestedDeviceLabel: null,
                bindingProof,
                homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
            },
        });
        let resolveCompletion!: () => void;
        restoreScanSuccessState.completeTrustedPairingSpy.mockImplementation(() => new Promise<'completed'>((resolve) => {
            resolveCompletion = () => resolve('completed');
        }));
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.completeTrustedPairingSpy).toHaveBeenCalledOnce());
        await screen.unmount();
        await act(async () => {
            resolveCompletion();
            await scanPromise;
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('aborts the reverse start request and consumes the row it created when cancellation races it', async () => {
        const { invite: reverseInvite } = createReverseInvite('pair-reverse-cancel-race');
        let resolveStart!: (result: PairingStartResult) => void;
        restoreScanSuccessState.pairingStartSpy.mockImplementation(() => new Promise<PairingStartResult>((resolve) => {
            resolveStart = resolve;
        }));
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.pairingStartSpy).toHaveBeenCalledTimes(1));
        const startOptions = restoreScanSuccessState.pairingStartSpy.mock.calls[0]?.[2];

        await act(async () => {
            await screen.findByTestId('restore-enrollment-cancel')?.props.onPress();
        });
        expect(startOptions?.signal?.aborted).toBe(true);

        await act(async () => {
            resolveStart({
                ok: true,
                data: { pairId: reverseInvite.pairId, expiresAt: new Date(reverseInvite.expiresAtMs).toISOString() },
            });
            await scanPromise;
        });

        expect(restoreScanSuccessState.pairingConsumeSpy).toHaveBeenCalledWith(
            { pairId: reverseInvite.pairId, intent: 'cancel' },
            expect.objectContaining({ endpointUrl: 'https://home-b.test', serverId: 'profile-home-b' }),
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(routerNavigationState.replaceSpy).not.toHaveBeenCalled();
    });

    it('aborts reverse status polling and consumes the pending row when the user cancels', async () => {
        const { requesterPublicKey, invite: reverseInvite } = createReverseInvite('pair-reverse-cancel-known');
        const { computeHomeQrBindingProofV2} = await import('@happier-dev/protocol/crypto/qrProvisioningV2');
        const bindingProof = computeHomeQrBindingProofV2({
            direction: reverseInvite.direction,
            qrSecret: new Uint8Array(32).fill(4),
            pairId: reverseInvite.pairId,
            homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
            requesterPublicKey,
            expiresAtMs: reverseInvite.expiresAtMs,
        });
        restoreScanSuccessState.pairingStartSpy.mockResolvedValue({
            ok: true,
            data: { pairId: reverseInvite.pairId, expiresAt: new Date(reverseInvite.expiresAtMs).toISOString() },
        });
        let resolveStatus!: (result: PairingStatusResult) => void;
        restoreScanSuccessState.pairingStatusSpy.mockImplementation(() => new Promise<PairingStatusResult>((resolve) => {
            resolveStatus = resolve;
        }));
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.pairingStatusSpy).toHaveBeenCalledTimes(1));
        const statusOptions = restoreScanSuccessState.pairingStatusSpy.mock.calls[0]?.[2];

        await act(async () => {
            await screen.findByTestId('restore-enrollment-cancel')?.props.onPress();
        });
        expect(statusOptions?.signal?.aborted).toBe(true);
        expect(restoreScanSuccessState.pairingConsumeSpy).toHaveBeenCalledWith(
            { pairId: reverseInvite.pairId, intent: 'cancel' },
            expect.objectContaining({ endpointUrl: 'https://home-b.test', serverId: 'profile-home-b' }),
        );

        // A stale requested-status payload must not drive the Home-authority commit
        // boundary after the attempt was cancelled.
        await act(async () => {
            resolveStatus({
                ok: true,
                data: {
                    state: 'requested',
                    pairId: reverseInvite.pairId,
                    expiresAt: new Date(reverseInvite.expiresAtMs).toISOString(),
                    requestedPublicKey: encodeBase64(requesterPublicKey),
                    requestedDeviceLabel: null,
                    bindingProof,
                    homeServerIdentityId: reverseInvite.home.homeServerIdentityId,
                },
            });
            await scanPromise;
        });

        expect(restoreScanSuccessState.completeTrustedPairingSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(routerNavigationState.replaceSpy).not.toHaveBeenCalled();
    });

    it('consumes the known pending reverse row when the screen unmounts', async () => {
        const { invite: reverseInvite } = createReverseInvite('pair-reverse-unmount-pending');
        restoreScanSuccessState.pairingStartSpy.mockResolvedValue({
            ok: true,
            data: { pairId: reverseInvite.pairId, expiresAt: new Date(reverseInvite.expiresAtMs).toISOString() },
        });
        restoreScanSuccessState.pairingStatusSpy.mockImplementation(() => new Promise<PairingStatusResult>(() => {}));
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        await act(async () => {
            void lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: reverseInvite }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.pairingStatusSpy).toHaveBeenCalledTimes(1));

        await screen.unmount();

        expect(restoreScanSuccessState.pairingConsumeSpy).toHaveBeenCalledWith(
            { pairId: reverseInvite.pairId, intent: 'cancel' },
            expect.objectContaining({ endpointUrl: 'https://home-b.test', serverId: 'profile-home-b' }),
        );
    });

    it('retries transient initial auth and bound-request failures with the same key and proof until success', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            restoreScanSuccessState.authQRStartSpy
                .mockResolvedValueOnce({ ok: false, reason: 'transient', status: 503 })
                .mockResolvedValueOnce({ ok: true });
            restoreScanSuccessState.pairingRequestSpy
                .mockResolvedValueOnce({ ok: false, reason: 'http_error', status: 503 })
                .mockResolvedValueOnce({ ok: true, data: { state: 'requested' } });
            restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason: 'cancelled' });

            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

            let scanPromise!: Promise<void>;
            await act(async () => {
                scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledTimes(1));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
            });
            await vi.waitFor(() => expect(restoreScanSuccessState.pairingRequestSpy).toHaveBeenCalledTimes(1));
            const firstBoundRequest = restoreScanSuccessState.pairingRequestSpy.mock.calls[0]?.[0];
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
                await scanPromise;
            });

            expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledTimes(2);
            expect(restoreScanSuccessState.pairingRequestSpy).toHaveBeenCalledTimes(2);
            expect(restoreScanSuccessState.pairingRequestSpy.mock.calls[1]?.[0]).toEqual(firstBoundRequest);
            expect(restoreScanSuccessState.authQRWaitSpy).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries transient target transport and capability setup with the same parsed invite until success', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            transportResolutionState.transientFailuresRemaining = 1;
            featureDecisionState.targetProbeTransientFailuresRemaining = 1;
            restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
                ok: true,
                data: { state: 'requested' },
            });
            restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason: 'cancelled' });

            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

            let scanPromise!: Promise<void>;
            await act(async () => {
                scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(transportResolutionState.calls).toHaveLength(1));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
            });
            expect(transportResolutionState.calls).toHaveLength(2);
            expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledTimes(1);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
                await scanPromise;
            });

            expect(transportResolutionState.calls).toHaveLength(2);
            expect(transportResolutionState.calls[0]).toBe(transportResolutionState.calls[1]);
            expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledTimes(2);
            expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledOnce();
            expect(restoreScanSuccessState.pairingRequestSpy).toHaveBeenCalledOnce();
            expect(restoreScanSuccessState.trackAuthEnrollmentTransientRetrySpy).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['identity_mismatch', 'identity_conflict', 'invalid_payload'] as const)(
        'keeps a %s target capability result terminal instead of retrying setup',
        async (targetProbeMode) => {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            featureDecisionState.targetProbeMode = targetProbeMode;

            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
            await act(async () => {
                await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            });

            expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledOnce();
            expect(restoreScanSuccessState.authQRStartSpy).not.toHaveBeenCalled();
            expect(restoreScanSuccessState.pairingRequestSpy).not.toHaveBeenCalled();
            expect(screen.getTextContent()).toContain(targetProbeMode !== 'invalid_payload'
                ? 'connect.wrongHomeBody'
                : 'connect.updateRequiredBody');
            expect(screen.findByTestId('restore-enrollment-retry') === null).toBe(targetProbeMode === 'invalid_payload');
            expect(modalAlertSpy).not.toHaveBeenCalled();
        },
    );

    it('keeps a saved reverse-QR Home on retryable network failure, not wrong-target', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        featureDecisionState.targetProbeMode = 'network_error';
        const { invite } = createReverseInvite('pair-reverse-probe-offline');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite }));
        });
        expect(screen.getTextContent()).toContain('connect.requesterDeviceRetryBody');
        expect(screen.getTextContent()).not.toContain('connect.requesterDeviceWrongHomeBody');
        expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull();
        expect(restoreScanSuccessState.pairingStartSpy).not.toHaveBeenCalled();
    });

    it('asks for an update when the saved reverse-QR Home cannot publish a valid feature catalog', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        featureDecisionState.targetProbeMode = 'invalid_payload';
        const { invite } = createReverseInvite('pair-reverse-unsupported');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite }));
        });
        expect(screen.getTextContent()).toContain('connect.updateRequiredBody');
        expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
        expect(restoreScanSuccessState.pairingStartSpy).not.toHaveBeenCalled();
    });

    it('does not call a bad-request feature response a transient reverse-QR failure', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        featureDecisionState.targetProbeMode = 'bad_request';
        const { invite } = createReverseInvite('pair-reverse-bad-request');
        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite }));
        });
        expect(screen.getTextContent()).toContain('connect.requesterDeviceRequestInvalidBody');
        expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull();
        expect(restoreScanSuccessState.pairingStartSpy).not.toHaveBeenCalled();
    });

    it('does not retry a bad-request feature response on a forward QR invite', async () => {
        vi.useFakeTimers();
        try {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            featureDecisionState.targetProbeMode = 'bad_request';
            const invite = { ...createHomeBInvite(), expiresAtMs: Date.now() + 1_000 };
            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
            let scanPromise!: Promise<void>;
            await act(async () => {
                scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite }));
                await Promise.resolve();
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
                await scanPromise;
            });
            expect(featureDecisionState.targetProbeSpy).toHaveBeenCalledOnce();
            expect(restoreScanSuccessState.trackAuthEnrollmentTransientRetrySpy).not.toHaveBeenCalled();
            expect(screen.getTextContent()).toContain('terminal.invalidConnectionLinkDescription');
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits for automatic completion without showing a confirmation code or approval instruction', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        let resolveWait!: (result: { ok: false; reason: 'cancelled' }) => void;
        restoreScanSuccessState.authQRWaitSpy.mockImplementation(() => new Promise((resolve) => {
            resolveWait = resolve;
        }));


        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.pairingRequestSpy).toHaveBeenCalledTimes(1));
        await act(async () => {
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('connect.securingCredentials'));
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        expect(screen.getTextContent()).toContain('home-b.test');
        expect(screen.getTextContent()).toMatch(/common\.homeProductName\b/);
        expect(screen.getTextContent()).not.toMatch(/common\.home\b/);
        expect(screen.getTextContent()).toContain('connect.requestingDeviceLabel');
        expect(screen.getTextContent()).toContain('connect.expiresAtLabel');
        expect(screen.getTextContent()).not.toContain('connect.confirmCodeComparisonBody');
        await act(async () => {
            resolveWait({ ok: false, reason: 'cancelled' });
            await scanPromise;
        });
    });

    it('surfaces an expired V2 wait as expiry instead of a generic authentication failure', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason: 'expired' });


        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(screen.getTextContent()).toContain('connect.pairingQrExpired');
        // A scanned code that expired is replaced by scanning a new one, not by retrying it.
        expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
        expect(screen.findByTestId('restore-enrollment-scan-new')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalledWith(
            'modals.authRequestExpired',
            'modals.authRequestExpiredDescription',
            expect.anything(),
        );
        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'errors.authenticationFailed');
    });

    it.each([
        ['rejected', 'connect.pairingRejectedBody'],
        ['wrong_target', 'connect.wrongHomeBody'],
        ['malformed_response', 'connect.unsupportedEnrollmentResponseBody'],
        ['update_required', 'connect.updateRequiredBody'],
    ] as const)(
        'preserves precise guidance for the %s terminal outcome',
        async (reason, expectedCopyKey) => {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
                ok: true,
                data: { state: 'requested' },
            });
            restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason });

            const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
            await act(async () => {
                await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            });

            expect(screen.getTextContent()).toContain(expectedCopyKey);
            if (reason === 'update_required') {
                expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
            } else {
                expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull();
            }
            expect(modalAlertSpy).not.toHaveBeenCalled();
        },
    );

    it('keeps the waiting status stable when poll progress advances', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        let resolveWait!: (result: AuthQrWaitResult) => void;
        restoreScanSuccessState.authQRWaitSpy.mockImplementation((_keypair, _target, options) => new Promise((resolve) => {
            resolveWait = resolve;
            options?.onProgress?.(3);
        }));

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('connect.securingCredentials'));
        expect(screen.getTextContent()).not.toContain('connect.waitingForApproval');
        expect(findAllHostTestInstances(screen.root, (node) => node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);

        await act(async () => {
            resolveWait({ ok: false, reason: 'cancelled' });
            await scanPromise;
        });
    });

    it('returns quietly to scanning when a V2 wait is cancelled', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({ ok: false, reason: 'cancelled' });


        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(restoreScanSuccessState.authQRWaitSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
        expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('owns one cancellable enrollment attempt and ignores a stale successful result', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const pairingLink = buildHomeQrInviteDeepLink({ invite: createHomeBInvite() });
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        let resolveWait!: (result: AuthQrWaitResult) => void;
        restoreScanSuccessState.authQRWaitSpy.mockImplementation(() => new Promise((resolve) => {
            resolveWait = resolve;
        }));

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        let firstAttempt!: Promise<void>;
        await act(async () => {
            firstAttempt = lastScannerProps.onScan(pairingLink);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.authQRWaitSpy).toHaveBeenCalledTimes(1));

        // A stale scanner callback or competing manual submission cannot start a second attempt.
        await act(async () => {
            await lastScannerProps.onScan(pairingLink);
        });
        expect(restoreScanSuccessState.authQRStartSpy).toHaveBeenCalledTimes(1);
        expect(restoreScanSuccessState.authQRWaitSpy).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('restore-enter-pairing-link')).toHaveLength(0);

        const waitOptions = restoreScanSuccessState.authQRWaitSpy.mock.calls[0]?.[2];
        expect(waitOptions?.shouldCancel?.()).toBe(false);
        expect(screen.findAllByTestId('restore-enrollment-cancel')).toHaveLength(0);

        await act(async () => {
            resolveWait({ ok: false, reason: 'cancelled' });
            await firstAttempt;
        });

        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.trackAccountRestoredSpy).not.toHaveBeenCalled();
        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
    });

    it('makes the credential commit non-cancellable and presents a securing stage before persistence completes', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const pairingLink = buildHomeQrInviteDeepLink({ invite: createHomeBInvite() });
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        let resolveWait!: (result: AuthQrWaitResult) => void;
        restoreScanSuccessState.authQRWaitSpy.mockImplementation(() => new Promise((resolve) => {
            resolveWait = resolve;
        }));
        let resolveAdoption!: () => void;
        restoreScanSuccessState.adoptHomeProfileSpy.mockImplementation(() => new Promise((resolve) => {
            resolveAdoption = () => resolve({
                id: 'profile-home-b',
                serverUrl: 'https://home-b.test',
                serverIdentityId: 'srv_home_b',
            });
        }));

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);

        let attempt!: Promise<void>;
        await act(async () => {
            attempt = lastScannerProps.onScan(pairingLink);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(restoreScanSuccessState.authQRWaitSpy).toHaveBeenCalledTimes(1));
        expect(screen.findAllByTestId('restore-enrollment-cancel')).toHaveLength(0);

        await act(async () => {
            resolveWait({
                ok: true,
                credentials: { token: 'tok_home_b' },
                homeServerIdentityId: 'srv_home_b',
            });
            await Promise.resolve();
        });

        await vi.waitFor(() => expect(screen.findByTestId('restore-enrollment-securing')).not.toBeNull());
        expect(screen.getTextContent()).toContain('connect.securingCredentials');
        expect(screen.findAllByTestId('restore-enrollment-cancel')).toHaveLength(0);

        await act(async () => {
            resolveAdoption();
            await attempt;
        });

        expect(restoreScanSuccessState.trackAccountRestoredSpy).toHaveBeenCalledOnce();
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it.each(['switched', 'already_active'] as const)(
        'opens the exact adopted Home for enter_home after adoption returns (%s)',
        async (switchResult) => {
            const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
            restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
                ok: true,
                data: { state: 'requested' },
            });
            restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
                ok: true,
                credentials: { token: 'tok_home_b' },
                homeServerIdentityId: 'srv_home_b',
            });
            focusMutationState.setActiveServerAndSwitchSpy.mockResolvedValue(switchResult);
            authRefreshSpy.mockClear();

            await renderScreen(<RestoreScanComputerQrView entryIntent="enter_home" />);
            await act(async () => {
                await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            });

            // One exact-Home focus owner: web stays tab-scoped, and an already
            // focused Home still refreshes auth for the newly committed credential.
            expect(focusMutationState.setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
                serverId: 'profile-srv_home_b',
                scope: 'tab',
                refreshAuth: authRefreshSpy,
                requireExactProfile: true,
            });
            expect(authRefreshSpy).toHaveBeenCalledTimes(switchResult === 'already_active' ? 1 : 0);
            expect(routerNavigationState.replaceSpy).toHaveBeenCalledWith('/');
            expect(modalAlertSpy).not.toHaveBeenCalledWith(
                'home-b.test',
                'connect.homeAddedPreservedFocusBody',
            );
        },
    );

    it('lets enter_home retry the exact retained profile after a blocked first switch', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: 'srv_home_b',
        });
        focusMutationState.setActiveServerAndSwitchSpy
            .mockResolvedValueOnce('blocked')
            .mockResolvedValueOnce('switched');
        modalAlertSpy.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'common.open')?.onPress?.();
        });

        await renderScreen(<RestoreScanComputerQrView entryIntent="enter_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(focusMutationState.setActiveServerAndSwitchSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
            serverId: 'profile-srv_home_b',
            scope: 'tab',
        }));
        expect(focusMutationState.setActiveServerAndSwitchSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
            serverId: 'profile-srv_home_b',
            scope: 'tab',
        }));
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'home-b.test',
            'connect.homeSavedOpenFailedBody',
            [
                expect.objectContaining({ text: 'common.open' }),
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
            ],
        );
        expect(routerNavigationState.replaceSpy).toHaveBeenCalledWith('/');
        expect(focusMutationState.preventRemoveSpy).toHaveBeenLastCalledWith(false);
        const lockCalls = focusMutationState.preventRemoveSpy.mock.calls.map(([locked]) => locked);
        const lockedCallIndex = lockCalls.lastIndexOf(true);
        const unlockedCallIndex = lockCalls.findIndex((locked, index) => index > lockedCallIndex && locked === false);
        expect(unlockedCallIndex).toBeGreaterThan(lockedCallIndex);
        expect(focusMutationState.preventRemoveSpy.mock.invocationCallOrder[unlockedCallIndex]!)
            .toBeLessThan(routerNavigationState.replaceSpy.mock.invocationCallOrder[0]!);
        expect(lastScannerProps.active).toBe(true);
    });

    it('lets enter_home return to the shell after the exact retained-profile switch throws', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: 'srv_home_b',
        });
        focusMutationState.setActiveServerAndSwitchSpy.mockRejectedValueOnce(new Error('switch failed'));

        await renderScreen(<RestoreScanComputerQrView entryIntent="enter_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(focusMutationState.setActiveServerAndSwitchSpy).toHaveBeenCalledOnce();
        expect(focusMutationState.setActiveServerAndSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'profile-srv_home_b',
            scope: 'tab',
        }));
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'home-b.test',
            'connect.homeSavedOpenFailedBody',
            [
                expect.objectContaining({ text: 'common.open' }),
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
            ],
        );
        expect(routerNavigationState.replaceSpy).toHaveBeenCalledWith('/');
        expect(focusMutationState.preventRemoveSpy).toHaveBeenLastCalledWith(false);
        expect(lastScannerProps.active).toBe(true);
    });

    it('preserves focus for add_home and shows the existing added result', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: 'srv_home_b',
        });

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(focusMutationState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
        expect(screen.getTextContent()).toContain('home-b.test');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('prevents standalone route removal from the irreversible request boundary', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        let resolvePairingRequest!: (result: PairingRequestResult) => void;
        restoreScanSuccessState.pairingRequestSpy.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePairingRequest = resolve;
        }));

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        let scanPromise!: Promise<void>;
        await act(async () => {
            scanPromise = lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
            await Promise.resolve();
        });

        await vi.waitFor(() => expect(focusMutationState.preventRemoveSpy).toHaveBeenLastCalledWith(true));

        await act(async () => {
            resolvePairingRequest({ ok: false, reason: 'not_found', status: 404 });
            await scanPromise;
        });
        expect(focusMutationState.preventRemoveSpy).toHaveBeenLastCalledWith(false);
    });

    it('presents a target-qualified recoverable state when credential adoption is only partially rolled back', async () => {
        const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_home_b' },
            homeServerIdentityId: 'srv_home_b',
        });
        restoreScanSuccessState.adoptHomeProfileSpy.mockRejectedValueOnce(new Error('profile adoption failed'));
        restoreScanSuccessState.rollbackCredentialWriteSpy.mockResolvedValueOnce(false);

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            await lastScannerProps.onScan(buildHomeQrInviteDeepLink({ invite: createHomeBInvite() }));
        });

        expect(screen.getTextContent()).toContain('connect.homeEnrollmentPartialCommitBody');
        expect(screen.getTextContent()).toContain('home-b.test');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.trackAccountRestoredSpy).not.toHaveBeenCalled();
    });

    it('recognizes a provenance-pinned released V1 invite with zero enrollment side effects and no secret disclosure', async () => {
        // Exact golden output asserted by cli-v0.2.1's pairingUrl.scheme.test.ts and reused by
        // packages/tests/suites/contracts/releasedV021.clientReaders.test.ts; provenance is the
        // released client commit 98ea8fb76733b1dd785d38c31360179cafa84824, not a current-type fixture.
        const releasedV1Link =
            'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1';
        // Even a fully successful-looking pairing backend must never be reached from V1.
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_v1' },
            homeServerIdentityId: 'srv_v1_identity',
        });
        const consoleSpies = [
            vi.spyOn(console, 'log'),
            vi.spyOn(console, 'info'),
            vi.spyOn(console, 'warn'),
            vi.spyOn(console, 'error'),
            vi.spyOn(console, 'debug'),
        ];
        let serializedConsoleCalls: string[] = [];
        try {

            await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
            await act(async () => {
                await lastScannerProps.onScan(releasedV1Link);
            });
        } finally {
            serializedConsoleCalls = consoleSpies.flatMap((spy) =>
                spy.mock.calls.map((args) => JSON.stringify(args)),
            );
            for (const spy of consoleSpies) spy.mockRestore();
        }

        // Zero pairing network calls: the rendezvous, polling, trusted completion, and the
        // typed v3 enrollment request are never started from a recognized V1 invite.
        expect(restoreScanSuccessState.pairingStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingStatusSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingRequestSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.completeTrustedPairingSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.authQRStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.authQRWaitSpy).not.toHaveBeenCalled();
        // Zero credential writes and no adoption.
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        // The refused invite never enters the shell and never mutates Home focus.
        expect(routerNavigationState.replaceSpy).not.toHaveBeenCalled();
        expect(focusMutationState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        // Recognition surfaces guidance only; neither the rendered guidance nor any log
        // discloses the decoded V1 secret material.
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody',
            [
                expect.objectContaining({ text: 'connect.scanNewQr' }),
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
            ],
        );
        const guidance = JSON.stringify(modalAlertSpy.mock.calls[0]);
        expect(guidance).not.toContain('sec_abc');
        expect(guidance).not.toContain('pid123');
        for (const serializedCall of serializedConsoleCalls) {
            expect(serializedCall).not.toContain('sec_abc');
        }
    });

    it('treats malformed pairing input as invalid input distinct from a recognized V1 invite', async () => {
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValue({
            ok: true,
            data: { state: 'requested' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValue({
            ok: true,
            credentials: { token: 'tok_malformed' },
            homeServerIdentityId: 'srv_malformed',
        });

        const screen = await renderScreen(<RestoreScanComputerQrView entryIntent="add_home" />);
        await act(async () => {
            // A /pair deep link missing its bound pairId fails closed as unknown input.
            await lastScannerProps.onScan('happier:///pair?v=1&secret=orphan_secret');
        });

        expect(restoreScanSuccessState.authQRStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.authQRWaitSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingStartSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingStatusSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.pairingRequestSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.setCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(restoreScanSuccessState.adoptHomeProfileSpy).not.toHaveBeenCalled();
        expect(routerNavigationState.replaceSpy).not.toHaveBeenCalled();
        // Unknown input yields the persistent invalid-input outcome, not the
        // recognized-V1 guidance or a dismissible modal dead end.
        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLinkDescription');
        expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
