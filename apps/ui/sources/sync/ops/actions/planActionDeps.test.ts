import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAccountPlanResourceForTests } from '@/sync/domains/plans/accountPlanResource';
import { listLeavingSessions } from '@/sync/api/session/apiSessionLeaving';
import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';

// serverFetch is the HTTP boundary; the real apiAccountPlan adapters and plan resource run beneath it.
const serverFetchMock = vi.hoisted(() => vi.fn());
const activeServer = vi.hoisted(() => ({ serverId: 'server-1', serverUrl: 'http://127.0.0.1:41001' }));
const openBrowser = vi.hoisted(() => vi.fn(async (_url: string) => true));

vi.mock('@/sync/http/client', () => ({ serverFetch: serverFetchMock }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: () => activeServer }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openBrowser }));

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createPlanActionDeps', () => {
    const platform = Platform.OS;

    beforeEach(() => {
        resetAccountPlanResourceForTests();
        serverFetchMock.mockReset();
        openBrowser.mockClear();
        activeServer.serverUrl = 'http://127.0.0.1:41001';
    });

    afterEach(() => {
        Platform.OS = platform;
    });

    it('maps a 409 not_a_supporter ring write to a typed refusal', async () => {
        serverFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'not_a_supporter' }));
        const { createPlanActionDeps } = await import('./planActionDeps');

        await expect(createPlanActionDeps(() => 'account-1').supporterRingSet!({ visible: true })).resolves.toEqual({
            ok: false,
            errorCode: 'not_a_supporter',
        });
    });

    it('refuses billing refresh off Happier Cloud without calling the route', async () => {
        serverFetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not_found' }));
        const { createPlanActionDeps } = await import('./planActionDeps');

        await expect(createPlanActionDeps(() => 'account-1').billingRefresh!()).resolves.toEqual({
            ok: false,
            errorCode: 'billing_refresh_cloud_only',
        });
        expect(serverFetchMock.mock.calls.map(([path]) => path)).toEqual(['/v1/account/plan']);
    });

    it('sends only the existing supporter code from a self-hosted account and rejects consent outside Discord', async () => {
        Platform.OS = 'ios';
        const { profileScope } = storage.getState();
        storage.setState({ profileScope: { serverId: activeServer.serverId, accountId: 'account-1' } });
        try {
            const code = '0123456789abcdef0123456789abcdef';
            serverFetchMock
                .mockResolvedValueOnce(jsonResponse(200, {
                    record: { code, number: 42, kind: 'supporter_once', grantedAt: 1, recurringActive: false, recurringSince: null, revokedAt: null },
                }))
                .mockResolvedValueOnce(jsonResponse(200, { url: 'https://discord.com.example.test/oauth2/authorize' }));
            const { createPlanActionDeps } = await import('./planActionDeps');

            await expect(createPlanActionDeps(() => 'account-1').supporterDiscordLink!()).resolves.toBe(false);
            expect(serverFetchMock.mock.calls.map(([path]) => path)).toEqual([
                '/v1/account/supporter', `${HAPPIER_CLOUD_SERVER_URL}/v1/supporter/discord/start`,
            ]);
            expect(serverFetchMock).toHaveBeenLastCalledWith(
                `${HAPPIER_CLOUD_SERVER_URL}/v1/supporter/discord/start`,
                expect.objectContaining({ method: 'POST', body: JSON.stringify({ code }), redirect: 'error' }),
                { includeAuth: false },
            );
            expect(openBrowser).not.toHaveBeenCalled();
        } finally {
            storage.setState({ profileScope });
        }
    });

    it('reads later pages and returns their titles and leaving dates without fetching sessions by id', async () => {
        const rule = { retentionDays: 1, noticeDays: 7, floorAt: 0 };
        const row = (id: string, updatedAt: number) => ({
            id, updatedAt, activeAt: 0, encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, dataEncryptionKey: null,
        });
        serverFetchMock
            .mockResolvedValueOnce(jsonResponse(200, {
                rule, count: 2, newestLeavesAt: 86_400_002, sessions: [row('newer', 2)], nextCursor: 'page+2',
            }))
            .mockResolvedValueOnce(jsonResponse(200, {
                rule, count: 2, newestLeavesAt: 86_400_002, sessions: [row('older', 1)], nextCursor: null,
            }));
        await expect(listLeavingSessions({ readTitle: async (session) => `Title for ${session.id}` })).resolves.toEqual({
            count: 2,
            sessions: [
                { id: 'older', leavesAt: 86_400_001, title: 'Title for older' },
                { id: 'newer', leavesAt: 86_400_002, title: 'Title for newer' },
            ],
        });
        expect(serverFetchMock.mock.calls.map(([path]) => path)).toEqual([
            '/v2/sessions/leaving?limit=200', '/v2/sessions/leaving?limit=200&cursor=page%2B2',
        ]);
    });

    it('uses account billing when explicitly declared by a preview host and refuses payments below the offer minimum', async () => {
        Platform.OS = 'web';
        serverFetchMock.mockResolvedValueOnce(jsonResponse(200, {
            plan: null,
            limits: { sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 10, artifactStorageBytes: null },
            usage: { pinnedSessions: 0, artifactStorageBytes: null },
            supporter: { active: false, since: null, number: null, recurringSince: null },
            supporterRing: false,
            offers: {
                billingReference: 'account',
                baseLimits: null,
                graceDays: 90,
                plans: [],
                teams: null,
                supporter: {
                    suggestedMonthlyMinor: 500,
                    minimumMinor: 300,
                    currency: 'USD',
                    presets: { monthly: [300], once: [1000] },
                    checkoutUrls: { monthly: null, once: 'https://buy.example.test/supporter-once' },
                },
                portalUrl: null,
            },
        }));
        const { createPlanActionDeps } = await import('./planActionDeps');
        const actions = createPlanActionDeps(() => 'account-1');
        const checkout = actions.billingCheckoutOpen!;

        await expect(checkout({ offerId: 'supporter', interval: 'once', amountMinor: 299 })).resolves.toBe('unavailable');
        await expect(checkout({ offerId: 'supporter', interval: 'once', amountMinor: 1000 })).resolves.toBe('opened');
        expect(openBrowser).toHaveBeenCalledExactlyOnceWith('https://buy.example.test/supporter-once?reference_id=account-1&amount=1000');
        expect(serverFetchMock).toHaveBeenCalledTimes(1);

        await expect(actions.supporterCodeApply!({ code: '0123456789abcdef0123456789abcdef' })).resolves.toBe('invalid');
        expect(serverFetchMock).toHaveBeenCalledTimes(1);
        serverFetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
        await expect(actions.billingRefresh!()).resolves.toEqual({ ok: true });
        expect(serverFetchMock.mock.calls[1]?.[0]).toBe('/v1/billing/refresh');
    });
});
