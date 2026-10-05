import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-' + serverId })], true, { sourceServerId: serverId });
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
            targetLabel: 'localhost:52753',
            serverId: selectedHome.profile.id,
            serverName: 'localhost:52753',
            serverUrl: 'http://localhost:52753',
            showServerSetup: true,
        });
    });
});
