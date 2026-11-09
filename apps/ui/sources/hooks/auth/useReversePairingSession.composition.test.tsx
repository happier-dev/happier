import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveHomeQrBindingKeyV2,
    deriveHomeQrRendezvousVerifierV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
    sealTerminalProvisioningV3Payload,
    sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderHook } from '@/dev/testkit';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

installTokenStorageWebPlatformMocks();

const boundary = vi.hoisted(() => ({
    createRequest: vi.fn(),
    fetch: vi.fn(),
    probe: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (input: unknown) => {
        boundary.createRequest(input);
        return boundary.fetch;
    },
    serverFetch: vi.fn(() => {
        throw new Error('Focused Home request must not be used by QR enrollment');
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    probeServerFeaturesAtUrl: (...args: unknown[]) => boundary.probe(...args),
}));

vi.mock('@/utils/runtime/isRuntimeActive', () => ({ isRuntimeActive: () => true }));
vi.mock('@/track', () => ({ trackAuthEnrollmentTransientRetry: vi.fn() }));

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('requester-displayed Home QR role composition', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;

    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.resetModules();
        boundary.createRequest.mockReset();
        boundary.fetch.mockReset();
        boundary.probe.mockReset();
    });

    it.each(['tokenOnly', 'dataKey'] as const)(
        'keeps a credentialless requester QR live while a second authenticated client starts and completes %s material',
        async (materialKind) => {
        vi.useFakeTimers({ now: new Date('2026-09-06T12:00:00.000Z') });
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `reverse_qr_composition_${Date.now()}`;
        restoreLocalStorage = installLocalStorageMock().restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const { pairingStart, pairingStatus } = await import('@/sync/api/account/apiPairingAuth');
        const { useReversePairingSession } = await import('./useReversePairingSession');

        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        await profiles.setActiveServerId(homeA.id);
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://home-b.test',
            revision: 4,
            endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
        };
        const homeB = await profiles.adoptHomeProfile({
            descriptor,
            source: 'qr',
            descriptorAuthority: 'current_connection_observation',
        });
        expect(await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        })).toBeNull();

        boundary.probe.mockResolvedValue({
            status: 'ready',
            serverIdentityId: descriptor.homeServerIdentityId,
            features: {
                features: {
                    auth: { pairing: { boundQrV2: { enabled: true } } },
                },
            },
        });

        let pairingRow: {
            pairId: string;
            expiresAtMs: number;
            request: Record<string, unknown> | null;
        } | null = null;
        let authorizedResponse: Record<string, unknown> | null = null;
        boundary.fetch.mockImplementation(async (path: string, init?: RequestInit, options?: { includeAuth?: boolean }) => {
            const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
            if (path === '/v2/auth/account/request' && !('pairId' in body)) {
                return json(200, { state: 'requested' });
            }
            if (path === '/v1/auth/pairing/start') {
                expect(options?.includeAuth).toBe(true);
                expect(body.direction).toBe('requester_displays');
                pairingRow = {
                    pairId: String(body.pairId),
                    expiresAtMs: Number(body.expiresAtMs),
                    request: null,
                };
                return json(200, {
                    pairId: pairingRow.pairId,
                    expiresAt: new Date(pairingRow.expiresAtMs).toISOString(),
                });
            }
            if (path === '/v1/auth/pairing/request') {
                expect(options?.includeAuth).toBe(false);
                if (!pairingRow) return json(404, { error: 'not_found' });
                pairingRow.request = body;
                return json(200, { state: 'requested' });
            }
            if (path.startsWith('/v1/auth/pairing/status?')) {
                expect(options?.includeAuth).toBe(true);
                if (!pairingRow) return json(404, { error: 'not_found' });
                if (!pairingRow.request) {
                    return json(200, {
                        state: 'pending',
                        pairId: pairingRow.pairId,
                        expiresAt: new Date(pairingRow.expiresAtMs).toISOString(),
                    });
                }
                return json(200, {
                    state: 'requested',
                    pairId: pairingRow.pairId,
                    expiresAt: new Date(pairingRow.expiresAtMs).toISOString(),
                    requestedPublicKey: pairingRow.request.publicKey,
                    requestedDeviceLabel: null,
                    bindingProof: pairingRow.request.bindingProof,
                    homeServerIdentityId: pairingRow.request.homeServerIdentityId,
                });
            }
            if (path === '/v2/auth/account/request' && 'pairId' in body) {
                return json(200, authorizedResponse ?? { state: 'requested' });
            }
            throw new Error(`Unexpected QR boundary request: ${path}`);
        });

        const hook = await renderHook(() => useReversePairingSession({
            enabled: true,
            targetProfileId: homeB.id,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('ready'));
        expect(pairingRow).toBeNull();
        expect(hook.getCurrent().canCancel).toBe(true);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(homeA.id);

        const ready = hook.getCurrent().presentation;
        if (ready.phase !== 'ready') throw new Error('Expected requester invite');
        const qrSecret = decodeBase64(ready.invite.qrSecretBase64Url, 'base64url');
        const scannerTransport = await resolveHomeEnrollmentTransport(descriptor);
        if (!scannerTransport.ok) throw new Error('Expected HTTPS enrollment transport');
        const scannerTarget = { ...scannerTransport.transport, serverId: homeB.id };

        await expect(pairingStart({
            direction: 'requester_displays',
            pairId: ready.invite.pairId,
            expiresAtMs: ready.invite.expiresAtMs,
            secretHash: encodeBase64(deriveHomeQrRendezvousVerifierV2(qrSecret), 'base64url'),
        }, scannerTarget)).resolves.toEqual({
            ok: true,
            data: {
                pairId: ready.invite.pairId,
                expiresAt: new Date(ready.invite.expiresAtMs).toISOString(),
            },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        await vi.waitFor(() => expect(pairingRow?.request).not.toBeNull());
        expect(hook.getCurrent().presentation.phase).toBe('ready');
        expect(hook.getCurrent().canCancel).toBe(false);

        const scannerStatus = await pairingStatus({ pairId: ready.invite.pairId }, scannerTarget);
        expect(scannerStatus).toMatchObject({
            ok: true,
            data: {
                state: 'requested',
                pairId: ready.invite.pairId,
                homeServerIdentityId: descriptor.homeServerIdentityId,
            },
        });

        if (!('requesterPublicKeyBase64Url' in ready.invite)) throw new Error('Expected requester-displayed invite');
        const requesterPublicKey = decodeBase64(ready.invite.requesterPublicKeyBase64Url, 'base64url');
        const token = materialKind === 'tokenOnly' ? 'home-b-token' : 'home-b-data-key-token';
        const dataKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
        const sealedMaterial = materialKind === 'tokenOnly'
            ? sealTerminalProvisioningV3TokenOnlyPayload({
                terminalEphemeralPublicKey: requesterPublicKey,
                pairingSecret: deriveHomeQrBindingKeyV2(qrSecret),
                createdAtMs: ready.invite.issuedAtMs,
                expiresAtMs: ready.invite.expiresAtMs,
                randomBytes: tweetnacl.randomBytes,
            })
            : sealTerminalProvisioningV3Payload({
                contentPrivateKey: dataKey,
                terminalEphemeralPublicKey: requesterPublicKey,
                pairingSecret: deriveHomeQrBindingKeyV2(qrSecret),
                createdAtMs: ready.invite.issuedAtMs,
                expiresAtMs: ready.invite.expiresAtMs,
                randomBytes: tweetnacl.randomBytes,
            });
        authorizedResponse = {
            state: 'authorized',
            tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(token), requesterPublicKey)),
            response: encodeBase64(sealedMaterial),
        };

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('succeeded'));

        expect(hook.getCurrent().canCancel).toBe(false);
        expect(await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        })).toEqual(materialKind === 'tokenOnly'
            ? { token }
            : {
                token,
                encryption: {
                    machineKey: encodeBase64(dataKey),
                    publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(dataKey).publicKey),
                },
            });
        expect(profiles.getActiveServerSnapshot().serverId).toBe(homeA.id);
        expect(boundary.createRequest).not.toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-a.test',
        }));

        await hook.unmount();
        await scannerTarget.close();
        },
    );
});
