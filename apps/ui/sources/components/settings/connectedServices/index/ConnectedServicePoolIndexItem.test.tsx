import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createQualifiedQuotaTestHarness, quotaTestRef, quotaTestSnapshot } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { ConnectedServicePoolIndexItem } from './ConnectedServicePoolIndexItem';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

it('shows selected pool limits with their oldest reading time through the real quota hook', async () => {
    const fetchedAt = Date.now() - 120_000;
    const snapshot = { ...quotaTestSnapshot, fetchedAt, meters: [
        { meterId: 'session', label: 'Session', remainingPct: 0, status: 'ok' as const, unit: 'requests' as const, used: 100, limit: 100, utilizationPct: 100, resetsAt: Date.now() + 600_000, details: {} },
        { meterId: 'weekly', label: 'Weekly', remainingPct: 75, status: 'ok' as const, unit: 'requests' as const, used: 25, limit: 100, utilizationPct: 25, resetsAt: Date.now() + 600_000, details: {} },
    ] };
    const boundary = await createQualifiedQuotaTestHarness({ snapshot });
    const previousSettings = storage.getState().settings;
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        screen = await renderScreen(<InjectedAuthProvider credentials={boundary.account.credentials}>
            <ConnectedServicePoolIndexItem testID="pool" title="Work pool" subtitle="Claude" activeTitle="Work" activeSinceMs={null}
                activeAccountId="work" members={[{ accountId: 'work', title: 'Work', enabled: true, credentialStatus: 'connected' }]}
                quotaLimitSelection={{ mode: 'selected', providerLimitIds: ['weekly'] }}
                star={null} onOpen={() => {}} service={quotaTestRef.service} presentation="row" compact={false} />
        </InjectedAuthProvider>);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('75%');
        expect(screen.getTextContent()).not.toContain('Session');
        expect(screen.findAllByType(SurfaceAsOfLabel).map(node => node.props.at)).toContain(fetchedAt);
    } finally {
        await screen?.unmount();
        storage.getState().applySettingsLocal(previousSettings);
        await boundary.dispose();
    }
});

it('keeps one trailing thing on a list row and leaves the default star to the card and the pool page (R138)', async () => {
    const { ConnectedServicePoolIndexItemView } = await import('./ConnectedServicePoolIndexItem');
    const { Text } = await import('react-native');
    const onOpen = vi.fn();
    const entry = {
        testID: 'pool', title: 'Codex pool', subtitle: 'ChatGPT · 2 accounts', activeTitle: 'Leeroy', activeSinceMs: null,
        activeAccountId: 'leeroy', members: [{ accountId: 'leeroy', title: 'Leeroy', enabled: true, credentialStatus: 'connected' }],
        star: <Text testID="pool:star">★</Text>, onOpen,
        usage: { windows: [{ key: 'weekly', label: 'Weekly', remainingPct: 67, resetsAt: null, estimated: false }],
            memberByAccountId: { leeroy: { lowestRemainingPct: 67 } }, room: { reporting: 1, unreported: 0 } },
        compact: false, now: Date.now(),
    } as unknown as React.ComponentProps<typeof ConnectedServicePoolIndexItemView>;
    const row = await renderScreen(<ConnectedServicePoolIndexItemView {...entry} presentation="row" />);
    try {
        expect(row.findByTestId('pool:star')).toBeFalsy();
        expect(row.getTextContent()).toContain('Using Leeroy');
        await row.pressByTestIdAsync('pool');
        expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
        await row.unmount();
    }
    const card = await renderScreen(<ConnectedServicePoolIndexItemView {...entry} presentation="card" />);
    try {
        expect(card.findByTestId('pool:star')).toBeTruthy();
    } finally {
        await card.unmount();
    }
});
