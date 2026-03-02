import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/auth/pairing/pairingSecret', () => ({
    createPairingSecret: vi.fn(async () => ({ secret: 'sec_test', secretHash: 'hash_test' })),
}));

const pairingStartMock = vi.fn(async () => ({ ok: true, data: { pairId: 'pair_123', expiresAt: Date.now() + 60_000 } }));
const pairingStatusMock = vi.fn(async () => ({ ok: true, data: { state: 'pending', pairId: 'pair_123', expiresAt: Date.now() + 60_000 } }));
vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingStart: pairingStartMock,
    pairingStatus: pairingStatusMock,
}));

let activeServerUrl = 'http://localhost:53288';
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    getActiveServerSnapshot: () => ({ serverId: 'srv-a', serverUrl: activeServerUrl, generation: 0 }),
}));

let cachedCanonicalServerUrl: string | null = null;
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: () =>
        cachedCanonicalServerUrl
            ? { status: 'ready', features: { capabilities: { server: { canonicalServerUrl: cachedCanonicalServerUrl } } } }
            : null,
}));

describe('usePairingSession (pairing deep link server URL)', () => {
    beforeEach(() => {
        vi.resetModules();
        pairingStartMock.mockClear();
        pairingStatusMock.mockClear();
        cachedCanonicalServerUrl = null;
        activeServerUrl = 'http://localhost:53288';
    });

    it('does not embed a loopback server URL in the deep link', async () => {
        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Probe />);
        });
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('server')).toBeNull();

            await act(async () => {
                hookApi!.clearSession();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('prefers a canonical server URL when available', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Probe />);
        });
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('server')).toBe('https://api.example.test');

            await act(async () => {
                hookApi!.clearSession();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('sanitizes credentials out of canonical server URLs before embedding', async () => {
        cachedCanonicalServerUrl = 'https://user:pass@api.example.test';
        activeServerUrl = 'https://active.example.test';

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Probe />);
        });
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('server')).toBe('https://api.example.test');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
