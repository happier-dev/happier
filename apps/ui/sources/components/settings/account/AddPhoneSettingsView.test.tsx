import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from '../../account/accountTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

const modalMocks = vi.hoisted(() => ({
    alertAsync: vi.fn(async () => {}),
}));

installAccountCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: modalMocks, renderCustomModals: true }).module;
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async (_value: string) => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

const AUTH_FIXTURE = Object.freeze({
    isAuthenticated: true,
    credentials: Object.freeze({ token: 'focused-home-b-token' }),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => AUTH_FIXTURE,
}));

const tokenStorageMocks = vi.hoisted(() => ({
    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'captured-home-a-token' })),
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            ...tokenStorageMocks,
        },
    };
});

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));

vi.mock('@/platform/digest', () => ({
    digest: vi.fn(async () => new Uint8Array(32).fill(1)),
}));

const homeState = vi.hoisted(() => ({
    activeServerUrl: 'https://stack.example.test',
    activeServerId: 'profile-test',
    selectedFeatureProfileId: 'profile-test',
    boundQrV2Enabled: true,
    savedProfiles: [] as Array<{
        id: string;
        name: string;
        serverUrl: string;
        canonicalServerUrl: string;
        serverIdentityId: string;
    }>,
    descriptorOverride: null as import('@happier-dev/protocol').HomeConnectionDescriptorV1 | null,
}));
function currentDescriptor(): import('@happier-dev/protocol').HomeConnectionDescriptorV1 | null {
    if (homeState.descriptorOverride) return homeState.descriptorOverride;
    if (!homeState.activeServerUrl.startsWith('https://')) return null;
    return {
        v: 1,
        homeServerIdentityId: 'srv_test',
        canonicalServerUrl: homeState.activeServerUrl,
        revision: 1,
        endpoints: [{ kind: 'https', url: homeState.activeServerUrl }],
    };
}
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    // The Home naming rule (`readServerProfileHomeName`) stays real; the stored profiles are fixtures.
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerUrl: () => homeState.activeServerUrl,
    loadHomeViewState: () => null,
    listServerProfiles: () => homeState.savedProfiles,
    getServerProfileById: (profileId: string) => {
        const profile = homeState.savedProfiles.find((candidate) => candidate.id === profileId) ?? null;
        return profile?.id === homeState.activeServerId
            ? { ...profile, serverUrl: homeState.activeServerUrl, canonicalServerUrl: homeState.activeServerUrl }
            : profile;
    },
    buildHomeConnectionDescriptorForProfile: (profile: {
        canonicalServerUrl?: string;
        serverUrl: string;
        serverIdentityId?: string;
    }) => {
        if (homeState.descriptorOverride) return homeState.descriptorOverride;
        const canonicalServerUrl = profile.canonicalServerUrl ?? profile.serverUrl;
        const homeServerIdentityId = profile.serverIdentityId;
        if (!homeServerIdentityId || !canonicalServerUrl.startsWith('https://')) return null;
        return {
            v: 1,
            homeServerIdentityId,
            canonicalServerUrl,
            revision: 1,
            endpoints: [{ kind: 'https', url: canonicalServerUrl }],
        };
    },
    reconcileServerProfileHomeConnectionDescriptor: vi.fn(async () => ({ kind: 'applied', profile: { id: 'profile-test' } })),
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 0,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => {
        return ({
        serverId: homeState.activeServerId,
        serverUrl: homeState.activeServerUrl,
        generation: 0,
        activeShareableServerUrl: homeState.activeServerUrl,
        activeShareableServerUrlValidatedAgainstServerUrl: homeState.activeServerUrl,
        runtimeOrigin: null,
        });
    },
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: () => ({
        status: 'ready',
        serverIdentityId: 'srv_test',
        features: {
            features: { auth: { pairing: { boundQrV2: { enabled: homeState.boundQrV2Enabled } } } },
            capabilities: { server: { canonicalServerUrl: homeState.activeServerUrl } },
        },
    }),
    getServerFeaturesSnapshot: async (params?: { serverId?: string }) => {
        homeState.selectedFeatureProfileId = params?.serverId ?? homeState.activeServerId;
        const profile = homeState.savedProfiles.find((candidate) => candidate.id === homeState.selectedFeatureProfileId);
        return {
            status: 'ready',
            serverIdentityId: profile?.serverIdentityId ?? 'srv_test',
            features: {
                features: { auth: { pairing: { boundQrV2: { enabled: homeState.boundQrV2Enabled } } } },
                capabilities: { server: { canonicalServerUrl: profile?.canonicalServerUrl ?? homeState.activeServerUrl } },
            },
        };
    },
    observeAuthenticatedServerFeaturesFresh: async () => {
        const profile = homeState.savedProfiles.find((candidate) => candidate.id === homeState.selectedFeatureProfileId);
        const descriptor = homeState.descriptorOverride
            ?? (homeState.selectedFeatureProfileId === homeState.activeServerId ? currentDescriptor() : null)
            ?? (profile
            ? {
                v: 1 as const,
                homeServerIdentityId: profile.serverIdentityId,
                canonicalServerUrl: profile.canonicalServerUrl,
                revision: 1,
                endpoints: [{ kind: 'https' as const, url: profile.canonicalServerUrl }],
            }
            : null);
        return descriptor
            ? {
                status: 'ready',
                serverIdentityId: descriptor.homeServerIdentityId,
                features: {
                    features: { auth: { pairing: { boundQrV2: { enabled: homeState.boundQrV2Enabled } } } },
                    capabilities: { server: { canonicalServerUrl: descriptor.canonicalServerUrl } },
                    homeConnectionDescriptor: descriptor,
                },
            }
            : { status: 'error', reason: 'network' };
    },
}));

let pairingExpiresAt = new Date(Date.now() + 60_000).toISOString();
let accountApprovalResponse: any = { ok: true, status: 200, json: async () => ({ success: true }) };
let pairingConsumeResponse: any = { ok: true, status: 200, json: async () => ({ success: true }) };
const serverFetchSpy = vi.fn(async (path: string, _init?: any, _options?: any) => {
    if (path === '/v1/auth/pairing/start') {
        return {
            ok: true,
            status: 200,
            json: async () => ({ pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;
    }
    if (path.startsWith('/v1/auth/pairing/status')) {
        return pairingStatusResponse;
    }
    if (path === '/v1/auth/account/response') {
        return accountApprovalResponse;
    }
    if (path === '/v1/auth/pairing/consume') {
        return pairingConsumeResponse;
    }
    throw new Error(`Unexpected serverFetch path: ${path}`);
});

let pairingStatusResponse: any = {
    ok: true,
    status: 200,
    json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
} as any;

vi.mock('@/sync/http/client', () => ({
    serverFetch: (path: string, init?: any, options?: any) => serverFetchSpy(path, init, options),
    createServerFetchAtEndpoint: (requestContext: any) => (
        path: string,
        init?: any,
        options?: any,
    ) => serverFetchSpy(path, init, { ...options, requestContext }),
}));

// Collect the real page graph after configuring the shared platform/modal boundaries,
// rather than loading it inside a timed test or before that configuration exists.
const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

describe('AddPhoneSettingsView', () => {
    beforeEach(() => {
        homeState.activeServerId = 'profile-test';
        homeState.activeServerUrl = 'https://stack.example.test';
        homeState.selectedFeatureProfileId = homeState.activeServerId;
        homeState.boundQrV2Enabled = true;
        homeState.savedProfiles = [{
            id: homeState.activeServerId,
            name: 'Focused Home',
            serverUrl: homeState.activeServerUrl,
            canonicalServerUrl: homeState.activeServerUrl,
            serverIdentityId: 'srv_test',
        }];
        pairingExpiresAt = new Date(Date.now() + 60_000).toISOString();
        accountApprovalResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
        pairingConsumeResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
        serverFetchSpy.mockClear();
        tokenStorageMocks.getCredentialsForServerUrl.mockClear();
        homeState.descriptorOverride = null;
    });
    afterEach(() => {
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alertAsync.mockClear();
    });

    it('issues and cancels the modal code on its displayed Home while another Home stays focused', async () => {
        homeState.savedProfiles.push({
            id: 'profile-home-b', name: 'Home B',
            serverUrl: 'https://home-b.example.test', canonicalServerUrl: 'https://home-b.example.test',
            serverIdentityId: 'srv_home_b',
        });
        pairingStatusResponse = {
            ok: true, status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        };
        const { Modal, ModalProvider } = await import('@/modal');
        const { showHomePairingModal } = await import('@/components/auth/pairing/HomePairingModal');
        Modal.hideAll();
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await act(async () => showHomePairingModal('phone', 'profile-home-b'));
        await flushHookEffects({ cycles: 4 });

        expect(screen.findByTestId('home-pairing-modal-qr')).toBeTruthy();
        const start = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/start');
        expect(start?.[2]?.requestContext).toMatchObject({
            serverId: 'profile-home-b', endpointUrl: 'https://home-b.example.test',
        });
        expect(homeState.activeServerId).toBe('profile-test');

        await act(async () => Modal.hideAll());
        await flushHookEffects({ cycles: 2 });
        const cancel = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/consume');
        expect(JSON.parse(String(cancel?.[1]?.body))).toEqual({ pairId: 'pair_123', intent: 'cancel' });
        expect(cancel?.[2]?.requestContext).toMatchObject({ serverId: 'profile-home-b' });
        expect(screen.findByTestId('home-pairing-modal-qr')).toBeNull();
    });

    it('renders a pairing QR code after starting a session', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });
        const qrContainer = screen.findByTestId('add-phone-qr');
        if (!qrContainer) {
            throw new Error(`Expected QR container; rendered=${screen.getTextContent()}`);
        }
        const qr = qrContainer.findByType('QRCode');
        expect(qr.props.foregroundColor).toBeUndefined();
        expect(qr.props.backgroundColor).toBeUndefined();
        const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        expect(parseHomeQrInviteDeepLink(String(qr.props.data))?.invite).toMatchObject({
            v: 2,
            intent: 'home_device',
            pairId: 'pair_123',
            home: { homeServerIdentityId: 'srv_test' },
        });
        // The panel counts down to the code's expiry while it waits for the phone.
        expect(screen.findByTestId('add-phone-countdown')).toBeTruthy();
        expect(screen.getTextContent()).toContain('homeSetup.waitingForPhone');
    });

    it('pairs against the selected saved Home without changing the focused Home', async () => {
        homeState.savedProfiles = [
            ...homeState.savedProfiles,
            {
                id: 'profile-home-b',
                name: 'Home B',
                serverUrl: 'https://home-b.example.test',
                canonicalServerUrl: 'https://home-b.example.test',
                serverIdentityId: 'srv_home_b',
            },
        ];
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;
        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });
        serverFetchSpy.mockClear();

        const homeB = screen.findByTestId('add-phone-home-profile-profile-home-b');
        expect(homeB).toBeTruthy();
        await act(async () => homeB?.props.onPress());
        await flushHookEffects({ cycles: 4 });

        const startCall = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/start');
        expect(startCall?.[2]?.requestContext).toMatchObject({
            serverId: 'profile-home-b',
            endpointUrl: 'https://home-b.example.test',
        });
        expect(homeState.activeServerId).toBe('profile-test');
        expect(screen.getTextContent()).toContain('connect.addPhoneChooseHomeFooter');
    });

    it('clears the QR code when the Home gives up on a code early, and offers a new one', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: false,
            status: 404,
            json: async () => ({ error: 'not_found' }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 1 });

        expect(screen.findAllByTestId('add-phone-qr')).toHaveLength(0);
        expect(screen.findByTestId('add-phone-expired')).toBeTruthy();

        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.pairingQrExpired');
        expect(screen.findByTestId('add-phone-generate')).toBeTruthy();
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
        // Not renewed behind the person's back: only the one code was made.
        expect(serverFetchSpy.mock.calls.filter((call) => call[0] === '/v1/auth/pairing/start')).toHaveLength(1);
    });

    it('makes the next code when the current one runs out while the page stays open', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        // The first code lives about a second; the Home reports it gone once it has run out. The next
        // code (made while the page stays open) lives a minute.
        let starts = 0;
        let currentExpiresAtMs = 0;
        const baseline = serverFetchSpy.getMockImplementation()!;
        serverFetchSpy.mockImplementation(async (path: string, init?: any, options?: any) => {
            if (path === '/v1/auth/pairing/start') {
                starts += 1;
                currentExpiresAtMs = Date.now() + (starts === 1 ? 1_200 : 60_000);
                pairingExpiresAt = new Date(currentExpiresAtMs).toISOString();
            }
            if (path.startsWith('/v1/auth/pairing/status')) {
                return Date.now() >= currentExpiresAtMs
                    ? { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as any
                    : { ok: true, status: 200, json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }) } as any;
            }
            return baseline(path, init, options);
        });
        try {
            const screen = await renderScreen(<AddPhoneSettingsView />);

            // The lifecycle notices the expiry on its own poll schedule (real timers), so wait for the
            // outcome within the case's own budget rather than a fixed number of flushes.
            const runnerTimeoutMs = (globalThis as { __vitest_worker__?: { config?: { testTimeout?: number } } })
                .__vitest_worker__?.config?.testTimeout;
            await vi.waitFor(async () => {
                await flushHookEffects({ cycles: 1 });
                expect(serverFetchSpy.mock.calls.filter((call) => call[0] === '/v1/auth/pairing/start')).toHaveLength(2);
                // The new code is live: the panel waits for the phone again.
                expect(screen.getTextContent()).toContain('homeSetup.waitingForPhone');
            }, { timeout: runnerTimeoutMs, interval: 50 });
        } finally {
            serverFetchSpy.mockImplementation(baseline);
        }
    });

    it('renders the lifecycle update requirement inline when the selected Home lacks bound QR v2', async () => {
        homeState.boundQrV2Enabled = false;
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });

        const textContent = screen.getTextContent();
        expect(screen.findByTestId('add-phone-update-required')).toBeTruthy();
        expect(textContent).toContain('connect.updateRequiredTitle');
        expect(textContent).toContain('connect.updateRequiredBody');
        expect(textContent).not.toContain('modals.pleaseSignInFirst');
        expect(modalMocks.alertAsync).not.toHaveBeenCalled();
    });

    it('fails closed when a local development Home has no shareable application endpoint', async () => {
        homeState.activeServerUrl = 'http://localhost:53288';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);

        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('connect.serverUrlNotEmbeddedTitle');
        expect(screen.findAllByTestId('add-phone-qr')).toHaveLength(0);
        expect(textContent).toContain('homeSetup.codeFailed');
    });

    it('keeps the secret-bearing pairing link hidden until the user reveals it, then copies it', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });
        expect(screen.findAllByTestId('add-phone-pairing-link')).toHaveLength(0);
        const showLinkButton = screen.findByTestId('add-phone-pairing-link-details');
        expect(showLinkButton).toBeTruthy();
        expect(showLinkButton?.props.accessibilityState).toMatchObject({ expanded: false });

        await act(async () => {
            showLinkButton!.props.onPress();
        });
        expect(screen.findByTestId('add-phone-pairing-link')).toBeTruthy();
        expect(screen.findByTestId('add-phone-pairing-link-details')?.props.accessibilityState)
            .toMatchObject({ expanded: true });
        expect(screen.getTextContent()).toContain('connect.pairingLinkSecurityWarning');
        const copyLinkButton = screen.findByTestId('add-phone-pairing-link-copy');
        expect(copyLinkButton).toBeTruthy();
        await act(async () => {
            await copyLinkButton!.props.action();
        });

        expect(clipboardMocks.setStringAsync).toHaveBeenCalledTimes(1);
        const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        expect(parseHomeQrInviteDeepLink(String(clipboardMocks.setStringAsync.mock.calls[0]?.[0]))?.invite.v).toBe(2);
        expect(modalMocks.alertAsync).not.toHaveBeenCalledWith('common.success', 'common.copied');
        expect(screen.findByTestId('add-phone-pairing-link-copy-feedback')).toBeTruthy();
    });

    it('automatically completes the captured Home once with no code or direct-QR decision UI', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        const requestedPublicKey = new Uint8Array(32).fill(9);
        const expiresAt = pairingExpiresAt;
        const expiresAtMs = Date.parse(expiresAt);
        const { computeHomeQrBindingProofV2 } = await import('@happier-dev/protocol');
        const { encodeBase64 } = await import('@/encryption/base64');
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({
                state: 'requested',
                pairId: 'pair_123',
                expiresAt,
                requestedPublicKey: encodeBase64(requestedPublicKey),
                requestedDeviceLabel: 'Phone',
                homeServerIdentityId: 'srv_test',
                bindingProof: computeHomeQrBindingProofV2({
                    direction: 'trusted_home_displays',
                    qrSecret: new Uint8Array(32).fill(7),
                    pairId: 'pair_123',
                    homeServerIdentityId: 'srv_test',
                    requesterPublicKey: requestedPublicKey,
                    expiresAtMs,
                }),
            }),
        } as any;
        accountApprovalResponse = {
            ok: false,
            status: 409,
            json: async () => ({ error: 'already_completed' }),
        } as any;
        serverFetchSpy.mockClear();

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });

        expect(screen.findByTestId('add-phone-request-confirm-code')).toBeNull();
        expect(screen.findByTestId('add-phone-approve')).toBeNull();
        expect(screen.findByTestId('add-phone-reject')).toBeNull();
        expect(screen.findByTestId('add-phone-complete')).toBeTruthy();
        expect(screen.findByTestId('add-phone-pairing-link-details')).toBeNull();
        expect(screen.findByTestId('add-phone-pairing-link')).toBeNull();
        expect(screen.getTextContent()).toContain('homeSetup.deviceJoined');
        expect(screen.getTextContent()).not.toContain('connect.homeAddedPreservedFocusBody');
        expect(screen.getTextContent()).not.toContain('common.unavailable');

        expect(tokenStorageMocks.getCredentialsForServerUrl).toHaveBeenCalledWith(
            'https://stack.example.test',
            { serverId: 'profile-test' },
        );
        const approvalCall = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/account/response');
        expect(approvalCall).toBeTruthy();
        expect(approvalCall?.[2]?.requestContext?.credentials).toEqual({
            token: 'captured-home-a-token',
        });
        expect(JSON.parse(String(approvalCall?.[1]?.body))).toMatchObject({
            pairId: 'pair_123',
            publicKey: encodeBase64(requestedPublicKey),
            homeServerIdentityId: 'srv_test',
            responseKind: 'tokenOnly',
            response: expect.any(String),
        });
        const approvalBody = JSON.parse(String(approvalCall?.[1]?.body)) as { response: string };
        const { inspectTerminalProvisioningV3Payload } = await import('@happier-dev/protocol');
        expect(inspectTerminalProvisioningV3Payload(
            (await import('@/encryption/base64')).decodeBase64(approvalBody.response),
        )).toEqual({ type: 'tokenOnly' });
        expect(serverFetchSpy.mock.calls.some((call) => call[0] === '/v1/auth/pairing/consume')).toBe(false);
        expect(serverFetchSpy.mock.calls.filter((call) => call[0] === '/v1/auth/account/response')).toHaveLength(1);
        expect(serverFetchSpy.mock.calls.filter((call) => call[0] === '/v1/auth/pairing/start')).toHaveLength(1);
    });

    it('shows one create-new-QR recovery after a terminal completion failure', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        const requestedPublicKey = new Uint8Array(32).fill(9);
        const expiresAt = pairingExpiresAt;
        const { computeHomeQrBindingProofV2 } = await import('@happier-dev/protocol');
        const { encodeBase64 } = await import('@/encryption/base64');
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({
                state: 'requested', pairId: 'pair_123', expiresAt,
                requestedPublicKey: encodeBase64(requestedPublicKey), requestedDeviceLabel: null,
                homeServerIdentityId: 'srv_test',
                bindingProof: computeHomeQrBindingProofV2({
                    direction: 'trusted_home_displays',
                    qrSecret: new Uint8Array(32).fill(7), pairId: 'pair_123',
                    homeServerIdentityId: 'srv_test', requesterPublicKey: requestedPublicKey,
                    expiresAtMs: Date.parse(expiresAt),
                }),
            }),
        } as any;
        accountApprovalResponse = new Response(null, { status: 403 });
        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 4 });

        expect(screen.findByTestId('add-phone-invalid-request')).toBeTruthy();
        expect(screen.findAllByTestId('add-phone-generate')).toHaveLength(1);
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
        expect(screen.findByTestId('add-phone-approve')).toBeNull();
        expect(screen.findByTestId('add-phone-reject')).toBeNull();
    });

    it('omits only the QR image and keeps the exact link behind disclosure when the invite exceeds QR capacity', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        const longRelayUrls = Array.from({ length: 4 }, (_, index) =>
            `https://relay-${index}.example.test/${'a'.repeat(470)}`,
        );
        homeState.descriptorOverride = {
            v: 1,
            homeServerIdentityId: 'srv_test',
            canonicalServerUrl: 'https://stack.example.test',
            revision: 1,
            endpoints: [
                {
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: longRelayUrls,
                    directAddresses: ['192.0.2.10:443', '192.0.2.11:443'],
                },
                { kind: 'https', url: 'https://stack.example.test' },
            ],
        };
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 2 });

        // Only the QR image is unavailable; the pairing stays live and the
        // oversized descriptor reaches the invite unchanged.
        expect(screen.findByTestId('add-phone-qr')?.findAllByType('QRCode')).toHaveLength(0);
        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.pairingQrTooLargeTitle');
        expect(textContent).toContain('connect.pairingQrTooLargeBody');
        expect(screen.findByTestId('add-phone-invalid-request')).toBeNull();
        expect(screen.findByTestId('add-phone-cancel')).toBeTruthy();

        // The exact secret-bearing link stays behind the existing warning/disclosure.
        expect(screen.findAllByTestId('add-phone-pairing-link')).toHaveLength(0);
        const showLinkButton = screen.findByTestId('add-phone-pairing-link-details');
        expect(showLinkButton).toBeTruthy();
        await act(async () => {
            showLinkButton!.props.onPress();
        });
        expect(screen.getTextContent()).toContain('connect.pairingLinkSecurityWarning');
        const copyLinkButton = screen.findByTestId('add-phone-pairing-link-copy');
        expect(copyLinkButton).toBeTruthy();
        await act(async () => {
            await copyLinkButton!.props.action();
        });
        expect(clipboardMocks.setStringAsync).toHaveBeenCalledTimes(1);
        const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        expect(parseHomeQrInviteDeepLink(String(clipboardMocks.setStringAsync.mock.calls[0]?.[0]))?.invite.home)
            .toEqual(homeState.descriptorOverride);

        // The live pairing can still be cancelled through the strict decision.
        await act(async () => {
            await screen.findByTestId('add-phone-cancel')!.props.action();
        });
        const cancellationCall = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/consume');
        expect(JSON.parse(String(cancellationCall?.[1]?.body))).toEqual({ pairId: 'pair_123', intent: 'cancel' });
    });

    it('cancels a pending invite through the strict cancellation decision and does not create a successor invite', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 2 });
        // While a code is live the page offers cancelling it, not making another.
        expect(screen.findByTestId('add-phone-generate')).toBeNull();
        const cancelButton = screen.findByTestId('add-phone-cancel');
        expect(cancelButton).toBeTruthy();
        await act(async () => {
            await cancelButton!.props.action();
        });

        const cancellationCall = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/consume');
        expect(JSON.parse(String(cancellationCall?.[1]?.body))).toEqual({ pairId: 'pair_123', intent: 'cancel' });
        expect(serverFetchSpy.mock.calls.filter((call) => call[0] === '/v1/auth/pairing/start')).toHaveLength(1);
        expect(screen.findByTestId('add-phone-pairing-link')).toBeNull();
        // A new code is one press away, and only on request.
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
    });

    it('cancels the live code when the panel leaves the screen', async () => {
        homeState.activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: pairingExpiresAt }),
        } as any;
        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('add-phone-qr')).toBeTruthy();

        await act(async () => { screen.tree.unmount(); });
        await flushHookEffects({ cycles: 2 });

        const cancellationCall = serverFetchSpy.mock.calls.find((call) => call[0] === '/v1/auth/pairing/consume');
        expect(JSON.parse(String(cancellationCall?.[1]?.body))).toEqual({ pairId: 'pair_123', intent: 'cancel' });
    });
});
