import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';
import { refreshAccountPlan, resetAccountPlanResourceForTests } from '@/sync/domains/plans/accountPlanResource';

import { applySupporterCode, buildCheckoutUrl, checkPurchaseAgain, openBillingManage, resolvePurchaseRef } from './purchaseFlow';

const browserOpen = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: browserOpen }));

type Call = Readonly<{ method: string; url: string; body: string | null }>;

const CODE = '0123456789abcdef0123456789abcdef';
const facts = { number: 42, kind: 'supporter_once', grantedAt: 1, recurringActive: false, revokedAt: null };
const planBody = {
    plan: null,
    limits: { sessionRetentionDays: null, subagentRetentionDays: null, toolOutputRetentionDays: null, pinnedSessions: null, artifactStorageBytes: null },
    usage: { pinnedSessions: 0, artifactStorageBytes: null },
    supporter: { active: true, since: 1, number: 42, recurringSince: null },
    supporterRing: false,
};

describe('purchaseFlow', () => {
    let calls: Call[] = [];
    let supporterRecord: unknown = null;
    let billingReference: 'account' | 'supporter_code' | undefined;

    beforeEach(() => {
        resetAccountPlanResourceForTests();
        calls = [];
        browserOpen.mockClear();
        supporterRecord = null;
        billingReference = undefined;
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            const method = String(init?.method ?? 'GET').toUpperCase();
            if (/\/v1\/(account|billing|supporter)\//.test(url)) {
                calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
            }
            if (url.endsWith('/v1/account/supporter') && method === 'GET') {
                return new Response(JSON.stringify({ record: supporterRecord }), { status: 200 });
            }
            if (url.endsWith('/v1/account/supporter') && method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 });
            if (url.endsWith('/v1/supporter/lookup')) return new Response(JSON.stringify(facts), { status: 200 });
            if (url.endsWith('/v1/billing/refresh')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
            if (url.endsWith('/v1/account/plan')) {
                return new Response(JSON.stringify({
                    ...planBody,
                    offers: { baseLimits: null, graceDays: 0, plans: [], teams: null, supporter: null, portalUrl: null, billingReference },
                }), { status: 200 });
            }
            // Reachability probes and anything else the transport asks for.
            return new Response('{}', { status: 200 });
        });
    });

    afterEach(() => {
        resetRuntimeFetch();
    });

    it('binds a Cloud purchase to the Account and a self-hosted one to a supporter code it stores first', async () => {
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        expect(await resolvePurchaseRef({ accountId: 'acct-1' })).toBe('acct-1');
        expect(calls).toEqual([]);

        upsertAndActivateServer({ serverUrl: 'http://self.example.test' });
        const ref = await resolvePurchaseRef({ accountId: 'acct-1' });
        expect(ref).toMatch(/^[0-9a-f]{32}$/);
        const put = calls.find((call) => call.method === 'PUT');
        expect(put?.url).toBe('http://self.example.test/v1/account/supporter');
        expect(JSON.parse(put?.body ?? '{}')).toEqual({ code: ref });
    });

    it('reuses an existing self-hosted code instead of minting another', async () => {
        upsertAndActivateServer({ serverUrl: 'http://self.example.test' });
        supporterRecord = { code: CODE, number: null, kind: null, grantedAt: null, recurringActive: false, revokedAt: null };
        expect(await resolvePurchaseRef({ accountId: 'acct-1' })).toBe(CODE);
        expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
    });

    it('binds checkout and refresh to the account on a preview billing server', async () => {
        upsertAndActivateServer({ serverUrl: 'https://billing-preview.example.test' });
        billingReference = 'account';
        await refreshAccountPlan();
        calls = [];

        await expect(resolvePurchaseRef({ accountId: 'acct-preview' })).resolves.toBe('acct-preview');
        await checkPurchaseAgain();
        expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
            'POST https://billing-preview.example.test/v1/billing/refresh',
            'GET https://billing-preview.example.test/v1/account/plan',
        ]);
    });

    it('builds the checkout link with the reference and amount as query parameters', () => {
        const url = new URL(buildCheckoutUrl({ checkoutUrl: 'https://buy.example.test/l/plus?x=1', ref: 'acct-1', amountMinor: 500 }));
        expect(url.origin + url.pathname).toBe('https://buy.example.test/l/plus');
        expect(url.searchParams.get('x')).toBe('1');
        expect(url.searchParams.get('reference_id')).toBe('acct-1');
        expect(url.searchParams.get('amount')).toBe('500');
    });

    it('checks again through the provider on Cloud and through the Cloud lookup on a self-hosted server', async () => {
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        await checkPurchaseAgain();
        expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/billing/refresh', 'GET /v1/account/plan']);

        calls = [];
        upsertAndActivateServer({ serverUrl: 'http://self.example.test' });
        supporterRecord = { code: CODE, number: null, kind: null, grantedAt: null, recurringActive: false, revokedAt: null };
        await checkPurchaseAgain();
        const lookup = calls.find((call) => call.url.endsWith('/v1/supporter/lookup'));
        expect(lookup?.url).toBe(`${HAPPIER_CLOUD_SERVER_URL}/v1/supporter/lookup`);
        expect(lookup?.url).not.toContain(CODE);
        expect(JSON.parse(lookup?.body ?? '{}')).toEqual({ code: CODE });
        const stored = calls.find((call) => call.method === 'PUT');
        expect(JSON.parse(stored?.body ?? '{}')).toEqual({ code: CODE, facts });
    });

    it('refuses a malformed pasted code without a request', async () => {
        upsertAndActivateServer({ serverUrl: 'http://self.example.test' });
        expect(await applySupporterCode('not-a-code')).toBe('invalid');
        expect(calls).toEqual([]);
        expect(await applySupporterCode(CODE.toUpperCase())).toBe('applied');
    });

    it('opens the configured email-code portal without asking the server to mint a session', async () => {
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        const portalUrl = 'https://polar.sh/happier/portal';

        await expect(openBillingManage(portalUrl)).resolves.toBe(true);
        expect(browserOpen).toHaveBeenCalledExactlyOnceWith(portalUrl);
        expect(calls).toEqual([]);
    });

    it('sends a store subscriber on the web to the store that sold the subscription', async () => {
        const polarPortal = 'https://polar.sh/happier/portal';
        await expect(openBillingManage(polarPortal, { accountId: 'acct-1', source: 'app_store' })).resolves.toBe(true);
        await expect(openBillingManage(polarPortal, { accountId: 'acct-1', source: 'play' })).resolves.toBe(true);
        expect(browserOpen.mock.calls.map(([url]) => url)).toEqual([
            'https://apps.apple.com/account/subscriptions',
            'https://play.google.com/store/account/subscriptions',
        ]);
        expect(calls).toEqual([]);
    });
});
