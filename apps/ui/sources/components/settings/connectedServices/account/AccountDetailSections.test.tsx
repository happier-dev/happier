import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { act } from '@/dev/testkit';
import { ItemList } from '@/components/ui/lists/ItemList';

import { AccountDetailFactsSectionsView, AccountDetailUsageSectionView, AccountDetailSubscriptionSectionView, AccountDetailResetsSectionView, AccountDetailWorksOnSection, AccountDetailWorksOnSectionView, projectAccountDetailMachines, type AccountDetailUsageFacts } from './AccountDetailSections';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import * as machineDisplayNames from '@/utils/sessions/machineDisplayNames';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { projectIndexMeters } from '../index/ConnectedAccountIndexRow';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

const FACTS: AccountDetailUsageFacts = {
    meters: [
        { meterId: 'five_hour', label: '5-hour', remainingPct: 60, resetsAt: null, status: 'ok' },
        { meterId: 'seven_day', label: 'Weekly', remainingPct: 10, resetsAt: null, status: 'ok' },
    ],
    fetchedAt: 1_000,
    planLabel: null,
    subscription: null,
    recoveryCredits: null,
    loading: false,
    error: null,
    refreshing: false,
    refresh: null,
};

describe('AccountDetailUsageSectionView', () => {
    it('keeps the usage and timestamp visible beside its pending refresh status', async () => {
        const screen = await renderScreen(<ItemList><AccountDetailUsageSectionView
            facts={{ ...FACTS, refreshing: true, refresh: vi.fn() }} signedOut={false} now={2_000}
        /></ItemList>);
        expect(screen.findByTestId('account-detail-usage:refresh-status')).toBeTruthy();
        expect(screen.findByTestId('account-detail-usage:as-of')).toBeTruthy();
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
        expect(screen.findByTestId('account-detail-usage:refresh')?.props.disabled).toBe(true);
    });

    it('shows the quota failure reason beside retained usage and offers retry', async () => {
        const retry = vi.fn();
        const error = 'Couldn’t refresh usage. Try again after 12:30.';
        const screen = await renderScreen(<AccountDetailUsageSectionView
            facts={{ ...FACTS, error, refresh: retry }} signedOut={false} now={2_000}
        />);
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
        expect(screen.getTextContent()).toContain(error);
        const errorRow = screen.findByTestId('account-detail-usage:error');
        expect(errorRow).toBeTruthy();
        await screen.pressByTestIdAsync('account-detail-usage:error-action');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('explains that observation-only usage appears after a Session without showing an error', async () => {
        const screen = await renderScreen(<AccountDetailUsageSectionView
            facts={{ ...FACTS, meters: [], fetchedAt: 0, usageState: 'not_loaded', refresh: vi.fn() }}
            signedOut={false} now={2_000}
        />);
        expect(screen.getTextContent()).toContain('Usage appears after a Session reports it.');
        expect(screen.findByTestId('account-detail-usage:error')).toBeNull();
    });

    // Orchestrator decision F2 (VIS-P8-STATES, 2026-11-03): a signed-out account says one thing, its signed-out
    // state and Sign in action. A refresh failure from before the sign-out is stale, so it is dropped.
    it('drops a stale refresh failure on a signed-out account and keeps its retained usage', async () => {
        const error = 'Couldn’t refresh usage. Try again after 12:30.';
        const screen = await renderScreen(<AccountDetailUsageSectionView
            facts={{ ...FACTS, error, refresh: vi.fn() }} signedOut now={2_000}
        />);
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain(error);
        expect(screen.findByTestId('account-detail-usage:error')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:refresh')).toBeNull();
    });

    it('filters empty account windows, preserves a pinned unavailable window, and keeps errors visible', async () => {
        const base = { used: null, limit: null, unit: 'unknown', utilizationPct: null, resetsAt: null, status: 'unavailable', details: {} } as const;
        const reported: ConnectedServiceQuotaMeterV1[] = [
            { ...base, meterId: 'full', label: 'Full', utilizationPct: 0, status: 'ok' },
            { ...base, meterId: 'empty', label: 'Empty', utilizationPct: 100, status: 'ok' },
            { ...base, meterId: 'placeholder', label: 'Placeholder' },
            { ...base, meterId: 'pinned', label: 'Pinned' },
        ];
        const rows = projectIndexMeters(reported, 2_000, ['pinned']);
        expect(rows.map((row) => row.meterId)).toEqual(['full', 'empty', 'pinned']);
        const screen = await renderScreen(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: rows }} signedOut={false} now={2_000} pins={{ pinnedMeterIds: ['pinned'], onToggle: () => {} }} />);
        expect(screen.findByTestId('account-detail-usage:meter:placeholder')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:pin:pinned')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Unavailable');
        await screen.update(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: [], error: 'Couldn’t refresh usage.' }} signedOut={false} now={2_000} />);
        expect(screen.findByTestId('account-detail-usage:error')).toBeTruthy();
        await screen.update(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: [] }} signedOut={false} now={2_000} />);
        expect(screen.getTextContent()).not.toContain('billed per use');
        expect(screen.getTextContent()).toContain('Unavailable');
    });

    it('keeps compact usage timestamp without repeating the page refresh control', async () => {
        const screen = await renderScreen(<ItemList><AccountDetailUsageSectionView facts={{ ...FACTS, fetchedAt: Date.now() - 1000, refresh: vi.fn() }} signedOut={false} now={Date.now()} compact /></ItemList>);
        expect(screen.findByTestId('account-detail-usage:refresh') === null).toBe(true);
        expect(screen.findByTestId('account-detail-usage:as-of')).not.toBeNull();
    });
    it('reads compact subscription as one status line without a separate section heading', async () => {
        const screen = await renderScreen(<AccountDetailSubscriptionSectionView serviceLabel="ChatGPT" planLabel="Pro" now={2_000} compact subscription={{ status: 'subscribed', renewal: 'off', observedAtMs: 1_000, staleAfterMs: 100_000, currentPeriodEndAtMs: 86_402_000 }} />);
        expect(screen.findByTestId('account-detail-subscription')).not.toBeNull();
        expect(screen.root.findAll((node) => node.props.title === 'Subscription')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Not renewing');
    });
    it('pins a usage window from its row, showing which windows are pinned', async () => {
        const onTogglePinnedMeter = vi.fn();
        const screen = await renderScreen(
            <AccountDetailUsageSectionView
                facts={FACTS}
                signedOut={false}
                now={2_000}
                pins={{ pinnedMeterIds: ['seven_day'], onToggle: onTogglePinnedMeter }}
            />,
        );

        const pinOf = (meterId: string) => screen.root.findAll((node) => (
            node.props.testID === `account-detail-usage:pin:${meterId}` && typeof node.props.onPress === 'function'
        ))[0];
        expect(pinOf('seven_day')?.props.selected).toBe(true);
        expect(pinOf('five_hour')?.props.selected).toBe(false);

        screen.pressByTestId('account-detail-usage:pin:five_hour');
        expect(onTogglePinnedMeter).toHaveBeenCalledWith('five_hour');
    });

    it('offers no pins without a pin owner', async () => {
        const screen = await renderScreen(<AccountDetailUsageSectionView facts={FACTS} signedOut={false} now={2_000} />);
        expect(screen.findByTestId('account-detail-usage:pin:five_hour')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
    });
});

describe('AccountDetailResetsSectionView', () => {
    it('shows saved grant facts and provider metadata with an inert Use action', async () => {
        const use = vi.fn();
        const screen = await renderScreen(<AccountDetailResetsSectionView
            recoveryCredits={{ availableCount: 0, credits: [
                { id: 'saved', kind: 'usage_limit_reset', status: 'unknown', title: 'Provider grant', description: 'Provider metadata', expiresAtMs: 86_402_000 },
            ] }}
            recoveryCreditDetails={{ saved: { remainingCount: 2, appliesToProviderLimitIds: ['five_hour', 'seven_day', 'provider-special'], unavailableReason: 'paused' } }}
            now={2_000} pending={false} onUse={use}
        />);
        expect(screen.getTextContent()).toContain('Provider grant');
        expect(screen.getTextContent()).toContain('Provider metadata');
        expect(screen.getTextContent()).toContain('Saved resets: 2');
        expect(screen.getTextContent()).toContain('5-hour limit');
        expect(screen.getTextContent()).toContain('Weekly limit');
        expect(screen.getTextContent()).toContain('provider-special');
        expect(screen.getTextContent()).toContain('Paused');
        const action = screen.findByTestId('account-detail-resets:saved:use');
        expect(action?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('account-detail-resets:saved:use');
        expect(use).not.toHaveBeenCalled();
    });
});

it('retains saved-reset facts when the detail has no live reset action', async () => {
    const screen = await renderScreen(<AccountDetailFactsSectionsView
        facts={{ ...FACTS, recoveryCredits: { availableCount: 0, credits: [{ id: 'saved', kind: 'usage_limit_reset', status: 'unknown', title: 'Saved provider grant' }] } }}
        serviceLabel="Service" signedOut={false} now={2_000} resetsSection={null}
    />);
    expect(screen.getTextContent()).toContain('Saved provider grant');
    expect(screen.findByTestId('account-detail-resets:saved:use')).toBeNull();
});

it('keeps usage meters while hiding stale subscription facts for an explicit API-key account', async () => {
    const facts: AccountDetailUsageFacts = { ...FACTS, planLabel: 'Old subscription', subscription: {
        status: 'subscribed', renewal: 'on', observedAtMs: 1_000, staleAfterMs: 10_000,
        currentPeriodEndAtMs: 86_402_000,
    } };
    const screen = await renderScreen(<AccountDetailFactsSectionsView
        facts={facts} accessMode={{ kind: 'apiKey', keySuffix: null }} serviceLabel="Service" signedOut={false} now={2_000}
    />);
    expect(screen.findByTestId('account-detail-subscription')).toBeNull();
    expect(screen.getTextContent()).not.toContain('Old subscription');
    expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
    await screen.update(<AccountDetailFactsSectionsView
        facts={facts} accessMode={{ kind: 'subscription' }} serviceLabel="Service" signedOut={false} now={2_000}
    />);
    expect(screen.findByTestId('account-detail-subscription')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Old subscription');
    expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
});

describe('projectAccountDetailMachines', () => {
    it('renders held display names with 139 hydrating bodies and no fetch or name work for unrelated arrivals', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const machines = Array.from({ length: 139 }, (_, index) => createMachineFixture({
            id: `held-${String(index).padStart(3, '0')}`, active: false, activeAt: 0,
            metadata: { ...createMachineFixture().metadata!,
                displayName: index === 1 || index === 2 ? 'Build box' : index === 3 ? undefined : index === 4 ? 'Private locked builder' : `Build machine ${index}`,
                host: index === 3 ? 'ae10d3d5dc89' : `build-${index}.local`,
            },
        }));
        const bodies = machines.map((machine, index) => ({ ...machine, metadata: null,
            availability: index === 4 ? { kind: 'locked', reason: 'decryption_failed' } as const : undefined,
        }));
        const hidden = createMachineFixture({ id: 'revoked-hidden', revokedAt: 1 });
        const display = Object.fromEntries([...machines, hidden].map(machine => [machine.id, buildMachineDisplayRenderableFromMachine(machine)]));
        const foreign = createMachineFixture({ id: machines[0]!.id,
            metadata: { ...machines[0]!.metadata!, displayName: 'Foreign account builder' } });
        storage.setState(state => ({ profile: { ...state.profile, id: 'held-name-account' },
            profileScope: { serverId, accountId: 'held-name-account' },
            machines: Object.fromEntries([...bodies, hidden].map(machine => [machine.id, machine])),
            machineListByServerId: { [serverId]: [...bodies, hidden], 'foreign-home': [foreign, createMachineFixture({ id: 'foreign-only' })] },
            machineListStatusByServerId: { [serverId]: 'idle', 'foreign-home': 'idle' },
            machineDisplayById: display,
        }));
        // The canonical publication owner rejects a different Account's same-id Machine.
        storage.getState().applyMachines([foreign], false, { sourceServerId: serverId, sourceAccountId: 'foreign-account' });
        const names = vi.spyOn(machineDisplayNames, 'resolveMachineDisplayNames');
        const fetches = vi.spyOn(globalThis, 'fetch');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            expect(storage.getState().machineDisplayById[machines[0]!.id]).toBe(display[machines[0]!.id]);
            screen = await renderScreen(<AccountDetailWorksOnSection />);
            expect(screen.getTextContent()).toContain('Build machine 0');
            expect(screen.getTextContent()).not.toContain('Foreign account builder');
            await screen.pressByTestIdAsync('account-detail-works-on:row');
            expect(screen.getTextContent()).toContain('Build box · build-1.local');
            expect(screen.getTextContent()).toContain('Build box · build-2.local');
            expect(screen.getTextContent()).toContain('ae10d3d5dc89');
            expect(screen.getTextContent()).toContain(machineDisplayNames.lockedMachineName());
            expect(screen.getTextContent()).not.toContain('Private locked builder');
            expect(names).toHaveBeenCalled();
            expect(names.mock.calls[0]?.[0].map(machine => machine.id)).toEqual(machines.map(machine => machine.id));
            names.mockClear();
            await act(async () => {
                for (let index = 0; index < 100; index++) storage.setState(state => ({ artifactsLoaded: index % 2 === 0,
                    machineDisplayById: { ...state.machineDisplayById, [hidden.id]: {
                        ...display[hidden.id]!, metadata: { ...display[hidden.id]!.metadata, displayName: `Hidden builder ${index}` },
                    } },
                }));
            });
            expect(names).not.toHaveBeenCalled();
            await act(async () => storage.setState(state => ({ machineDisplayById: { ...state.machineDisplayById,
                [machines[0]!.id]: { ...display[machines[0]!.id]!, metadata: { ...display[machines[0]!.id]!.metadata, displayName: 'Renamed builder' } },
            } })));
            expect(screen.getTextContent()).toContain('Renamed builder');
            expect(fetches).not.toHaveBeenCalled();
        } finally {
            await screen?.unmount(); names.mockRestore(); fetches.mockRestore(); storage.setState(previous);
        }
    });
    it('omits a presence dot for unknown machines while preserving a genuine offline dot', async () => {
        const scope = { serverId: 'home-a', accountId: 'detail-account' };
        const now = Date.now();
        const machines = [createMachineFixture({ id: 'unknown', activeAt: now }), createMachineFixture({ id: 'offline', active: false, activeAt: 0 })];
        withdrawMachinePresenceForScope(scope);
        captureMachinePresenceObservation(scope)(['offline']);
        try {
            const rows = projectAccountDetailMachines(machines, now, scope);
            expect(rows.find(row => row.id === 'unknown')).toMatchObject({ online: false, status: 'unknown' });
            const screen = await renderScreen(<AccountDetailWorksOnSectionView machines={rows} />);
            // P8 detail composition keeps Works on collapsed until the user opens its machine list.
            await screen.pressByTestIdAsync('account-detail-works-on:row');
            expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Offline' && typeof node.type === 'string')).toHaveLength(1);
            expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Online' && typeof node.type === 'string')).toHaveLength(0);
        } finally { clearMachineRequestReachabilityForTest(); }
    });
    it('retains unavailable inventory while showing executable supply first', () => {
        const now = Date.now();
        const failed = createMachineFixture({ id: 'failed', activeAt: now });
        const replaced = createMachineFixture({ id: 'replaced', activeAt: now, replacedByMachineId: 'replacement' });
        const ready = createMachineFixture({ id: 'ready', activeAt: now });
        const scope = { serverId: 'home-a', accountId: 'detail-account' };
        recordMachineRequestFailed({ ...scope, machineId: failed.id });
        try {
            expect(projectAccountDetailMachines([failed, replaced, ready], now, scope).map(row => ({ id: row.id, online: row.online })))
                .toEqual([{ id: 'ready', online: true }, { id: 'failed', online: false }, { id: 'replaced', online: false }]);
        } finally { clearMachineRequestReachabilityForTest(); }
    });
    it('tells same-named machines apart and lists the online ones first', () => {
        const now = 10_000_000;
        const rows = projectAccountDetailMachines([
            createMachineFixture({ id: 'aaaa1111', active: false, activeAt: 0, metadata: { ...createMachineFixture().metadata!, host: 'devbox', displayName: undefined } }),
            createMachineFixture({ id: 'bbbb2222', active: true, activeAt: now, metadata: { ...createMachineFixture().metadata!, host: 'devbox', displayName: undefined } }),
            createMachineFixture({ id: 'cccc3333', active: true, activeAt: now, metadata: { ...createMachineFixture().metadata!, host: 'studio', displayName: undefined } }),
        ], now, { serverId: 'home-a', accountId: 'detail-account' });
        expect(rows.map((row) => row.id)).toEqual(['bbbb2222', 'cccc3333', 'aaaa1111']);
        const devboxNames = rows.filter((row) => row.id !== 'cccc3333').map((row) => row.name);
        expect(new Set(devboxNames).size).toBe(2);
        expect(rows.find((row) => row.id === 'cccc3333')?.name).toBe('studio');
    });
});
