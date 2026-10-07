import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    summaries: [] as unknown[],
    withoutUsage: [] as unknown[],
    needingSignIn: [] as unknown[],
    keysWithoutLimits: 0,
    recordIds: {} as Record<string, string | null>,
    usageRecords: {} as Record<string, unknown>,
    persisted: null as unknown,
    refresh: async (_keys?: readonly string[]) => {},
}));
const modalSpy = vi.hoisted(() => vi.fn());

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

// The quota summaries owner has its own suite (server and daemon reads); the popover reads it
// through the usage summary owner, exactly as the hub does.
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: state.summaries,
        accountsWithoutUsage: state.withoutUsage,
        accountsNeedingSignIn: state.needingSignIn,
        keysWithoutLimits: state.keysWithoutLimits,
        inUseAccountKeys: new Set(),
        usageRecordIdsByKey: state.recordIds,
        isRefreshing: false,
        hasConnectedProfiles: state.summaries.length + state.withoutUsage.length > 0,
        refreshableKeys: state.summaries.map((summary) => (summary as { key: string }).key),
        refreshingByKey: {},
        errorsByKey: {},
        refresh: state.refresh,
    }),
}));

// The provider usage record read (server): each account's subscription.
vi.mock('@/hooks/server/connectedServices/useProviderAccountUsageSnapshots', () => ({
    useProviderAccountUsageSnapshots: () => ({ snapshotsByRecordId: state.usageRecords, loadingByRecordId: {}, stateByRecordId: {} }),
}));

// Device persistence (the encrypted warm cache).
vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadUsageSummaryWarmCache: () => state.persisted,
    saveUsageSummaryWarmCache: () => {},
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => ({ serverId: 's1', accountId: 'a1' }),
        // "Use one" looks for a live session on this account's machine; none here.
        useSessions: () => [],
        useAllMachines: () => [],
        useProfile: () => ({ connectedServicesV2: [], connectedAccountGroupsV4: [] }),
    });
});

// Signing in again runs on a machine: the popover hands it to the setup modal owner.
vi.mock('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal', () => ({
    openConnectedServiceSetupModal: modalSpy,
}));

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
    state.recordIds = {};
    state.usageRecords = {};
    state.persisted = null;
    modalSpy.mockClear();
});

function summary(key: string, accountLabel: string | null, remainingPct: number, accountEmail: string | null = null) {
    return {
        key,
        serviceLabel: 'Anthropic Claude',
        serviceGroupKey: 'plugin.anthropic/claude',
        legacyServiceId: 'claude',
        accountLabel,
        accountEmail,
        accountId: key.split(':')[1],
        profileLabel: null,
        planLabel: 'Max',
        fetchedAt: 2_000,
        primaryMeter: null,
        meters: [{ meterId: 'weekly', label: 'Weekly limit', remainingPct, utilizationPct: 100 - remainingPct, status: 'ok', resetsAt: null }],
    };
}

async function renderContent() {
    const { SidebarUsagePopoverContent } = await import('./SidebarUsagePopoverContent');
    return renderScreen(<SidebarUsagePopoverContent close={() => {}} maxHeight={520} />);
}

describe('SidebarUsagePopoverContent', () => {
    it('shows every account with what is left in each window, and an account with nothing to show', async () => {
        state.summaries = [summary('claude:a', null, 73, 'kevin@gmail.com'), summary('claude:b', 'Work', 40)];
        state.withoutUsage = [{
            key: 'claude:c', serviceLabel: 'Anthropic Claude', legacyServiceId: 'claude',
            serviceGroupKey: 'plugin.anthropic/claude', accountLabel: 'Home', accountEmail: null, accountId: 'c', state: 'unavailable',
        }];
        const screen = await renderContent();

        const text = screen.getTextContent();
        expect(text).toContain('Anthropic Claude · Work');
        expect(text).toContain('kevin@gmail.com');
        expect(text).toContain('connectedServices.quota.remaining(percent=73%)');
        expect(text).toContain('connectedServices.quota.remaining(percent=40%)');
        // The unavailable account is named and says so, instead of vanishing from the list.
        expect(text).toContain('Anthropic Claude · Home');
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
        state.recordIds = { 'codex:personal': 'record-1' };
        state.usageRecords = {
            'record-1': {
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
            key: 'codex:a', serviceLabel: 'Codex', legacyServiceId: 'codex',
            serviceGroupKey: 'plugin.openai/codex', accountLabel: 'Work', accountEmail: null, accountId: 'a', state: 'loading',
        }];
        const screen = await renderContent();
        const text = screen.getTextContent();
        expect(text).toContain('common.loading');
        expect(text).not.toContain('common.unavailable');
        // Nothing has been read yet, so there is no "as of".
        expect(screen.findByTestId('sidebar-usage-as-of')).toBeNull();
    });

    it('labels the shared header with the oldest account reading instead of the newest account time', async () => {
        state.summaries = [
            { ...summary('claude:a', 'Work', 73), fetchedAt: 1_000 },
            { ...summary('claude:b', 'Personal', 40), fetchedAt: 5_000 },
        ];
        const screen = await renderContent();
        const { SurfaceAsOfLabel } = await import('@/components/ui/surfaces/SurfaceAsOfLabel');
        const times = screen.findAllByType(SurfaceAsOfLabel)
            .map((label) => label.props.at);
        expect(times).toEqual([1_000]);
    });

    it('explains what usage is for when no account is connected', async () => {
        const screen = await renderContent();
        expect(screen.findByTestId('sidebar-usage-status')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sidebarFooter.usageNoAccounts');
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
        await screen.pressByTestIdAsync('sidebar-usage-sign-in-again-codex:w');
        expect(modalSpy).toHaveBeenCalledWith({ kind: 'reconnect', serviceKey: 'happier.agent.codex/openai-codex', accountId: 'w' });
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
            serviceLabel: 'Anthropic Claude', legacyServiceId: 'claude', serviceGroupKey: 'plugin.anthropic/claude',
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
            setHidden?: (hidden: boolean) => void;
            session?: import('./SidebarUsagePopoverContent').UsagePopoverSession;
            accountState?: 'loading' | 'unavailable';
            refresh?: import('./SidebarUsagePopoverContent').UsagePopoverRefresh;
        }> = {}) {
            const { SidebarUsagePopoverView } = await import('./SidebarUsagePopoverContent');
            const { buildUsageSummary, buildUsageSummaryCache } = await import('@/components/hub/usage/useUsageSummary');
            const { presentConnectedAccountIdentity } = await import('@/sync/domains/connectedServices/maskAccountEmail');
            const hidden = options.hidden ?? false;
            const usage = buildUsageSummary({
                live: buildUsageSummaryCache([
                    summary('claude:work', 'Work', 42, 'leeroy@company.com'),
                    summary('claude:personal', null, 6, 'kevin@gmail.com'),
                    summary('claude:acct_9f2c8e71', null, 71),
                ] as never),
                saved: null,
                accountsWithoutUsage: options.accountState ? [{
                    key: 'claude:pending', serviceLabel: 'Anthropic Claude', legacyServiceId: 'claude-subscription',
                    serviceGroupKey: 'plugin.anthropic/claude', accountLabel: 'Pending', accountEmail: null,
                    accountId: 'pending', state: options.accountState,
                }] : [],
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
                            email: input.email ?? null,
                            accountId: input.accountId ?? null,
                        }),
                    }}
                    session={options.session}
                    refresh={options.refresh}
                    onOpenConnectedServices={() => {}}
                />,
            );
        }

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
            expect(screen.getTextContent()).toContain('other_account_failed');
        });

        it('shows emails and ids as they are until the device hides them; names people gave stay', async () => {
            const shown = (await renderView()).getTextContent();
            expect(shown).toContain('leeroy@company.com');
            // An account with neither a name nor an email reads as its service's account, never its id.
            expect(shown).toContain('connectedServicesCollection.accountLabel(service=Anthropic Claude)');
            expect(shown).not.toContain('acct_9f2c8e71');

            const hidden = (await renderView({ hidden: true })).getTextContent();
            expect(hidden).toContain('Anthropic Claude · Work');
            expect(hidden).toContain('le•••@c•••.com');
            expect(hidden).toContain('ke•••@g•••.com');
            expect(hidden).not.toContain('leeroy@company.com');
            expect(hidden).not.toContain('kevin@gmail.com');
            expect(hidden).not.toContain('acct_9f2c8e71');
        });

        it('turns "Hide account emails and IDs" on from its eye', async () => {
            const setHidden = vi.fn();
            const screen = await renderView({ setHidden });
            await screen.pressByTestIdAsync('usage-popover-privacy');
            expect(setHidden).toHaveBeenCalledWith(true);
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
