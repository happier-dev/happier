import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import {
    resolveServerProfileScopeId,
    setServerProfileIdentityForUrl,
    updateHomeViewState,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionGettingStartedGuidanceBaseModel } from './useSessionGettingStartedGuidanceBaseModel';
import { t } from '@/text';

const accountId = 'guidance-account';
const token = 'header.' + Buffer.from(JSON.stringify({ sub: accountId })).toString('base64') + '.signature';
let previousState: ReturnType<typeof storage.getState>;

async function activateHome(serverUrl: string, name: string, serverIdentityId?: string) {
    const created = await upsertAndActivateServer({ serverUrl, name });
    const profile = serverIdentityId
        ? await setServerProfileIdentityForUrl(serverUrl, serverIdentityId)
        : created;
    if (!profile) throw new Error('The Home identity fixture was not admitted');
    const serverId = resolveServerProfileScopeId(profile);
    expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token })).toBe(true);
    const binding = await resolveServerCredentialAccountScope(serverId);
    if (binding.kind !== 'bound') throw new Error('The Home credential fixture was not bound');
    expect(binding.scope.accountId).toBe(accountId);
    await updateHomeViewState(() => ({
        version: 1,
        groups: [],
        activeTargetKind: 'server',
        activeTargetId: serverId,
    }));
    storage.getState().activateProfileScope(binding.scope);
    storage.getState().applyProfileForScope(binding.scope, { ...profileDefaults, id: accountId });
    storage.getState().activateSessionLocalStateScope(binding.scope);
    // A retained census row is not live daemon presence; publish a current heartbeat.
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-' + serverId, activeAt: Date.now() })], true, { sourceServerId: serverId });
    storage.getState().applySessions([]);
    return { profile, serverId };
}

describe('useSessionGettingStartedGuidanceBaseModel', () => {
    beforeEach(async () => {
        previousState = storage.getState();
        storage.setState({
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            archivedSessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            machines: {},
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            isDataReady: true,
        });
        await activateHome('https://api.a.example', 'A');
    });

    afterEach(() => {
        standardCleanup();
        storage.getState().clearSessionLocalStateScope();
        storage.getState().clearProfileScope();
        storage.setState(previousState);
    });

    it.each(['signed_out', 'unavailable'] as const)('FX28 settles first-use %s through the credential boundary', async kind => {
        const read = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        if (kind === 'signed_out') read.mockResolvedValue(null);
        else read.mockRejectedValue(new Error('Synthetic secure-store read failure'));
        storage.setState({ sessionListIndexByServerId: {}, sessions: {}, isDataReady: false });
        try {
            const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
            try {
                await flushHookEffects();
                expect(hook.getCurrent()).toMatchObject({ kind: 'start_daemon' });
                expect(hook.getCurrent().unavailableServerIds).toHaveLength(1);
            } finally { await hook.unmount(); }
        } finally { read.mockRestore(); }
    });

    it('does not rerender for a Machine publication that changes no guidance fact', async () => {
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSessionGettingStartedGuidanceBaseModel(); });
        await flushHookEffects();
        const settled = hook.getCurrent();
        const rendersBefore = renders;
        const [machine] = storage.getState().machineListByServerId[settled.serverId] ?? [];
        if (!machine) throw new Error('The Machine fixture was not listed');
        // A daemon keeps republishing its loopback endpoint expiry; the row is new, the guidance answer is not.
        for (let i = 1; i <= 5; i += 1) {
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, daemonState: { ...(machine.daemonState as object), peerMediation: { loopback: { endpoint: { expiresAt: Date.now() + i } } } } }], false, { sourceServerId: settled.serverId });
            });
        }
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(settled);
        expect(renders - rendersBefore).toBe(0);
        await hook.unmount();
    });

    it('rerenders once a Machine publication changes the guidance answer', async () => {
        const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
        await flushHookEffects();
        const settled = hook.getCurrent();
        const [machine] = storage.getState().machineListByServerId[settled.serverId] ?? [];
        if (!machine) throw new Error('The Machine fixture was not listed');
        await act(async () => {
            storage.getState().applyMachines([], true, { sourceServerId: settled.serverId });
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ kind: 'connect_machine' });
        await hook.unmount();
    });

    it('keeps guidance available when an unavailable Home retains known online machines', async () => {
        const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
        await flushHookEffects();
        const initialModel = hook.getCurrent();
        expect(initialModel).toMatchObject({
            kind: 'create_session',
            targetLabel: 'A',
            serverUrl: 'https://api.a.example',
            unavailableServerIds: [],
        });

        await act(async () => {
            storage.getState().markMachineListUnavailable(initialModel.serverId);
        });

        expect(hook.getCurrent()).toEqual(initialModel);
    });

    it('refreshes guidance when a newly saved Home becomes the selected Home', async () => {
        const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ targetLabel: 'A', serverUrl: 'https://api.a.example' });

        let selectedHome: Awaited<ReturnType<typeof activateHome>> | undefined;
        await act(async () => {
            selectedHome = await activateHome('https://api.renamed.example', 'Renamed');
        });
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual({
            kind: 'create_session',
            unavailableServerIds: [],
            targetLabel: 'Renamed',
            serverId: selectedHome?.profile.id,
            serverName: 'Renamed',
            serverUrl: 'https://api.renamed.example',
            showServerSetup: true,
        });
    });

    it('resolves active server profile and machine inventory by server identity id', async () => {
        await upsertServerProfile({ serverUrl: 'http://localhost:18830', name: 'localhost:18830' });
        const selectedHome = await activateHome('http://localhost:52753', 'localhost:52753', 'srv_local_relay');
        expect(selectedHome.serverId).toBe('srv_local_relay');

        const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual({
            kind: 'create_session',
            unavailableServerIds: [],
            targetLabel: t('settingsAccount.thisHomeTitle'),
            serverId: selectedHome.profile.id,
            serverName: t('settingsAccount.thisHomeTitle'),
            serverUrl: 'http://localhost:52753',
            showServerSetup: true,
        });
    });
});
