import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { recordMachineRequestSucceeded, recordMachineRequestFailed, clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
const { projectSessionSummaryCard } = await import('./sessionSummaryProjection');
const { storage } = await import('@/sync/domains/state/storage');
const { SessionSummaryCard } = await import('./SessionSummaryCard');
const { t } = await import('@/text');
afterEach(async () => { clearMachineRequestReachabilityForTest(); standardCleanup(); await home.reset(); });

it('keeps Session freshness separate from machine reachability and reacts to the canonical request verdict', async () => {
    const serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://summary-presence.test', accountId: 'account-a' });
    const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() });
    const base = createSessionFixture();
    const session = createSessionFixture({ id: 'session-a', serverId, active: false, activeAt: 1, presence: 1,
        metadata: { ...base.metadata!, machineId: machine.id, path: '/repo', host: 'Build computer' } });
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    storage.getState().applySessions([session]);
    const model = projectSessionSummaryCard({ awareness: projectUiSessionAwareness(session, Date.now()),
        agentLabel: null, activity: null, openApprovalCount: 0, scm: null, usage: null });
    expect(model.stale).toBe(true);
    expect(model.status?.state).toBe('disconnected');
    const render = () => <SessionSummaryCard model={model} session={session} serverId={serverId}
        density="compact" machineName="Build computer" />;
    const screen = await renderScreen(render());
    expect(screen.getTextContent()).not.toContain(t('sessionCompanion.freshness.machineOffline', { machine: 'Build computer' }));
    expect(screen.getTextContent()).toContain(t('sessionCompanion.freshness.sessionDisconnected'));
    await act(async () => { recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id }); });
    expect(screen.getTextContent()).toContain(t('sessionCompanion.freshness.machineOffline', { machine: 'Build computer' }));
    await act(async () => { recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: machine.id }); });
    expect(screen.getTextContent()).not.toContain(t('sessionCompanion.freshness.machineOffline', { machine: 'Build computer' }));
    expect(screen.getTextContent()).toContain(t('sessionCompanion.freshness.sessionDisconnected'));
});
