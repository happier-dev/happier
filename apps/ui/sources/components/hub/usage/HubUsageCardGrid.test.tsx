import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';

import { HubUsageCardGrid } from './HubUsageCardGrid';
import type { UsageSummaryEntry } from './useUsageSummary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(standardCleanup);

describe('HubUsageCardGrid identity privacy', () => {
    it('preserves usage for an unknown cached service without offering the built-in reset action', async () => {
        const entry = {
            key: 'novel/work', fetchedAt: 1_000, serviceLabel: 'Novel', legacyServiceId: 'novel-service',
            accountId: 'work', profileLabel: 'Work', planLabel: null, meters: [],
        } satisfies UsageSummaryEntry;
        const screen = await renderScreen(<HubUsageCardGrid entries={[entry]} facts={{
            inUseAccountKeys: new Set(),
            recoveryCreditsByKey: { 'novel/work': { availableCount: 3, credits: [] } },
            accountsNeedingSignIn: [],
        }} />);

        expect(screen.findByTestId('hub-usage.novel/work:resets')).toBeTruthy();
        expect(screen.findHostByTestId('hub-usage.novel/work:resets:use')).toBeNull();
        expect(entry.legacyServiceId).toBe('novel-service');
    });

    it('leaves freshness to the Usage section header instead of repeating it on each card', async () => {
        const entries = [
            { key: 'claude/work', fetchedAt: 1_000, serviceLabel: 'Claude', profileLabel: 'Work', planLabel: null, meters: [] },
            { key: 'claude/personal', fetchedAt: 5_000, serviceLabel: 'Claude', profileLabel: 'Personal', planLabel: null, meters: [] },
        ] satisfies UsageSummaryEntry[];
        const screen = await renderScreen(<HubUsageCardGrid entries={entries} />);
        const { SurfaceAsOfLabel } = await import('@/components/ui/surfaces/SurfaceAsOfLabel');
        expect(screen.findAllByType(SurfaceAsOfLabel)).toHaveLength(0);
        expect(screen.findByTestId('hub-usage.claude/work')).toBeTruthy();
        expect(screen.findByTestId('hub-usage.claude/personal')).toBeTruthy();
    });

    it('updates mounted cards from the device setting, masking emails and ids while preserving account names and meters', async () => {
        const previousState = storage.getState();
        const entries = [
            {
                key: 'claude/work', fetchedAt: null, serviceLabel: 'Claude', legacyServiceId: 'claude-subscription',
                accountLabel: 'Work', accountEmail: 'leeroy@company.com', accountId: 'acct_work1234',
                profileLabel: 'Work', planLabel: 'Max',
                meters: [{ meterId: '5h', label: '5-hour', remainingPct: 42, resetsAt: null }],
            },
            {
                key: 'chatgpt/email', fetchedAt: null, serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex',
                accountLabel: 'kevin@gmail.com', accountEmail: 'kevin@gmail.com', accountId: 'user_email12',
                profileLabel: 'kevin@gmail.com', planLabel: 'Pro', meters: [],
            },
            {
                key: 'chatgpt/id', fetchedAt: null, serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex',
                accountEmail: null, accountId: 'acct_9f2c8e71',
                profileLabel: null, planLabel: null, meters: [],
            },
        ] satisfies UsageSummaryEntry[];
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: { ...localSettingsDefaults, hideConnectedAccountIdentities: false },
            }));
            const screen = await renderScreen(<HubUsageCardGrid entries={entries} />);
            const shown = screen.getTextContent();
            expect(shown).toContain('leeroy@company.com');
            expect(shown).toContain('kevin@gmail.com');
            // Without a name or an email the account reads as its service's account, never its raw id.
            expect(shown).toContain('connectedServicesCollection.accountLabel');
            expect(shown).not.toContain('acct_9f2c8e71');
            // A name that is the email is said once.
            expect(shown.split('kevin@gmail.com')).toHaveLength(2);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    localSettings: { ...state.localSettings, hideConnectedAccountIdentities: true },
                }));
            });
            const hidden = screen.getTextContent();
            expect(hidden).toContain('Claude · Work');
            // Enough stays to tell accounts apart (the hidden runs are blurred on the web, `•••` elsewhere).
            expect(hidden).toMatch(/le.*@c.*\.com/);
            expect(hidden).toMatch(/ke.*@g.*\.com/);
            expect(hidden).toContain('connectedServices.quota.remaining');
            expect(hidden).not.toContain('leeroy@company.com');
            expect(hidden).not.toContain('kevin@gmail.com');
            expect(hidden).not.toContain('acct_9f2c8e71');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    localSettings: { ...state.localSettings, hideConnectedAccountIdentities: false },
                }));
            });
            expect(screen.getTextContent()).toContain('leeroy@company.com');
            expect(screen.getTextContent()).not.toContain('acct_9f2c8e71');
        } finally {
            standardCleanup();
            storage.setState(previousState, true);
        }
    });

    it('says which account a pool uses now, shows its usage resets, and gives a signed-out account its own card with the fix (lab csvc H2b)', async () => {
        const now = Date.now();
        const entries = [
            {
                key: 'chatgpt/personal', fetchedAt: now, serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex',
                accountLabel: 'Personal', accountEmail: null, accountId: 'personal', profileLabel: 'Personal', planLabel: 'Pro',
                meters: [{ meterId: '5h', label: '5-hour', remainingPct: 71, resetsAt: now + 3_600_000 }],
            },
            {
                key: 'claude/work', fetchedAt: now, serviceLabel: 'Claude', legacyServiceId: 'claude-subscription',
                accountLabel: 'Work', accountEmail: null, accountId: 'work', profileLabel: 'Work', planLabel: 'Max',
                meters: [{ meterId: '5h', label: '5-hour', remainingPct: 42, resetsAt: now + 3_600_000 }],
            },
        ] satisfies UsageSummaryEntry[];
        const onSignInAgain = vi.fn();
        const signedOut = {
            key: 'chatgpt/team', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'team' },
            serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex' as const, serviceGroupKey: 'chatgpt',
            accountLabel: 'Team', accountEmail: null, accountId: 'team',
        };
        const screen = await renderScreen(
            <HubUsageCardGrid
                entries={entries}
                facts={{
                    inUseAccountKeys: new Set(['chatgpt/personal']),
                    recoveryCreditsByKey: { 'chatgpt/personal': { availableCount: 3, credits: [] } as never },
                    accountsNeedingSignIn: [signedOut],
                    onSignInAgain,
                }}
            />,
        );

        expect(screen.findByTestId('hub-usage.chatgpt/personal:in-use')).toBeTruthy();
        expect(screen.findByTestId('hub-usage.claude/work:in-use')).toBeNull();
        expect(screen.findByTestId('hub-usage.chatgpt/personal:resets')).toBeTruthy();
        expect(screen.findHostByTestId('hub-usage.chatgpt/personal:resets:use')).toBeTruthy();
        expect(screen.findHostByTestId('hub-usage.claude/work:resets')).toBeNull();

        screen.pressByTestId('hub-usage.chatgpt/team:sign-in-again');
        expect(onSignInAgain).toHaveBeenCalledWith(signedOut);
    });
});
