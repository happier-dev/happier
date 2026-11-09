import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { QualifiedConnectedAccountServiceRefSchema, QualifiedConnectedAccountGroupRefSchema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountGroupRequestsV4';
import { QualifiedConnectedAccountGroupMemberMutationV4Schema, type QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import type { UseQualifiedConnectedAccountGroupsResult } from './useQualifiedConnectedAccountGroups';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installConnectedServicesCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
});
const authState = vi.hoisted(() => ({ credentials: null as AuthCredentials | null }));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => authState }));
// Pool hooks render no Markdown; this is an unavailable third-party export boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in pool hook'); },
}));

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({});
function listPathFor(identity: typeof service) {
    return '/v4/connect/qualified/groups?service=' + encodeURIComponent(
        encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, identity));
}
const listPath = listPathFor(service);

function wireGroup(groupId = 'group-a'): QualifiedConnectedAccountGroupV4 {
    return { v: 1 as const, ref: { service, groupId }, displayName: groupId, policy, activeConnectedAccountId: null as string | null,
        incarnation: 'group-row:' + groupId, generation: 1, runtimeStateRevision: 1, state: {}, members: [], createdAt: 0, updatedAt: 0 };
}
type PoolWire = ReturnType<typeof wireGroup>;
const deletePath = buildQualifiedConnectedAccountGroupMutationRequestV4('delete', {
    group: wireGroup().ref, expectedIncarnation: wireGroup().incarnation, expectedGeneration: 1, expectedRuntimeStateRevision: 1,
}).path;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    standardCleanup();
    await cleanup?.();
    cleanup = undefined;
    authState.credentials = null;
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

async function poolHome() {
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restoreLoader = await installRealActionExecutorModuleLoader();
    const serverUrl = 'https://pool-hook-races.test';
    const serverId = await home.addHome({ name: 'Pool races', serverUrl, accountId: 'pool-race-owner', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } },
    } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    authState.credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    cleanup = async () => { restoreLoader(); await home.reset(); };
    home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    let groups: PoolWire[] = [wireGroup()];
    home.answer(serverId, listPath, { select: () => ({ body: { groups } }) });
    const encodedGroup = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, wireGroup().ref));
    home.answer(serverId, '/v4/connect/qualified/group?group=' + encodedGroup, { select: () => groups.length
        ? { body: { group: groups[0] } } : { status: 404, body: { error: 'connect_group_not_found' } } });
    home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } });
    for (const key of ['presentation', 'acknowledgements']) home.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/' + key, {
        body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } },
    });
    const { useQualifiedConnectedAccountGroups } = await import('./useQualifiedConnectedAccountGroups');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId, accountId: 'pool-race-owner' };
    storage.getState().activateProfileScope(scope);
    const publishGroups = (next: PoolWire[]) => {
        groups = next;
        storage.getState().applyProfileForScope(scope, { ...profileDefaults, id: scope.accountId, connectedAccountGroupsV4: next });
    };
    publishGroups(groups);
    return { home, serverId, TokenStorage, useQualifiedConnectedAccountGroups, publishGroups,
        groups: () => groups, setGroups: publishGroups };
}

async function mountedPools(fixture: Awaited<ReturnType<typeof poolHome>>) {
    const hook = await renderHook(() => fixture.useQualifiedConnectedAccountGroups({ serverId: fixture.serverId, service }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().groups).toHaveLength(1));
    await waitForHomeGovernance(() => expect(hook.getCurrent().execution?.ready).toBe(true));
    return hook;
}

describe('useQualifiedConnectedAccountGroups', () => {
    it('shows a remote profile push in an open pool without a private group list read', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const remote: PoolWire = { ...wireGroup(), displayName: 'Remote pool', generation: 2, runtimeStateRevision: 3,
            activeConnectedAccountId: 'remote-account', state: { activeSince: { accountId: 'remote-account', atMs: 400 } },
            members: [{ v: 1, connectedAccountId: 'remote-account', priority: 7, enabled: true,
                state: {}, createdAt: 1, updatedAt: 2 }] };
        await act(async () => { fixture.publishGroups([remote]); });
        expect(hook.getCurrent().groups[0]).toMatchObject({ displayName: 'Remote pool',
            revision: { generation: 2, runtimeStateRevision: 3 }, activeAccountId: 'remote-account',
            activeSince: { accountId: 'remote-account', atMs: 400 },
            members: [{ ref: { service, accountId: 'remote-account' }, priority: 7, enabled: true }],
        });
        expect(fixture.home.requestsFor(listPath)).toEqual([]);
        await act(async () => { fixture.publishGroups([]); });
        expect(hook.getCurrent().groups).toEqual([]);
    });

    it('threads acknowledged create and member revisions through one draft submit before React commits another render', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const created = wireGroup('draft-pool');
        fixture.home.answer(fixture.serverId, 'POST /v4/connect/qualified/groups', { select: () => {
            fixture.setGroups([...fixture.groups(), created]);
            return { body: { group: created } };
        } });
        fixture.home.answer(fixture.serverId, 'POST /v4/connect/qualified/group/members', { select: input => {
            const mutation = QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(input);
            const current = fixture.groups().find(group => group.ref.groupId === mutation.group.groupId)!;
            expect(mutation.expectedGeneration).toBe(current.generation);
            const next = { ...current, generation: current.generation + 1, members: [...current.members, {
                v: 1 as const, connectedAccountId: mutation.connectedAccountId, priority: mutation.priority ?? 100,
                enabled: true, state: {}, createdAt: 0, updatedAt: 0,
            }] };
            fixture.setGroups(fixture.groups().map(group => group.ref.groupId === next.ref.groupId ? next : group));
            return { body: { group: next } };
        } });
        const draft = hook.getCurrent();
        await act(async () => {
            let current = await draft.create({ groupId: created.ref.groupId, displayName: 'Draft pool' });
            expect(current).not.toBeNull();
            for (const accountId of ['account-a', 'account-b']) {
                current = await draft.addMember({ group: current!, account: { service, accountId } });
                expect(fixture.groups().find(group => group.ref.groupId === created.ref.groupId)?.members.map(member => member.connectedAccountId))
                    .toContain(accountId);
                expect(current, `acknowledged ${accountId}`).not.toBeNull();
            }
        });
        expect(fixture.groups().find(group => group.ref.groupId === created.ref.groupId)?.members.map(member => member.connectedAccountId))
            .toEqual(['account-a', 'account-b']);
        expect(hook.getCurrent().groups.find(group => group.ref.groupId === created.ref.groupId)?.revision.generation).toBe(3);
        await hook.unmount();
    });
    it('loads Account pools without a machine description', async () => {
        const fixture = await poolHome();
        const hook = await renderHook(() => fixture.useQualifiedConnectedAccountGroups({ serverId: fixture.serverId, service }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'loaded', groups: [expect.objectContaining({ ref: wireGroup().ref })] }));
        await hook.unmount();
    });
    it.each(['absent', 'current', 'recreated'] as const)('returns the create CAS receipt without replacing a concurrent %s profile push', async (listed) => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const response = createDeferred<void>();
        const created = wireGroup('new-pool');
        fixture.home.answer(fixture.serverId, 'POST /v4/connect/qualified/groups', { respondAfter: response.promise,
            body: { group: created } });
        let pending: Promise<QualifiedConnectedAccountUiGroup | null> | undefined;
        await act(async () => { pending = hook.getCurrent().create({ groupId: created.ref.groupId, displayName: 'New pool' }); });
        await waitForHomeGovernance(() => expect(fixture.home.requestsFor('/v4/connect/qualified/groups').some(request => request.input !== null)).toBe(true));
        const current = { ...created, generation: 2, incarnation: listed === 'recreated' ? 'replacement-row' : created.incarnation };
        await act(async () => {
            if (listed !== 'absent') fixture.publishGroups([...fixture.groups(), current]);
        });
        await act(async () => {
            response.resolve();
            expect(await pending).toMatchObject({ ref: created.ref, revision: { generation: 1, incarnation: created.incarnation } });
        });
        expect(hook.getCurrent().groups.some(group => group.ref.groupId === created.ref.groupId)).toBe(listed !== 'absent');
        if (listed === 'recreated') expect(hook.getCurrent().groups.find(group => group.ref.groupId === created.ref.groupId)?.revision.incarnation).toBe('replacement-row');
        await hook.unmount();
    });
    it('does not expose service A groups while a changed server/service/auth basis loads or fails', async () => {
        const fixture = await poolHome();
        const hook = await renderHook((params: { serverId: string; service: typeof service }) => fixture.useQualifiedConnectedAccountGroups(params), {
            initialProps: { serverId: fixture.serverId, service },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().groups).toHaveLength(1));
        const otherService = { pluginId: 'acme.accounts', localId: 'b' };
        const serverUrl = 'https://pool-hook-other.test';
        const otherId = await fixture.home.addHome({ name: 'Other', serverUrl, accountId: 'other-owner', currentAccount: true });
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } },
        } });
        fixture.home.answer(otherId, '/v1/features', { body: features });
        fixture.home.answer(otherId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: otherId, snapshot: { status: 'ready', features } });
        authState.credentials = await fixture.TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: otherId });
        const changed = await hook.rerender({ serverId: otherId, service: otherService });
        expect(changed.groups).toEqual([]);
        expect(changed.source).toEqual({ protocol: 'v4' });
        expect(changed.status).toBe('loading');
        // A retained prior-Account profile never becomes this new reader's data.
        await act(async () => { fixture.publishGroups([wireGroup()]); });
        expect(hook.getCurrent().groups).toEqual([]);
        expect(fixture.home.requestsFor(listPathFor(otherService))).toEqual([]);
        await hook.unmount();
    });

    it('does not select the removed V3 group client on a Home without qualified Account support', async () => {
        const fixture = await poolHome();
        const features = createRootLayoutFeaturesResponse();
        delete features.capabilities.connectedServices.qualifiedAccounts;
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: fixture.serverId, snapshot: { status: 'ready', features } });
        fixture.home.answer(fixture.serverId, '/v1/features', { body: features });
        const hook = await renderHook(() => fixture.useQualifiedConnectedAccountGroups({ serverId: fixture.serverId, service }));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ status: 'unsupported', source: null, groups: [] });
        expect(fixture.home.requestsFor(listPath)).toEqual([]);
        await hook.unmount();
    });

    it('keeps the loaded pools visible while a refresh is in flight', async () => {
        const fixture = await poolHome();
        const { configureConnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        fixture.home.answer(fixture.serverId, 'GET /v1/account/profile', { select: () => ({ body: {
            ...profileDefaults, id: 'pool-race-owner', connectedAccountGroupsV4: fixture.groups(),
        } }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://pool-hook-races.test',
            credentials: authState.credentials!, request: fixture.home.request, configureSocket: configureConnectedServerSocketBoundary });
        const hook = await mountedPools(fixture);
        const groups = hook.getCurrent().groups;
        const pending = createDeferred<void>();
        fixture.home.answer(fixture.serverId, 'GET /v1/account/profile', { respondAfter: pending.promise, body: {
            ...profileDefaults, id: 'pool-race-owner', connectedAccountGroupsV4: fixture.groups(),
        } });
        let refreshed: Promise<void> | undefined;
        await act(async () => { refreshed = hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', groups });
        await act(async () => { pending.resolve(); await refreshed; });
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', groups });
        expect(fixture.home.requestsFor(listPath)).toEqual([]);
        await hook.unmount();
        await connection.dispose();
    });

    it('does not let a late pool mutation replace a newer list revision', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const original = hook.getCurrent().groups[0]!;
        const newer = { ...wireGroup(), displayName: 'Current pool', generation: 3, runtimeStateRevision: 2 };
        const olderResult = { ...wireGroup(), displayName: 'Older pool name', generation: 2 };
        const mutation = createDeferred<void>();
        fixture.home.answer(fixture.serverId, 'PATCH /v4/connect/qualified/group', { respondAfter: mutation.promise, body: { group: olderResult } });
        let pending: Promise<QualifiedConnectedAccountUiGroup | null> | undefined;
        await act(async () => { pending = hook.getCurrent().patch({ group: original, displayName: olderResult.displayName }); });
        await waitForHomeGovernance(() => expect(fixture.home.requestsFor('/v4/connect/qualified/group').some(request => request.input !== null)).toBe(true));
        await act(async () => { fixture.publishGroups([newer]); });
        expect(hook.getCurrent().groups[0]?.displayName).toBe('Current pool');
        await act(async () => { mutation.resolve(); expect(await pending).toMatchObject({ revision: { generation: 2 } }); });
        expect(hook.getCurrent().groups[0]).toMatchObject({ displayName: 'Current pool', revision: { generation: 3, runtimeStateRevision: 2 } });
        await hook.unmount();
    });

    it('does not let a late delete acknowledgement remove a recreated pool', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const original = hook.getCurrent().groups[0]!;
        const recreated = { ...wireGroup(), displayName: 'Recreated pool', incarnation: 'recreated-group-row' };
        const deletion = createDeferred<void>();
        fixture.home.answer(fixture.serverId, 'DELETE ' + deletePath, { respondAfter: deletion.promise, body: { success: true } });
        let pending: ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']> | undefined;
        await act(async () => { pending = hook.getCurrent().delete(original); });
        await waitForHomeGovernance(() => expect(fixture.home.requestsFor(deletePath)).toHaveLength(1));
        await act(async () => { fixture.publishGroups([recreated]); });
        await act(async () => { deletion.resolve(); expect(await pending).toMatchObject({ applied: true }); });
        expect(hook.getCurrent().groups[0]).toMatchObject({ displayName: 'Recreated pool', revision: { incarnation: 'recreated-group-row' } });
        await hook.unmount();
    });

    it('accepts deletion when a same-Account refresh already confirms the pool is absent', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const original = hook.getCurrent().groups[0]!;
        const deletion = createDeferred<void>();
        fixture.home.answer(fixture.serverId, 'DELETE ' + deletePath, { respondAfter: deletion.promise, body: { success: true } });
        let pending: ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']> | undefined;
        await act(async () => { pending = hook.getCurrent().delete(original); });
        await waitForHomeGovernance(() => expect(fixture.home.requestsFor(deletePath)).toHaveLength(1));
        await act(async () => { fixture.publishGroups([]); });
        await act(async () => { deletion.resolve(); expect(await pending).toMatchObject({ applied: true }); });
        expect(hook.getCurrent().groups).toEqual([]);
        await hook.unmount();
    });

    it('does not let a late active-account result replace a newer pool revision', async () => {
        const fixture = await poolHome();
        const hook = await mountedPools(fixture);
        const original = hook.getCurrent().groups[0]!;
        const newer = { ...wireGroup(), activeConnectedAccountId: 'account-b', generation: 3, runtimeStateRevision: 2 };
        const switched = createDeferred<void>();
        fixture.home.answer(fixture.serverId, 'POST /v4/connect/qualified/group/active-account', { respondAfter: switched.promise,
            body: { group: { ...wireGroup(), activeConnectedAccountId: 'account-a', generation: 2 } } });
        let pending: Promise<QualifiedConnectedAccountUiGroup | null> | undefined;
        await act(async () => { pending = hook.getCurrent().setActiveAccount({ group: original, account: { service, accountId: 'account-a' } }); });
        await waitForHomeGovernance(() => expect(fixture.home.requestsFor('/v4/connect/qualified/group/active-account').some(request => request.input !== null)).toBe(true));
        await act(async () => { fixture.publishGroups([newer]); });
        await act(async () => { switched.resolve(); expect(await pending).toMatchObject({ revision: { generation: 3 } }); });
        expect(hook.getCurrent().groups[0]).toMatchObject({ activeAccountId: 'account-b', revision: { generation: 3, runtimeStateRevision: 2 } });
        await hook.unmount();
    });
});
