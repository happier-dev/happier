import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { resetAccountPlanResourceForTests } from '@/sync/domains/plans/accountPlanResource';
import { resetLeavingSessionsResourceForTests } from '@/sync/domains/session/retention/leavingSessionsResource';
import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

vi.mock('@/components/qr', () => ({ QRCode: () => null }));
const openBrowser = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openBrowser }));

const limits = (sessions: number | null, subagents: number | null, pins: number | null) => ({
    sessionRetentionDays: sessions,
    subagentRetentionDays: subagents,
    toolOutputRetentionDays: null,
    pinnedSessions: pins,
    artifactStorageBytes: null,
});
const price = (amountMinor: number) => ({ interval: 'month' as const, amountMinor, currency: 'usd', checkoutUrl: 'https://buy.example.test/x' });

function freeOnCloud(plans: AccountPlanResponseV1['offers'] extends infer O ? O extends { plans: infer P } ? P : never : never): AccountPlanResponseV1 {
    return {
        plan: null,
        limits: limits(60, 7, 50),
        usage: { pinnedSessions: 31, artifactStorageBytes: null },
        supporter: { active: false, since: null, number: null, recurringSince: null },
        supporterRing: false,
        offers: {
            plans,
            baseLimits: limits(60, 7, 50),
            graceDays: 90,
            teams: null,
            supporter: { suggestedMonthlyMinor: 500, minimumMinor: 300, currency: 'usd', presets: { monthly: [300, 500], once: [1000] } },
            portalUrl: null,
        },
    };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const texts = (root: { findAll: (predicate: (node: { type: unknown; props: Record<string, unknown> }) => boolean) => Array<{ props: { children?: unknown } }> }) =>
    root.findAll((node) => node.type === 'Text').map((node) => node.props.children).flat(Infinity).filter((value) => typeof value === 'string').join(' | ');

describe('PlanSupporterScreen', () => {
    let respond: () => Response;
    let leaving: () => Response;
    let summary: () => Response;
    let planReads = 0;

    const platformOS = Platform.OS;

    beforeEach(() => {
        // Hosted checkout is the web and desktop path; that is where the plan buttons exist.
        Platform.OS = 'web';
        resetAccountPlanResourceForTests();
        resetLeavingSessionsResourceForTests();
        upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        planReads = 0;
        leaving = () => new Response('{}', { status: 404 });
        summary = () => new Response('{}', { status: 404 });
        setRuntimeFetch(async (input) => {
            if (String(input).endsWith('/v1/account/plan')) {
                planReads += 1;
                return respond();
            }
            if (String(input).includes('/v2/sessions/leaving')) return leaving();
            if (String(input).includes('/v2/sessions/retention-summary')) return summary();
            return new Response('{}', { status: 200 });
        });
    });

    afterEach(() => {
        Platform.OS = platformOS;
        resetRuntimeFetch();
    });

    it('draws one column per offered plan with its server numbers, from a single read', async () => {
        const lite = { id: 'lite', name: 'Lite', limits: limits(90, 14, 100), prices: [price(299)] };
        const plus = { id: 'plus', name: 'Plus', limits: limits(365, 30, 500), prices: [price(699)] };
        respond = () => new Response(JSON.stringify(freeOnCloud([lite, plus])), { status: 200 });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();

        expect(planReads).toBe(1);
        const ctas = screen.root.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('plan-ladder-cta-') && node.props.title !== undefined);
        expect(new Set(ctas.map((node) => node.props.testID))).toEqual(new Set(['plan-ladder-cta-lite', 'plan-ladder-cta-plus']));
        const shown = texts(screen.root as never);
        expect(shown).toContain('$2.99');
        expect(shown).toContain('$6.99');
        expect(shown).toContain('500');

        const onlyPlus = freeOnCloud([plus]);
        resetAccountPlanResourceForTests();
        respond = () => new Response(JSON.stringify(onlyPlus), { status: 200 });
        const second = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();
        const secondCtas = second.root.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('plan-ladder-cta-') && node.props.title !== undefined);
        expect(new Set(secondCtas.map((node) => node.props.testID))).toEqual(new Set(['plan-ladder-cta-plus']));
    });

    it('shows an error and no plan at all when the first read fails', async () => {
        respond = () => new Response('down', { status: 503 });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();

        expect(screen.root.findAll((node) => node.props.testID === 'plan-supporter-error').length).toBeGreaterThan(0);
        expect(screen.root.findAll((node) => node.props.testID === 'plan-ladder')).toHaveLength(0);
        expect(screen.root.findAll((node) => node.props.testID === 'plan-history-stats')).toHaveLength(0);
        expect(texts(screen.root as never)).not.toMatch(/\bFree\b/);
    });

    it('starts Discord linking from the enabled active supporter row and permits retry after an unavailable reply', async () => {
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const plan = freeOnCloud([]);
        const server = upsertAndActivateServer({ serverUrl: HAPPIER_CLOUD_SERVER_URL });
        const { profile, profileScope } = storage.getState();
        storage.setState({ profile: { ...profile, id: 'supporter-42' }, profileScope: { serverId: server.id, accountId: 'supporter-42' } });
        openBrowser.mockClear();
        const url = 'https://discord.com/oauth2/authorize?state=example';
        const start = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 404 })).mockResolvedValueOnce(Response.json({ url }));
        setRuntimeFetch(async (input, init) => {
            if (String(input).endsWith('/v1/supporter/discord/start')) return start(input, init);
            if (String(input).endsWith('/v1/account/plan')) return respond();
            if (String(input).includes('/v2/sessions/leaving')) return leaving();
            if (String(input).includes('/v2/sessions/retention-summary')) return summary();
            return Response.json({});
        });

        try {
            respond = () => Response.json({ ...plan, supporter: { active: true, since: 1, number: 42, recurringSince: null } });
            const screen = await renderScreen(<PlanSupporterScreen plans={false} supporter />);
            await flush();
            expect(screen.findAllByTestId('plan-supporter-ring').length).toBeGreaterThan(0);
            const row = 'plan-supporter-discord';
            expect(screen.findAllByTestId(row).length).toBeGreaterThan(0);
            expect(start).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync(row);
            expect(screen.root.findAllByProps({ testID: 'plan-supporter-discord-error' }).length).toBeGreaterThan(0);
            expect(openBrowser).not.toHaveBeenCalled();

            await screen.pressByTestIdAsync(row);
            expect(start).toHaveBeenLastCalledWith(`${HAPPIER_CLOUD_SERVER_URL}/v1/supporter/discord/start`, expect.objectContaining({ method: 'POST', body: '{}' }));
            expect(openBrowser).toHaveBeenCalledExactlyOnceWith(url);
            expect(screen.root.findAllByProps({ testID: 'plan-supporter-discord-error' })).toHaveLength(0);

            await screen.update(<PlanSupporterScreen plans supporter={false} />);
            expect(screen.findAllByTestId(row)).toHaveLength(0);
        } finally {
            await act(async () => { storage.setState({ profile, profileScope }); });
        }
    });

    it('speaks only of supporting Happier where the server offers no plans', async () => {
        const selfHosted = freeOnCloud([]);
        respond = () => new Response(JSON.stringify({ ...selfHosted, offers: { ...selfHosted.offers, baseLimits: null } }), { status: 200 });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans={false} supporter />);
        await flush();

        expect(screen.root.findAll((node) => node.props.testID === 'plan-ladder')).toHaveLength(0);
        expect(screen.root.findAll((node) => node.props.testID === 'plan-history-stats')).toHaveLength(0);
        expect(screen.root.findAll((node) => node.props.testID === 'supporter-offer-block').length).toBeGreaterThan(0);
        expect(texts(screen.root as never)).toContain('Support Happier');
    });

    it('describes custom history limits without branding the self-hosted server as Cloud', async () => {
        upsertAndActivateServer({ serverUrl: 'https://self-hosted.example.test' });
        respond = () => Response.json(freeOnCloud([]));
        summary = () => Response.json({ rule: null, windowDays: 90, sessions: 12, ticks: [], pinnedOlderThanCutoff: 0 });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();

        const shown = texts(screen.root as never);
        expect(shown).toContain('Support Happier');
        expect(shown).toContain('Your history on this server');
        expect(shown).toContain('sessions on this server');
        expect(shown).not.toMatch(/Happier Cloud|\bFree\b/);
        expect(screen.root.findAllByProps({ testID: 'plan-history-stats' }).length).toBeGreaterThan(0);
    });

    it('leaves the history card out on a self-hosted server that keeps everything, and keeps export under Your history', async () => {
        upsertAndActivateServer({ serverUrl: 'https://self-hosted.example.test' });
        const keepsEverything = freeOnCloud([]);
        respond = () => Response.json({ ...keepsEverything, limits: limits(null, null, null) });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();

        expect(screen.root.findAll((node) => node.props.testID === 'plan-history-stats')).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'plan-export-everything' }).length).toBeGreaterThan(0);
        expect(texts(screen.root as never)).not.toContain('Your history on this server');
    });

    it('pitches only history to a supporter who already has the pack, and links the leaving batch to Keep or let go', async () => {
        const lite = { id: 'lite', name: 'Lite', limits: limits(90, 14, 100), prices: [price(299)] };
        const supporterOnly = freeOnCloud([lite]);
        respond = () => new Response(JSON.stringify({
            ...supporterOnly,
            supporter: { active: true, since: Date.UTC(2026, 10, 3), number: 42, recurringSince: null },
        }), { status: 200 });
        const day = 86_400_000;
        const activity = Date.now() - 57 * day;
        leaving = () => Response.json({
            rule: { retentionDays: 60, noticeDays: 7, floorAt: Date.now() - day },
            count: 4,
            newestLeavesAt: activity + 60 * day,
            sessions: ['a', 'b', 'c', 'd'].map((id) => ({ id, updatedAt: activity, activeAt: activity })),
            nextCursor: null,
        });
        const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
        const screen = await renderScreen(<PlanSupporterScreen plans supporter />);
        await flush();
        await flush();

        const shown = texts(screen.root as never);
        expect(shown).toContain('Lite keep more of your history');
        expect(shown).not.toContain('include the Supporter pack');
        expect(shown).toContain('Supporter since 2026');
        expect(shown).not.toContain('Supporting for');
        const review = screen.root.findAll((node) => node.props.testID === 'plan-review-leaving' && typeof node.props.onPress === 'function');
        expect(review.length).toBeGreaterThan(0);
        expect(shown).toContain('Review 4 leaving');
        expect(shown).toContain('4 leave on');
    });

    it('shows completed calendar months under the pass using only the existing plan read', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-02-28T12:00:00Z'));
        try {
            respond = () => Response.json({
                ...freeOnCloud([]),
                supporter: { active: true, since: Date.UTC(2025, 0, 1), number: 42, recurringSince: Date.UTC(2027, 0, 31) },
            });
            const { PlanSupporterScreen } = await import('./PlanSupporterScreen');
            const screen = await renderScreen(<PlanSupporterScreen plans={false} supporter />);
            await flush();

            expect(texts(screen.root as never)).toContain('Supporting for 1 month · since January 2027');
            expect(planReads).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
