import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { renderScreen } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { MachineOfflineAlertRow } = await import('@/components/machines/vitals/MachineAlertsPage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useMachineOfflineAlert } = await import('./useMachineOfflineAlert');
const before = storage.getState();
afterEach(async () => { standardCleanup(); storage.setState(before); await home.reset(); });

it.each([
    { final: false, rejectFollowup: false, writes: 2, stored: false, switchTarget: false },
    { final: true, rejectFollowup: false, writes: 1, stored: true, switchTarget: false },
    { final: false, rejectFollowup: true, writes: 2, stored: true, switchTarget: false },
    { final: false, rejectFollowup: false, writes: 2, stored: false, switchTarget: true },
])('settles rapid offline-alert choices at the latest intent ($final, failure $rejectFollowup, target switch $switchTarget)', async test => {
    const serverId = await home.addHome({ name: 'Latest offline', serverUrl: 'https://latest-offline.test',
        serverIdentityId: 'srv_latest_offline', accountId: 'owner', currentAccount: true });
    let raw: Record<string, unknown> = { machineOfflineAlertsV1: { machineIds: test.switchTarget ? ['peer', 'second'] : ['peer'] } };
    let version = 1;
    let writes = 0;
    const held = createDeferred<void>();
    home.answer(serverId, '/v2/account/settings', { async select(input) {
        if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
        const write = AccountSettingsV2UpdateRequestSchema.parse(input);
        writes++;
        if (writes === 1) await held.promise;
        if (writes === 2 && test.rejectFollowup) return { status: 403, body: { error: 'forbidden' } };
        expect(write.expectedVersion).toBe(version);
        if (write.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        raw = write.content.v;
        return { body: { success: true, version: ++version } };
    } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ settingsScope: scope, profileScope: scope, settings: settingsParse(raw) });
    const row = (machineId: string) => <ItemList><MachineOfflineAlertRow serverId={serverId}
        machine={{ id: machineId }} machineName="edge-1" /></ItemList>;
    const screen = await renderScreen(row('machine'));
    const control = () => screen.findByTestId('machine-alerts-offline-switch')!;
    act(() => control().props.onValueChange(true));
    await vi.waitFor(() => expect(writes).toBe(1));
    if (test.switchTarget) await screen.update(row('second'));
    try {
        expect(control().props.disabled).not.toBe(true);
        act(() => {
            for (const value of [false, true, false, test.final]) control().props.onValueChange(value);
        });
        expect(control().props.value).toBe(test.final);
        expect(writes).toBe(1);
    } finally {
        await act(async () => { held.resolve(); });
    }
    const expectedIds = test.switchTarget || test.stored ? ['peer', 'machine'] : ['peer'];
    await vi.waitFor(() => expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: expectedIds }));
    await vi.waitFor(() => expect(writes).toBe(test.writes));
    await vi.waitFor(() => expect(control().props.value).toBe(test.stored));
    if (test.rejectFollowup) expect(screen.getTextContent()).toContain('save');
    await screen.unmount();
});

it('keeps a new Account choice separate from the previous Account pending save on the same Machine', async () => {
    const serverId = await home.addHome({ name: 'Rotating offline', serverUrl: 'https://rotating-offline.test',
        serverIdentityId: 'srv_rotating_offline', accountId: 'owner', currentAccount: true });
    const held = createDeferred<void>();
    let oldWrites = 0;
    let newWrites = 0;
    let oldRaw: Record<string, unknown> = { machineOfflineAlertsV1: { machineIds: ['peer'] } };
    let newRaw: Record<string, unknown> = { machineOfflineAlertsV1: { machineIds: ['other-peer'] } };
    home.answer(serverId, '/v2/account/settings', { async select(input) {
        if (input === undefined || input === null) return { body: { content: { t: 'plain', v: oldRaw }, version: 1 } };
        const write = AccountSettingsV2UpdateRequestSchema.parse(input);
        oldWrites++;
        await held.promise;
        if (write.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        oldRaw = write.content.v;
        return { body: { success: true, version: 2 } };
    } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ settingsScope: scope, profileScope: scope, settings: settingsParse(oldRaw) });
    const screen = await renderScreen(<ItemList><MachineOfflineAlertRow serverId={serverId}
        machine={{ id: 'machine' }} machineName="edge-1" /></ItemList>);
    const control = () => screen.findByTestId('machine-alerts-offline-switch')!;
    act(() => control().props.onValueChange(true));
    await vi.waitFor(() => expect(oldWrites).toBe(1));
    home.answer(serverId, '/v2/account/settings', { select(input) {
        if (input === undefined || input === null) return { body: { content: { t: 'plain', v: newRaw }, version: 1 } };
        const write = AccountSettingsV2UpdateRequestSchema.parse(input);
        newWrites++;
        if (write.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        newRaw = write.content.v;
        return { body: { success: true, version: 2 } };
    } });
    try {
        await act(async () => {
            await home.switchAccount(serverId, 'other', { currentAccount: true });
            const nextScope = { ...scope, accountId: 'other' };
            storage.setState({ settingsScope: nextScope, profileScope: nextScope, settings: settingsParse(newRaw) });
        });
        expect(control().props.value).toBe(false);
        act(() => control().props.onValueChange(true));
    } finally {
        await act(async () => { held.resolve(); });
    }
    await vi.waitFor(() => expect(newWrites).toBe(1));
    await vi.waitFor(() => expect(newRaw.machineOfflineAlertsV1).toEqual({ machineIds: ['other-peer', 'machine'] }));
    expect(oldRaw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer', 'machine'] });
    expect(control().props.value).toBe(true);
    await screen.unmount();
});

it('persists keyed offline consent through the real Account Action, preserving other machines', async () => {
    const serverId = await home.addHome({ name: 'Offline', serverUrl: 'https://offline.test', serverIdentityId: 'srv_offline', accountId: 'owner', currentAccount: true });
    let raw: Record<string, unknown> = { machineOfflineAlertsV1: { machineIds: ['peer'] } };
    let version = 1;
    home.answer(serverId, '/v2/account/settings', { select(input) {
        if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
        const write = AccountSettingsV2UpdateRequestSchema.parse(input);
        expect(write.expectedVersion).toBe(version);
        if (write.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        raw = write.content.v;
        version += 1;
        return { body: { success: true, version } };
    } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ settingsScope: scope, profileScope: scope, settings: settingsParse(raw) });
    // Collect the actual Action ingress too, so an unavailable native boundary cannot be hidden by the hook's failure result.
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('settings.get', { anchor: 'notifications.machineOffline', key: 'machine' },
        { surface: 'ui', serverId: scope.serverId, expectedAccountId: 'owner' })).toMatchObject({ ok: true, result: { value: false } });
    const hook = await renderHook(() => useMachineOfflineAlert({ serverId, machineId: 'machine' }));
    let saved: Awaited<ReturnType<ReturnType<typeof useMachineOfflineAlert>['set']>> | undefined;
    await act(async () => { saved = await hook.getCurrent().set(true); });
    expect(saved, JSON.stringify({ saved, paths: home.requests.map(request => request.path) })).toMatchObject({ saved: true, enabled: true });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer', 'machine'] });
    await act(async () => { saved = await hook.getCurrent().set(false); });
    expect(saved).toMatchObject({ saved: true, enabled: false });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer'] });
    home.answer(serverId, 'POST /v2/account/settings', { status: 403, body: { error: 'forbidden' } });
    await act(async () => { saved = await hook.getCurrent().set(true); });
    expect(saved).toMatchObject({ saved: false, enabled: false });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer'] });
    await hook.unmount();
});
