import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ConnectedServiceQuotaMeterV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedServiceAccountNeedingSignIn, ConnectedServiceAccountWithoutUsage, ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import type { SidebarUsageAccountFacts } from './SidebarUsagePopoverContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    summaries: [] as ConnectedServiceQuotaSummary[],
    withoutUsage: [] as ConnectedServiceAccountWithoutUsage[],
    needingSignIn: [] as ConnectedServiceAccountNeedingSignIn[],
    keysWithoutLimits: 0,
    accounts: {} as NonNullable<SidebarUsageAccountFacts['accounts']>,
};
const modalBoundary = vi.hoisted(() => ({ show: vi.fn(() => 'modal-id') }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalBoundary.show } }).module;
});

// The popover's module graph is large; load it once up front so no single test pays for it.
beforeAll(async () => {
    await import('./SidebarUsagePopoverContent');
    await import('@/components/hub/usage/useUsageSummary');
}, 600_000);

afterEach(() => {
    state.summaries = [];
    state.withoutUsage = [];
    state.needingSignIn = [];
    state.keysWithoutLimits = 0;
    state.accounts = {};
    modalBoundary.show.mockClear();
});

function summary(key: string, accountLabel: string | null, remainingPct: number, accountEmail: string | null = null): ConnectedServiceQuotaSummary {
    return {
        key,
        serviceLabel: 'Anthropic Claude',
        serviceGroupKey: 'plugin.anthropic/claude',
        service: { pluginId: 'plugin.anthropic', localId: 'claude' },
        legacyServiceId: null,
        accountLabel,
        accountEmail,
        accountId: key.split(':')[1],
        profileId: key.split(':')[1],
        profileLabel: null,
        planLabel: 'Max',
        fetchedAt: 2_000,
        primaryMeter: null,
        recoveryCredits: null,
        meters: [{ meterId: 'weekly', label: 'Weekly limit', remainingPct, utilizationPct: 100 - remainingPct, status: 'ok', resetsAt: null }],
    };
}

async function renderContent(lastKnown = false) {
    const { SidebarUsagePopoverView, useUsagePopoverHandlers } = await import('./SidebarUsagePopoverContent');
    const { buildUsageSummary, buildUsageSummaryCache } = await import('@/components/hub/usage/useUsageSummary');
    const { presentConnectedAccountIdentity } = await import('@/sync/domains/connectedServices/maskAccountEmail');
    const { useRouter } = await import('expo-router');
    const cache = buildUsageSummaryCache(state.summaries);
    const { UsageSummaryCacheV1Schema } = await import('@/sync/domains/state/usageSummaryCache');
    const saved = lastKnown && cache ? UsageSummaryCacheV1Schema.parse(JSON.parse(JSON.stringify(cache))) : null;
    const usage = buildUsageSummary({ live: lastKnown ? null : cache, saved, accountsWithoutUsage: state.withoutUsage });
    function ContentFixture() {
        const router = useRouter();
        rendered.router = router as unknown as { push: (href: unknown) => unknown };
        const handlers = useUsagePopoverHandlers({ close: () => { rendered.closed += 1; }, router });
        return <SidebarUsagePopoverView usage={usage}
            facts={{ accountsNeedingSignIn: state.needingSignIn, keysWithoutLimits: state.keysWithoutLimits, accounts: state.accounts }}
            privacy={{ hidden: false, setHidden: () => {}, present: input => presentConnectedAccountIdentity({
                hidden: false, label: input.label ?? null, labelKind: input.labelKind,
                email: input.email ?? null, accountId: input.accountId ?? null,
            }) }}
            onOpenConnectedServices={handlers.openConnectedServices} onOpenUsage={handlers.openUsage} onSignInAgain={handlers.signInAgain} />;
    }
    return renderScreen(<ContentFixture />);
}

const rendered: { router: { push: (href: unknown) => unknown } | null; closed: number } = { router: null, closed: 0 };

describe('the Usage popover header', () => {
    it('opens the Usage page from its chart and Credentials from its gear, closing the popover first', async () => {
        state.summaries = [summary('claude:a', 'Work', 40)];
        rendered.closed = 0;
        const screen = await renderContent();
        await screen.pressByTestIdAsync('sidebar-usage-open-usage');
        expect(rendered.router!.push).toHaveBeenLastCalledWith('/settings/usage');
        await screen.pressByTestIdAsync('sidebar-usage-open-connected-services');
        expect(rendered.router!.push).toHaveBeenLastCalledWith('/settings/connected-services');
        expect(rendered.closed).toBe(2);
    });
});

describe('SidebarUsagePopoverContent', () => {
    it('keeps the order of retained accounts regardless of the displayed allowance', async () => {
        state.summaries = [summary('claude:a', 'Old zero', 0), summary('claude:b', 'Old positive', 40)];
        state.accounts = {
            'claude:a': { quotaExhausted: true, subscription: null, recoveryCredits: null },
            'claude:b': { quotaExhausted: false, subscription: null, recoveryCredits: null },
        };
        const screen = await renderContent(true);
        const order = screen.findAll(node => typeof node.props.testID === 'string' && /^sidebar-usage-account-claude:[ab]$/.test(node.props.testID))
            .map(node => node.props.testID as string).filter((id, index, all) => all.indexOf(id) === index);
        expect(order).toEqual(['sidebar-usage-account-claude:a', 'sidebar-usage-account-claude:b']);
    });
    it('keeps a dated quota reading and reset after it expires without a read failure', async () => {
        const reading = summary('claude:a', 'Work', 40);
        state.summaries = [{ ...reading, fetchedAt: Date.now() - 5 * 60_000, staleAfterMs: 120_000,
            meters: reading.meters.map(meter => ({ ...meter, resetsAt: Date.now() + 60 * 60_000 })) }];
        const screen = await renderContent();
        expect.soft(screen.getTextContent()).toMatch(/40%/);
        expect.soft(screen.getTextContent()).toMatch(/reset/i);
        const freshness = screen.findByTestId('sidebar-usage-account-claude:a.freshness');
        expect(freshness).toBeTruthy();
        expect(screen.findByTestId('sidebar-usage-refresh-error')).toBeFalsy();
    });

    it('exposes a named signed-out disclosure and an individual sign-in for every folded account', async ({ onTestFinished }) => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'web';
        onTestFinished(() => { Platform.OS = previousOS; });
        state.summaries = [summary('claude:a', 'Usable', 40)];
        state.needingSignIn = ['p', 'q', 'r'].map(id => ({
            key: `codex:${id}`, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: id },
            serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex', serviceGroupKey: 'happier.agent.codex/openai-codex',
            accountLabel: `Work ${id}`, accountEmail: null, accountId: id,
        }));
        const screen = await renderContent();
        const triggerId = 'usage-popover-signed-out-accounts';
        const trigger = () => screen.findHostByTestId(triggerId);
        const label = 'sidebarFooter.usageSignedOutAccounts(count=3)';
        expect(screen.findByTestId('sidebar-usage-signed-out-codex:p')).toBeFalsy();
        expect(screen.getTextContent()).toContain(label);
        expect.soft(trigger()?.props.accessibilityState?.expanded).toBe(false);
        await screen.pressByTestIdAsync(triggerId);
        expect.soft(trigger()?.props.accessibilityState?.expanded).toBe(true);
        const region = screen.findAll(node => typeof node.type === 'string' && node.props.role === 'region'
            && node.props.accessibilityLabel === label)[0];
        expect(region?.props.nativeID).toBeTruthy();
        expect(trigger()?.props['aria-controls']).toBe(region!.props.nativeID);
        for (const account of state.needingSignIn) {
            expect(screen.findHostByTestId(`sidebar-usage-signed-out-${account.key}-name`)).toBeTruthy();
            expect(screen.getTextContent()).toContain(account.accountLabel);
            await screen.pressByTestIdAsync(`sidebar-usage-sign-in-again-${account.key}`);
            expect(modalBoundary.show).toHaveBeenLastCalledWith(expect.objectContaining({
                props: expect.objectContaining({ request: expect.objectContaining({ account: account.ref }) }),
            }));
        }
        await screen.pressByTestIdAsync(triggerId);
        expect(trigger()?.props.accessibilityState?.expanded).toBe(false);
        expect(screen.findByTestId('sidebar-usage-signed-out-codex:p')).toBeFalsy();
    });
    it('groups fresh quota verdicts without ranking rounded, credit-backed or rate-limited accounts by their display windows', async () => {
        const { buildSummaryMeters, readConnectedServiceQuotaExhaustion } = await import('@/sync/domains/connectedServices/connectedServiceQuotaBadges');
        const allowance = (remainingPct: number) => ConnectedServiceQuotaMeterV1Schema.parse({
            meterId: 'weekly', label: 'Weekly', unit: 'count', used: null, limit: null,
            remainingPct, utilizationPct: 100 - remainingPct, resetsAt: null, status: 'ok',
        });
        const credits = ConnectedServiceQuotaMeterV1Schema.parse({
            meterId: 'credits', label: 'Credits', unit: 'credits', used: null, limit: null, remaining: 4,
            utilizationPct: null, resetsAt: null, status: 'ok', isExhausted: false,
        });
        const rateLimit = ConnectedServiceQuotaMeterV1Schema.parse({
            meterId: 'requests', label: 'Request limit', unit: 'requests', used: 10, limit: 10,
            remainingPct: 0, utilizationPct: 100, resetsAt: null, status: 'ok',
            details: { limitCategory: 'rate_limit' },
        });
        const now = Date.now();
        const readings = [
            ['a', [allowance(90)], now - 120_000],
            ['b', [allowance(0)]],
            ['c', [allowance(0.4)]],
            ['d', [allowance(10)]],
            ['e', [allowance(0), credits]],
            ['f', [allowance(70), rateLimit, credits]],
            ['g', [{ ...allowance(60), status: 'estimated' }]],
        ] as const;
        state.summaries = readings.map(([id, meters, fetchedAt]) => ({
            ...summary(`claude:${id}`, `Account ${id}`, 0),
            meters: buildSummaryMeters(meters, [], 'primary'),
            fetchedAt: fetchedAt ?? now, staleAfterMs: 60_000,
        }));
        state.accounts = Object.fromEntries(readings.map(([id, meters]) => [`claude:${id}`, {
            quotaExhausted: readConnectedServiceQuotaExhaustion(meters),
            subscription: null,
            recoveryCredits: null,
        }]));
        const screen = await renderContent();
        const order = screen.findAll(node => typeof node.props.testID === 'string' && /^sidebar-usage-account-claude:[a-g]$/.test(node.props.testID))
            .map(node => (node.props.testID as string).slice(-1)).filter((id, index, all) => all.indexOf(id) === index);
        expect(order).toEqual(['c', 'd', 'e', 'b', 'f', 'a', 'g']);
    });
    it.each([
        [null, '0 · usage.board.plans.cellNoAllowance'],
        // A reported zero cap is no allowance, never "0 of 0 left" (acceptance 11-22 #7).
        [0, 'settingsProvidersCollection.usage.amountNoAllowance'],
        [10, 'settingsProvidersCollection.usage.amountLeftOfLimit(amount=10,limit=10)'],
    ] as const)('shows the on-demand spend cap report for %s', async (limit, expected) => {
        const { buildSummaryMeters } = await import('@/sync/domains/connectedServices/connectedServiceQuotaBadges');
        const meter = ConnectedServiceQuotaMeterV1Schema.parse({
            meterId: 'on-demand', label: 'On-demand spend', unit: 'unknown', used: 0, limit,
            remaining: limit, utilizationPct: limit === 10 ? 0 : null,
            resetsAt: null, status: 'ok', limitScope: 'account',
        });
        state.summaries = [{ ...summary('claude:a', 'Billing', 0), meters: buildSummaryMeters([meter], [], 'primary') }];
        expect((await renderContent()).getTextContent()).toContain(expected);
        expect((await renderContent(true)).getTextContent()).toContain(expected);
    });

    it('reopens an older spend-only observation without guessing which cap the provider reported', async () => {
        const billing = summary('claude:a', 'Billing', 0);
        state.summaries = [{ ...billing, meters: [{
            ...billing.meters[0]!, label: 'On-demand spend', remainingPct: null, utilizationPct: null,
            reportedAmount: { unit: 'unknown', amount: { kind: 'used', used: 0 } },
        }] }];
        const text = (await renderContent(true)).getTextContent();
        expect(text).toContain('0');
        expect(text).not.toContain('usage.board.plans.cellNoAllowance');
    });

    it('folds several accounts with nothing to show into one line after the accounts that answer', async () => {
        state.summaries = [summary('claude:a', null, 73, 'kevin@gmail.com')];
        state.withoutUsage = ['c', 'd', 'e'].map(id => ({
            key: `claude:${id}`, serviceLabel: 'Anthropic Claude', legacyServiceId: null,
            serviceGroupKey: 'plugin.anthropic/claude', accountLabel: `Key ${id}`, accountEmail: null, accountId: id, state: 'unavailable' as const,
        }));
        const screen = await renderContent();
        expect(screen.findByTestId('usage-popover-unavailable-accounts')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sidebarFooter.usageUnavailableAccounts(count=3)');
        expect(screen.getTextContent()).not.toContain('common.unavailable');
    });
    it('keeps a dated quota reading and reset after it expires without a read failure', async () => {
        const reading = summary('claude:a', 'Work', 40);
        state.summaries = [{ ...reading, fetchedAt: Date.now() - 5 * 60_000, staleAfterMs: 120_000,
            meters: reading.meters.map(meter => ({ ...meter, resetsAt: Date.now() + 60 * 60_000 })) }];
        const screen = await renderContent();
        expect.soft(screen.getTextContent()).toMatch(/40%/);
        expect.soft(screen.getTextContent()).toMatch(/reset/i);
        const freshness = screen.findByTestId('sidebar-usage-account-claude:a.freshness');
        expect(freshness).toBeTruthy();
        expect(screen.findByTestId('sidebar-usage-refresh-error')).toBeFalsy();
    });

    it('shows every account with what is left in each window, and an account with nothing to show', async () => {
        state.summaries = [summary('claude:a', null, 73, 'kevin@gmail.com'), summary('claude:b', 'Work', 40)];
        state.withoutUsage = [{
            key: 'claude:c', serviceLabel: 'Anthropic Claude', legacyServiceId: null,
            serviceGroupKey: 'plugin.anthropic/claude', accountLabel: 'Home', accountEmail: null, accountId: 'c', state: 'unavailable',
        }];
        const screen = await renderContent();

        const text = screen.getTextContent();
        // The mark says the service; the name leads alone and the plan and email share the line beneath it, so with
        // many accounts no field is cut three ways (acceptance 11-13 #15).
        expect(text).not.toContain('Anthropic Claude · Work');
        expect(screen.findByTestId('sidebar-usage-account-claude:b-name')?.props.children).toBe('Work');
        expect(screen.findByTestId('sidebar-usage-account-claude:a-meta')).toBeTruthy();
        expect(text).toContain('kevin@gmail.com');
        expect(text).toContain('connectedServices.quota.remaining(percent=73%)');
        expect(text).toContain('connectedServices.quota.remaining(percent=40%)');
        // The unavailable account is named and says so, instead of vanishing from the list.
        expect(text).toContain('Home');
        expect(text).toContain('common.unavailable');
        // Its plan is shared by the provider's read accounts only when every account reports it.
        expect(screen.findByTestId('sidebar-usage-as-of')).toBeTruthy();
    });

    it('shows an account\'s subscription from its own usage record, and its usage resets', async () => {
        const now = Date.now();
        state.summaries = [{
            ...summary('codex:personal', 'Personal', 71),
            legacyServiceId: 'openai-codex',
            recoveryCredits: { availableCount: 3, nextExpiresAtMs: now + 5 * 86_400_000, credits: [] },
        }];
        state.accounts = {
            'codex:personal': {
                recoveryCredits: state.summaries[0].recoveryCredits,
                subscription: {
                    status: 'subscribed', renewal: 'on', currentPeriodEndAtMs: now + 17 * 86_400_000,
                    observedAtMs: now, staleAfterMs: 86_400_000,
                },
            },
        };
        const screen = await renderContent();
        const text = screen.getTextContent();
        expect(text).toContain('connectedServicesCollection.subscriptionRenewsIn');
        expect(text).toContain('connectedServicesCollection.usageResetsCount(count=3)');
        expect(screen.findByTestId('sidebar-usage-resets-codex:personal')).toBeTruthy();
    });

    it('says an account is still being read rather than calling it unavailable', async () => {
        state.withoutUsage = [{
            key: 'codex:a', serviceLabel: 'Codex', legacyServiceId: null,
            serviceGroupKey: 'plugin.openai/codex', accountLabel: 'Work', accountEmail: null, accountId: 'a', state: 'loading',
        }];
        const screen = await renderContent();
        const text = screen.getTextContent();
        expect(text).toContain('common.loading');
        expect(text).not.toContain('common.unavailable');
        // Nothing has been read yet, so there is no "as of".
        expect(screen.findByTestId('sidebar-usage-as-of')).toBeNull();
    });

    it('dates the shared header by the newest shown reading, never an older time above a newer row (review J-B50)', async () => {
        state.summaries = [
            { ...summary('claude:a', 'Work', 73), fetchedAt: 1_000 },
            { ...summary('claude:b', 'Personal', 40), fetchedAt: 5_000 },
        ];
        const screen = await renderContent();
        const { SurfaceAsOfLabel } = await import('@/components/ui/surfaces/SurfaceAsOfLabel');
        const times = screen.findAllByType(SurfaceAsOfLabel)
            .map((label) => label.props.at);
        expect(times).toEqual([5_000]);
    });

    it('never dates the header by a reading it does not show, nor puts an expired row\'s time above fresh rows', async () => {
        const now = Date.now();
        // An account last read days ago that reports nothing is folded into a count, so it dates nothing.
        state.summaries = [
            { ...summary('claude:a', 'Work', 73), fetchedAt: now - 60_000, staleAfterMs: 3_600_000 },
            { ...summary('claude:silent', 'Silent', 0), fetchedAt: now - 3 * 86_400_000, meters: [] },
        ];
        const quiet = await renderContent();
        const { SurfaceAsOfLabel } = await import('@/components/ui/surfaces/SurfaceAsOfLabel');
        expect(quiet.findAllByType(SurfaceAsOfLabel).map((label) => label.props.at)).toEqual([now - 60_000]);
        await quiet.unmount();

        // A shown row past its window carries its own as-of line; the header names the newest shown reading.
        state.summaries = [
            { ...summary('claude:a', 'Work', 73), fetchedAt: now - 60_000, staleAfterMs: 3_600_000 },
            { ...summary('claude:b', 'Old', 40), fetchedAt: now - 3 * 86_400_000, staleAfterMs: 120_000 },
        ];
        const expired = await renderContent();
        expect(expired.findByTestId('sidebar-usage-account-claude:b.freshness')).toBeTruthy();
        expect(expired.findAllByType(SurfaceAsOfLabel).map((label) => label.props.at)).toEqual([now - 60_000]);
        await expired.unmount();

        // Restored from the device with an undated meterless account beside them (review J-B50 arm b).
        state.summaries = [
            { ...summary('claude:a', 'Work', 73), fetchedAt: now - 5 * 60_000, staleAfterMs: 3_600_000 },
            { ...summary('claude:b', 'Personal', 40), fetchedAt: now - 60_000, staleAfterMs: 3_600_000 },
            { ...summary('claude:undated', 'Undated', 0), fetchedAt: null as unknown as number, meters: [] },
        ];
        const restored = await renderContent(true);
        expect(restored.findAllByType(SurfaceAsOfLabel).map((label) => label.props.at)).toEqual([now - 60_000]);
    });

    it('explains what usage is for when no account is connected, with the one way to connect one', async () => {
        rendered.closed = 0;
        const screen = await renderContent();
        expect(screen.findByTestId('sidebar-usage-status')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sidebarFooter.usageNoAccounts');
        await screen.pressByTestIdAsync('sidebar-usage-connect-account');
        expect(rendered.router!.push).toHaveBeenLastCalledWith('/settings/connected-services');
        expect(rendered.closed).toBe(1);
    });

    it('keeps a signed-out account beside usage with its fix, and counts keys without limits', async () => {
        state.summaries = [summary('claude:a', 'Work', 42)];
        state.keysWithoutLimits = 1;
        state.needingSignIn = [{
            key: 'codex:w', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'w' },
            serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex', serviceGroupKey: 'happier.agent.codex/openai-codex',
            accountLabel: 'Work', accountEmail: 'leeroy@company.com', accountId: 'w',
        }];
        const screen = await renderContent();

        expect(screen.getTextContent()).toContain('sidebarFooter.usageKeysWithoutLimits(count=1)');
        const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
        await act(async () => { screen.findByTestId('sidebar-usage-sign-in-again-codex:w')!.props.onPress({ currentTarget: trigger }); });
        expect(modalBoundary.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ request: {
            scope: null,
            intent: 'reconnect',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            account: state.needingSignIn[0].ref,
        } }) }));
    });

    it('names every account by a name, its email or its service, never a raw id, and says an email once', async () => {
        const uuid = '97bd5614-8970-4068-87f0-1d2c3b4a5e6f';
        state.summaries = [
            summary(`claude:${uuid}`, null, 74),
            // Earlier producers stored the account id as its display name.
            summary('claude:7e9ced1f-60ac-4618-bcf0-aa11bb22cc33', '7e9ced1f-60ac-4618-bcf0-aa11bb22cc33', 100),
        ];
        state.needingSignIn = [{
            key: 'claude:s1', ref: { service: { pluginId: 'plugin.anthropic', localId: 'claude' }, accountId: 's1' },
            serviceLabel: 'Anthropic Claude', legacyServiceId: null, serviceGroupKey: 'plugin.anthropic/claude',
            accountLabel: 'ai1@happier.dev', accountEmail: 'ai1@happier.dev', accountId: 's1',
        }];
        const text = (await renderContent()).getTextContent();

        expect(text).not.toContain(uuid);
        expect(text).not.toContain('7e9ced1f');
        // Two accounts that both read as the service's account are told apart by number, never by id.
        expect(text.split('connectedServicesCollection.accountLabel(service=Anthropic Claude)')).toHaveLength(2);
        expect(text).toContain('connectedServicesCollection.accountLabelNumbered(service=Anthropic Claude,number=2)');
        expect(text.split('ai1@happier.dev')).toHaveLength(2);
    });

    describe('the one popover (rail and session)', () => {
        async function renderView(options: Readonly<{
            hidden?: boolean;
            providerLabel?: string;
            setHidden?: (hidden: boolean) => void;
            session?: import('./SidebarUsagePopoverContent').UsagePopoverSession;
            accountState?: 'loading' | 'unavailable';
            additionalWithoutUsage?: readonly ConnectedServiceAccountWithoutUsage[];
            refresh?: import('./SidebarUsagePopoverContent').UsagePopoverRefresh;
        }> = {}) {
            const { SidebarUsagePopoverView } = await import('./SidebarUsagePopoverContent');
            const { buildUsageSummary, buildUsageSummaryCache } = await import('@/components/hub/usage/useUsageSummary');
            const { presentConnectedAccountIdentity } = await import('@/sync/domains/connectedServices/maskAccountEmail');
            const hidden = options.hidden ?? false;
            const usage = buildUsageSummary({
                live: buildUsageSummaryCache([
                    { ...summary('claude:work', 'Work', 42, 'leeroy@company.com'), profileLabel: 'Work' },
                    summary('claude:personal', options.providerLabel ?? null, 6, options.providerLabel ? null : 'kevin@gmail.com'),
                    summary('claude:acct_9f2c8e71', null, 71),
                ]),
                saved: null,
                accountsWithoutUsage: [
                    ...(options.accountState ? [{
                        key: 'claude:pending', serviceLabel: 'Anthropic Claude', legacyServiceId: 'claude-subscription' as const,
                        serviceGroupKey: 'plugin.anthropic/claude', accountLabel: 'Pending', accountEmail: null,
                        accountId: 'pending', state: options.accountState,
                    }] : []),
                    ...(options.additionalWithoutUsage ?? []),
                ],
            });
            return renderScreen(
                <SidebarUsagePopoverView
                    usage={usage}
                    privacy={{
                        hidden,
                        setHidden: options.setHidden ?? (() => {}),
                        present: (input) => presentConnectedAccountIdentity({
                            hidden,
                            label: input.label ?? null,
                            labelKind: input.labelKind,
                            email: input.email ?? null,
                            accountId: input.accountId ?? null,
                        }),
                    }}
                    session={options.session}
                    refresh={options.refresh}
                    onOpenConnectedServices={() => {}} onOpenUsage={() => {}}
                />,
            );
        }

        it.each([false, true])('presents the provider display name according to identity privacy (hidden=%s)', async hidden => {
            const label = 'Synthetic Provider Name';
            const screen = await renderView({ hidden, providerLabel: label });
            try {
                expect(screen.findByTestId('sidebar-usage-account-claude:personal-name')).toBeTruthy();
                expect(screen.getTextContent().includes(label)).toBe(!hidden);
            } finally {
                await screen.unmount();
            }
        });

        it('shows freshness once in the header for all accounts and for the scoped session', async () => {
            const { SurfaceAsOfLabel } = await import('@/components/ui/surfaces/SurfaceAsOfLabel');
            const allAccounts = await renderView();
            expect(allAccounts.findAllByType(SurfaceAsOfLabel)).toHaveLength(1);
            expect(allAccounts.findByTestId('sidebar-usage-as-of')).toBeTruthy();

            const session = await renderView({
                session: { accountKey: 'claude:work', ownSignIn: null, scopeLine: null, nextMove: null },
            });
            const labels = session.findAllByType(SurfaceAsOfLabel);
            expect(labels).toHaveLength(1);
            expect(labels[0].props.at).toBe(2_000);
        });

        it('refreshes only the session account until All accounts explicitly widens the scope', async () => {
            const scopes: Array<readonly string[] | undefined> = [];
            const screen = await renderView({
                providerLabel: 'Personal',
                session: { accountKey: 'claude:work', ownSignIn: null, scopeLine: null, nextMove: null },
                refresh: {
                    keys: ['claude:work', 'claude:personal'],
                    refreshingByKey: {},
                    errorsByKey: { 'claude:personal': 'other_account_failed' },
                    run: async (keys) => { scopes.push(keys); },
                },
            });
            expect(screen.getTextContent()).not.toContain('other_account_failed');
            await screen.pressByTestIdAsync('sidebar-usage-refresh');
            expect(scopes).toEqual([['claude:work']]);
            await screen.pressByTestIdAsync('usage-popover-all-accounts');
            await screen.pressByTestIdAsync('sidebar-usage-refresh');
            expect(scopes).toEqual([['claude:work'], undefined]);
            const retained = screen.findByTestId('sidebar-usage-account-claude:personal');
            expect(retained?.findAll(node => node.props.children === 'connectedServices.quota.remaining(percent=6%)').length).toBeGreaterThan(0);
            expect(retained?.findAll(node => node.props.children === 'common.unavailable')).toHaveLength(0);
            expect(screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join(''))
                .toBe('sidebarFooter.usageRefreshFailedAccounts(count=1,accounts=Personal)');
        });

        it.each([false, true])('names a failed account only when its unavailable row is folded (folded=%s)', async folded => {
            const screen = await renderView({
                accountState: 'unavailable',
                additionalWithoutUsage: folded ? [{
                    key: 'claude:other', serviceLabel: 'Anthropic Claude', legacyServiceId: null,
                    serviceGroupKey: 'plugin.anthropic/claude', accountLabel: 'Other', accountEmail: null,
                    accountId: 'other', state: 'unavailable',
                }] : [],
                refresh: {
                    keys: ['claude:pending'], refreshingByKey: {}, errorsByKey: { 'claude:pending': 'provider_refused' },
                    run: async () => {},
                },
            });
            const row = screen.findByTestId('sidebar-usage-account-claude:pending');
            expect(Boolean(row)).toBe(!folded);
            expect(Boolean(screen.findByTestId('usage-popover-unavailable-accounts'))).toBe(folded);
            expect(screen.getTextContent().includes('common.unavailable')).toBe(!folded);
            const warning = screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join('');
            expect(warning).toBe(folded
                ? 'sidebarFooter.usageRefreshFailedAccounts(count=1,accounts=Pending)'
                : 'sidebarFooter.usageRefreshFailedAccounts(count=1)');
        });

        it('names only the undrawn failed account when a visible row already shows its own failure', async () => {
            const screen = await renderView({
                accountState: 'unavailable',
                refresh: {
                    keys: ['claude:pending', 'claude:undrawn'], refreshingByKey: {},
                    errorsByKey: { 'claude:pending': 'provider_refused', 'claude:undrawn': 'provider_unreachable' },
                    accountIdentities: [summary('claude:undrawn', 'Undrawn', 0)],
                    run: async () => {},
                },
            });
            const visible = screen.findByTestId('sidebar-usage-account-claude:pending');
            expect(visible?.findAll(node => node.props.children === 'common.unavailable').length).toBeGreaterThan(0);
            expect(screen.findByTestId('sidebar-usage-account-claude:undrawn')).toBeFalsy();
            expect(screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join(''))
                .toBe('sidebarFooter.usageRefreshFailedAccounts(count=2,accounts=Undrawn)');
        });

        it('names the accounts whose reads failed when identities are visible and keeps the successful reading', async () => {
            const screen = await renderView({
                providerLabel: 'Synthetic Provider Name',
                refresh: {
                    keys: ['claude:work', 'claude:personal', 'claude:pending'],
                    refreshingByKey: {},
                    errorsByKey: { 'claude:personal': 'provider_refused', 'claude:pending': 'provider_unreachable' },
                    accountIdentities: [summary('claude:pending', 'Pending', 0)],
                    run: async () => {},
                },
            });
            const warning = screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join('');
            expect(warning).toContain('sidebarFooter.usageRefreshFailedAccounts(count=2,accounts=');
            expect(warning).toContain('Synthetic Provider Name');
            expect(warning).toContain('Pending');
            expect(warning).not.toContain('Work');
            expect(screen.findByTestId('sidebar-usage-as-of')).toBeTruthy();
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
            expect(screen.getTextContent()).toContain('connectedServices.quota.remaining(percent=42%)');
        });

        it.each(['rail', 'widened Session'] as const)('reports only the failed account count with identities hidden in the %s', async surface => {
            const screen = await renderView({
                hidden: true,
                providerLabel: 'Synthetic Provider Name',
                ...(surface === 'widened Session' ? {
                    session: { accountKey: 'claude:work', ownSignIn: null, scopeLine: null, nextMove: null },
                } : {}),
                refresh: {
                    keys: ['claude:work', 'claude:personal', 'claude:pending'],
                    refreshingByKey: {},
                    errorsByKey: { 'claude:personal': 'provider_refused', 'claude:pending': 'provider_unreachable' },
                    // The provider supplied both names. The failed account in the catalog has no quota row or user nickname.
                    accountIdentities: [summary('claude:pending', 'Second Synthetic Name', 0)],
                    run: async () => {},
                },
            });
            try {
                if (surface === 'widened Session') {
                    expect(screen.findByTestId('sidebar-usage-refresh-error-text')).toBeFalsy();
                    await screen.pressByTestIdAsync('usage-popover-all-accounts');
                }
                expect(screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join(''))
                    .toBe('sidebarFooter.usageRefreshFailedAccounts(count=2)');
                expect(screen.getTextContent()).not.toContain('Synthetic Provider Name');
                expect(screen.getTextContent()).not.toContain('Second Synthetic Name');
                expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
            } finally {
                await screen.unmount();
            }
        });

        it('reports a count for a longer set of failed reads', async () => {
            const screen = await renderView({
                accountState: 'unavailable',
                refresh: {
                    keys: ['claude:work', 'claude:personal', 'claude:pending', 'claude:acct_9f2c8e71'],
                    refreshingByKey: {},
                    errorsByKey: { 'claude:work': 'failed', 'claude:personal': 'failed', 'claude:pending': 'failed' },
                    run: async () => {},
                },
            });
            expect(screen.findByTestId('sidebar-usage-refresh-error-text')?.children.join(''))
                .toBe('sidebarFooter.usageRefreshFailedAccounts(count=3)');
            expect(screen.findByTestId('sidebar-usage-account-claude:acct_9f2c8e71')).toBeTruthy();
        });

        it('shows pending usage without replacing the last-updated timestamp or meters', async () => {
            const screen = await renderView({ refresh: {
                keys: ['claude:work'], refreshingByKey: { 'claude:work': true }, errorsByKey: {}, run: async () => {},
            } });
            expect(screen.findByTestId('sidebar-usage-refresh')?.props.accessibilityState?.busy).toBe(true);
            expect(screen.findByTestId('sidebar-usage-refresh-spinner')).toBeTruthy();
            expect(screen.findByTestId('sidebar-usage-as-of')).toBeTruthy();
            expect(screen.getTextContent()).toContain('connectedServices.quota.remaining(percent=42%)');
            expect(screen.findByTestId('sidebar-usage-refresh')?.props.accessibilityState?.disabled).toBe(true);
        });

        it('shows emails and ids as they are until the device hides them; names people gave stay', async () => {
            const shown = (await renderView()).getTextContent();
            expect(shown).toContain('leeroy@company.com');
            // An account with neither a name nor an email reads as its service's account, never its id.
            expect(shown).toContain('connectedServicesCollection.accountLabel(service=Anthropic Claude)');
            expect(shown).not.toContain('acct_9f2c8e71');

            const hidden = (await renderView({ hidden: true })).getTextContent();
            // A name the person gave stays readable beside its mark.
            expect(hidden).toContain('Work');
            expect(hidden).toContain('le•••@c•••.com');
            expect(hidden).toContain('ke•••@g•••.com');
            expect(hidden).not.toContain('leeroy@company.com');
            expect(hidden).not.toContain('kevin@gmail.com');
            expect(hidden).not.toContain('acct_9f2c8e71');
        });

        it('scopes to the session\'s account with its pool\'s next move, and widens to every account in place', async () => {
            const screen = await renderView({
                session: {
                    scopeLine: 'Claude Code signs in through Work pool',
                    accountKey: 'claude:work',
                    ownSignIn: null,
                    nextMove: 'When Work runs out, the next turn moves to the next account in order',
                },
            });
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
            expect(screen.findByTestId('sidebar-usage-account-claude:personal')).toBeNull();
            expect(screen.getTextContent()).toContain('sidebarFooter.usageThisSession');
            expect(screen.findByTestId('usage-popover-next-move')).toBeTruthy();
            expect(screen.getTextContent()).toContain('sidebarFooter.usageMoreAccounts(count=2)');

            await screen.pressByTestIdAsync('usage-popover-all-accounts');
            expect(screen.findByTestId('sidebar-usage-account-claude:personal')).toBeTruthy();
            expect(screen.findByTestId('usage-popover-next-move')).toBeNull();
            expect(screen.findByTestId('sidebar-usage-open-connected-services')).toBeTruthy();
        });

        it('keeps the two-word scope whole; the as-of time gives way first on one line (acceptance r227 #72)', async () => {
            const screen = await renderView({
                session: { scopeLine: 'Claude Code signs in through Work pool', accountKey: 'claude:work', ownSignIn: null, nextMove: null },
            });
            const flat = (style: unknown): Record<string, unknown> => Array.isArray(style)
                ? Object.assign({}, ...style.map(flat)) : (style ?? {}) as Record<string, unknown>;
            const scope = screen.findAll(node => typeof node.type === 'string' && node.props.children === 'sidebarFooter.usageThisSession')[0]!;
            expect(flat(scope.props.style).flexShrink ?? 0).toBe(0);
            const asOf = screen.findByTestId('sidebar-usage-as-of')!
                .findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string')[0]!;
            expect(asOf.props.numberOfLines).toBe(1);
        });

        it('keeps a known session account scoped when its usage is unavailable, until All accounts is chosen', async () => {
            const screen = await renderView({
                session: { scopeLine: 'Claude Code signs in through Work pool', accountKey: 'claude:missing', ownSignIn: null, nextMove: null },
            });
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeNull();
            expect(screen.findByTestId('usage-popover-session-unavailable')).toBeTruthy();
            expect(screen.getTextContent()).toContain('sidebarFooter.usageMoreAccounts(count=3)');
            await screen.pressByTestIdAsync('usage-popover-all-accounts');
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
        });

        it.each(['loading', 'unavailable'] as const)('keeps a known account scoped while its usage is %s', async (accountState) => {
            const screen = await renderView({
                accountState,
                session: { scopeLine: 'Claude Code uses Pending', accountKey: 'claude:pending', ownSignIn: null, nextMove: null },
            });
            expect(screen.findByTestId('sidebar-usage-account-claude:pending')).toBeTruthy();
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeNull();
            expect(screen.getTextContent()).toContain(accountState === 'loading' ? 'common.loading' : 'common.unavailable');
            await screen.pressByTestIdAsync('usage-popover-all-accounts');
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
        });

        it('shows every account when the session\'s account is not known, never a stand-in', async () => {
            const screen = await renderView({
                session: { scopeLine: 'Claude Code signs in through Work pool', accountKey: null, ownSignIn: null, nextMove: null },
            });
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeTruthy();
            expect(screen.findByTestId('sidebar-usage-account-claude:personal')).toBeTruthy();
            expect(screen.findByTestId('usage-popover-all-accounts')).toBeNull();
        });

        it('shows the windows of a session that signs in on its own', async () => {
            const screen = await renderView({
                session: {
                    scopeLine: 'Codex uses its own sign-in',
                    accountKey: null,
                    ownSignIn: {
                        title: 'Codex',
                        legacyServiceId: null,
                        windows: [{ meterId: '5h', label: '5-hour', remainingPct: 55, resetsAt: null, tone: 'success' }],
                        recoveryCredits: null,
                        resetAction: null,
                    },
                    nextMove: null,
                },
            });
            expect(screen.findByTestId('usage-popover-own-sign-in')).toBeTruthy();
            expect(screen.getTextContent()).toContain('connectedServices.quota.remaining(percent=55%)');
            expect(screen.findByTestId('sidebar-usage-account-claude:work')).toBeNull();
        });
    });
});
