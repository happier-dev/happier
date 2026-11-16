import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useSessionMachineReachability } = await import('@/components/sessions/model/useSessionMachineReachability');
const { useSessionViewBootstrap } = await import('./useSessionViewBootstrap');

const previous = getStorage().getState();
beforeEach(async () => { await home.reset(); });
afterEach(async () => { standardCleanup(); await home.reset(); getStorage().setState(previous, true); });

describe('Session bootstrap reachability', () => {
    it('reads the stopped Session Machine from its supplied Home while another Home is focused', async () => {
        const serverId = await home.addHome({ name: 'Session Home', serverUrl: 'https://bootstrap-session.test', accountId: 'session-account' });
        const machine = createMachineFixture({ id: 'source-machine', activeAt: Date.now() });
        const session = createSessionFixture({ id: 'stopped-session', serverId, active: false,
            metadata: { machineId: machine.id, path: '/repo', host: 'session-host' } });
        getStorage().getState().applySessions([session]);
        getStorage().getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: 'session-account' });
        getStorage().getState().markMachineListSettled(serverId);
        await home.addHome({ name: 'Focused Home', serverUrl: 'https://bootstrap-focused.test', accountId: 'focused-account' });
        getStorage().getState().applyServerScopedSessionListRows(serverId, [createSessionListRenderableSessionFixture(session)], {
            source: 'rowOnly', mode: 'append',
        });
        await publishMachineInventoryForTest({ serverId, accountId: 'session-account' }, [machine]);

        // The real presence owner is the fixture control; bootstrap must consume that same Home.
        const presence = await renderHook(() => useSessionMachineReachability(session.id, serverId));
        await waitForHomeGovernance(() => expect(presence.getCurrent().machineReachability).toBe('reachable'));
        const bootstrap = await renderHook(() => useSessionViewBootstrap({
            sessionId: session.id, serverId, paneScopeId: 'bootstrap-source',
            sessionPath: null, sessionAccepted: false,
        }), { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> });
        expect(bootstrap.getCurrent()).toMatchObject({ machineReachable: true, machineReachability: 'reachable' });
        await bootstrap.unmount();
        await presence.unmount();
    });
});
