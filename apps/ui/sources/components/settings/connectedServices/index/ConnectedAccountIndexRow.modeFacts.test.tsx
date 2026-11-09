import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
    createQualifiedQuotaTestHarness,
    quotaTestProviderUsageResponse,
    quotaTestProviderUsageSnapshot,
    quotaTestResponse,
    quotaTestSnapshot,
} from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { storage } from '@/sync/domains/state/storageStore';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';

import { ConnectedAccountIndexLiveFacts, ConnectedAccountIndexStatusLines, type ConnectedAccountIndexFacts } from './ConnectedAccountIndexRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

it.each([true, false])('projects observed subscription facts with explicit API-key mode=%s', async billedPerUse => {
    const now = Date.now();
    const snapshot = { ...quotaTestSnapshot, fetchedAt: now };
    const boundary = await createQualifiedQuotaTestHarness({ snapshot });
    const subscription = { status: 'subscribed', renewal: 'on', observedAtMs: now,
        staleAfterMs: 60_000, currentPeriodEndAtMs: now + 86_400_000 } as const;
    boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse({
        ...quotaTestProviderUsageSnapshot(now), subscription,
    })));
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    const recordId = quotaTestResponse(snapshot).sourceResolution?.recordId;
    if (!recordId) throw new Error('Quota fixture omitted its usage record');
    const recordIds = [recordId];
    let observedSubscription: unknown;
    let facts: ConnectedAccountIndexFacts | undefined;
    function Probe() {
        // Observe the real usage owner reaching loaded subscription data before
        // checking that explicit key mode withholds that stale presentation.
        const usage = useProviderAccountUsageSnapshots(recordIds);
        observedSubscription = usage.snapshotsByRecordId[recordId]?.subscription;
        return <ConnectedAccountIndexLiveFacts identity={{ kind: 'qualified', account: snapshot.ref }}
            status="connected" billedPerUse={billedPerUse} showsUsage signedOut={false}
            render={next => {
                facts = next;
                return <ConnectedAccountIndexStatusLines testID="mode-account" facts={next} now={now} />;
            }} />;
    }
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        screen = await renderScreen(<InjectedAuthProvider credentials={boundary.account.credentials}><Probe /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(observedSubscription).toMatchObject(subscription));
        await vi.waitFor(() => expect(facts?.fetchedAt).toBe(now));
        await flushHookEffects();
        if (billedPerUse) expect(facts?.subscription).toBeNull();
        else expect(facts?.subscription).toMatchObject(subscription);
        expect(facts?.planLabel).toBe(billedPerUse ? null : snapshot.planLabel);
        expect(facts?.usage.kind).toBe(billedPerUse ? 'noLimits' : 'none');
        expect(screen.findByTestId('mode-account:subscription') !== null).toBe(!billedPerUse);
    } finally {
        await screen?.unmount();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary.dispose();
    }
});
