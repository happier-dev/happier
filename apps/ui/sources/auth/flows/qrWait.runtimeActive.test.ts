import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { generateAuthKeyPair } from './qrStart';
import { authQRWait, type HomeQrEnrollmentTarget } from './qrWait';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const appState = vi.hoisted(() => ({ currentState: 'background' as string }));
const endpointFetchMock = vi.hoisted(() => vi.fn());
const visibilityEvents = new EventTarget();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: { OS: 'web' },
                AppState: {
                    get currentState() {
                        return appState.currentState;
                    },
                    addEventListener: (_event: string, listener: () => void) => {
                        visibilityEvents.addEventListener('change', listener);
                        return { remove: () => visibilityEvents.removeEventListener('change', listener) };
                    },
                },
            }
    );
});

let target: HomeQrEnrollmentTarget;

describe('authQRWait runtime active gating', () => {
    beforeAll(async () => {
        await sodium.ready;
        const resolution = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_b', canonicalServerUrl: 'https://home-b.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
        }));
        if (!resolution.ok) throw new Error('Expected test Home transport');
        target = resolution.transport;
    });

    beforeEach(() => setRuntimeFetch(endpointFetchMock));

    afterEach(() => {
        resetRuntimeFetch();
        endpointFetchMock.mockReset();
        appState.currentState = 'background';
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('does not poll the explicit endpoint while the runtime is inactive (background/hidden)', async () => {
        appState.currentState = 'background';
        vi.useFakeTimers();

        const keypair = generateAuthKeyPair();
        const issuedAtMs = Date.now();
        const expiresAtMs = issuedAtMs + 5_000;
        const outPromise = authQRWait(keypair, target, {
            v2Context: {
                pairId: 'pair-background',
                homeServerIdentityId: target.homeServerIdentityId,
                bindingSecret: new Uint8Array(32).fill(7),
                bindingProof: 'proof',
                direction: 'trusted_home_displays',
                issuedAtMs,
                expiresAtMs,
            },
        });

        await vi.advanceTimersByTimeAsync(10_000);

        appState.currentState = 'active';
        visibilityEvents.dispatchEvent(new Event('change'));
        await expect(outPromise).resolves.toEqual({ ok: false, reason: 'expired' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(0);

        vi.useRealTimers();
    });

    it('cancels immediately while waiting for the runtime to become active', async () => {
        appState.currentState = 'background';
        vi.useFakeTimers();

        const keypair = generateAuthKeyPair();
        const issuedAtMs = Date.now();
        const expiresAtMs = issuedAtMs + 60_000;
        const controller = new AbortController();
        const outPromise = authQRWait(keypair, target, {
            signal: controller.signal,
            v2Context: {
                pairId: 'pair-background-cancel',
                homeServerIdentityId: target.homeServerIdentityId,
                bindingSecret: new Uint8Array(32).fill(7),
                bindingProof: 'proof',
                direction: 'trusted_home_displays',
                issuedAtMs,
                expiresAtMs,
            },
        });

        controller.abort();

        await expect(outPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });

    it('schedules no poll wakes while hidden and polls on the foreground event', async () => {
        vi.useFakeTimers();
        const schedule = vi.spyOn(globalThis, 'setTimeout');
        endpointFetchMock.mockResolvedValue(new Response(null, { status: 410 }));
        const keypair = generateAuthKeyPair();
        const issuedAtMs = Date.now();
        const controller = new AbortController();
        const outPromise = authQRWait(keypair, target, {
            signal: controller.signal,
            v2Context: {
                pairId: 'pair-background-resume',
                homeServerIdentityId: target.homeServerIdentityId,
                bindingSecret: new Uint8Array(32).fill(7),
                bindingProof: 'proof',
                direction: 'trusted_home_displays',
                issuedAtMs,
                expiresAtMs: issuedAtMs + 120_000,
            },
        });
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(endpointFetchMock).not.toHaveBeenCalled();
            expect(schedule).not.toHaveBeenCalled();

            appState.currentState = 'active';
            visibilityEvents.dispatchEvent(new Event('change'));
            await expect(outPromise).resolves.toEqual({ ok: false, reason: 'expired' });
            expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        } finally {
            controller.abort();
        }
    });
});
