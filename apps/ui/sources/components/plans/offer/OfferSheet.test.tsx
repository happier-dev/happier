import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { getAccountPlanEntry, refreshAccountPlan, resetAccountPlanResourceForTests } from '@/sync/domains/plans/accountPlanResource';
import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

// The system browser is the boundary: the sheet's contract is the link it hands over.
const opened: string[] = [];
vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: async (url: string) => {
        opened.push(url);
        return true;
    },
}));
vi.mock('@/components/qr', () => ({ QRCode: () => null }));

const offer = {
    suggestedMonthlyMinor: 500,
    minimumMinor: 300,
    currency: 'usd',
    presets: { monthly: [300, 500, 1000], once: [1000, 2500] },
    checkoutUrls: { monthly: 'https://buy.example.test/monthly', once: 'https://buy.example.test/once' },
};

describe('OfferSheet', () => {
    const originalPlatform = Platform.OS;
    let requests = 0;

    beforeEach(() => {
        Platform.OS = 'web';
        resetAccountPlanResourceForTests();
        opened.length = 0;
        requests = 0;
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        setRuntimeFetch(async (input) => {
            if (/\/v1\//.test(String(input))) requests += 1;
            return new Response('{}', { status: 200 });
        });
    });

    afterEach(() => {
        Platform.OS = originalPlatform;
        resetRuntimeFetch();
    });

    it('chooses amounts without a request, refuses one below the minimum, and opens checkout bound to the Account', async () => {
        const { OfferSheet } = await import('./OfferSheet');
        const screen = await renderScreen(
            <OfferSheet onClose={() => {}} offer={offer} accountId="acct-1" allowCodePaste={false} prefilledCode={null} />,
        );
        const pressTile = async (id: string) => {
            const tile = screen.root.find((node) => node.props.testID === `supporter-amount:${id}` && typeof node.props.onPress === 'function');
            await act(async () => tile.props.onPress());
        };
        const cta = () => screen.root.find((node) => node.props.testID === 'supporter-checkout-cta' && node.props.title !== undefined);

        await pressTile('other');
        const input = screen.root.find((node) => node.props.testID === 'supporter-amount-other-input' && typeof node.props.onChangeText === 'function');
        await act(async () => input.props.onChangeText('2'));
        expect(cta().props.disabled).toBe(true);
        expect(cta().props.accessibilityHint).toBeTruthy();

        await pressTile('1000');
        expect(cta().props.disabled).toBeFalsy();
        expect(requests).toBe(0);

        await act(async () => {
            await cta().props.onPress();
        });
        expect(opened).toHaveLength(1);
        const url = new URL(opened[0]!);
        expect(url.origin + url.pathname).toBe('https://buy.example.test/monthly');
        expect(url.searchParams.get('reference_id')).toBe('acct-1');
        expect(url.searchParams.get('amount')).toBe('1000');
    });

    it('opens a self-hosted offer with only a one-time link without checking for a purchase', async () => {
        upsertAndActivateServer({ serverUrl: 'https://self-hosted.example.test' });
        setRuntimeFetch(async () => {
            requests += 1;
            return new Response('{}', { status: 503 });
        });
        const { OfferSheet } = await import('./OfferSheet');
        const screen = await renderScreen(
            <OfferSheet onClose={() => {}} offer={{ ...offer, checkoutUrls: { monthly: null, once: offer.checkoutUrls.once } }}
                accountId="acct-1" allowCodePaste prefilledCode={null} />,
        );

        const cta = screen.root.find((node) => node.props.testID === 'supporter-checkout-cta' && node.props.title !== undefined);
        expect(cta.props.disabled).toBe(false);
        expect(screen.root.findAllByProps({ testID: 'supporter-offer-error' })).toHaveLength(0);
        expect(requests).toBe(0);
    });

    it('leaves the ring off when entitlement arrives before the viewer starts a purchase', async () => {
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            return Response.json(path === '/v1/account/plan' ? {
                plan: null,
                limits: { sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 10, artifactStorageBytes: null },
                usage: { pinnedSessions: 0, artifactStorageBytes: null },
                supporter: { active: true, since: 1000, number: 123, recurringSince: null },
                supporterRing: false,
            } : { visible: true });
        });

        const { OfferSheet } = await import('./OfferSheet');
        const screen = await renderScreen(
            <OfferSheet onClose={() => {}} offer={offer} accountId="acct-1" allowCodePaste={false} prefilledCode={null} />,
        );
        await act(async () => refreshAccountPlan());

        expect(requests).toContain('/v1/account/plan');
        expect(getAccountPlanEntry().data?.supporter.active).toBe(true);
        expect(opened).toEqual([]);
        expect(requests).not.toContain('/v1/account/supporter/ring');
        expect(screen.root.findAllByProps({ testID: 'supporter-thanks' })).toHaveLength(0);
    });
});
