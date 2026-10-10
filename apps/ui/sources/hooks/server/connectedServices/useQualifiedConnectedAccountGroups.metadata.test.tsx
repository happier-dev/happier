import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountGroupRequestsV4';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resolveConnectedServiceCollapseKey } from '@/sync/domains/connectedServices/resolveConnectedServiceCollapseKey';
import type { UseQualifiedConnectedAccountGroupsResult } from './useQualifiedConnectedAccountGroups';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

const navigationBoundary = vi.hoisted(() => ({ events: [] as string[], onPending: null as (() => Promise<void>) | null }));
installConnectedServicesCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        confirmResult: true,
        spies: {
            alert: () => { navigationBoundary.events.push('pending'); },
            alertAsync: async () => { navigationBoundary.events.push('pending'); await navigationBoundary.onPending?.(); },
        },
    }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        router: { canGoBack: () => false, replace: () => { navigationBoundary.events.push('navigate'); } },
    }).module,
});
const auth = vi.hoisted(() => ({ credentials: null as AuthCredentials | null }));
// The UI's authenticated bearer is the same genuine device credential admitted by the Home harness.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => auth }));
afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('pool deletion through its shared Action owner', () => {
    it('holds a mounted Agent pool-adoption acknowledgement at Action approval without writing metadata', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Pool adoption', serverUrl: 'https://pool-adoption-admission.test',
            accountId: 'adoption-owner', currentAccount: true });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const group = { v: 1, ref: { service, groupId: 'work' }, displayName: 'Work', incarnation: 'work:1', generation: 2,
            runtimeStateRevision: 3, policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'least_limited',
                autoSwitch: true, switchOn: { usageLimit: true, authExpired: true, accountChanged: false, refreshFailure: false } }),
            activeConnectedAccountId: null, state: {}, members: [], createdAt: 0, updatedAt: 0 };
        home.answer(serverId, 'GET /v1/account/profile', { body: { ...profileDefaults, id: 'adoption-owner', connectedAccountGroupsV4: [group] } });
        const emptyMetadata = { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } };
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/presentation', { body: emptyMetadata });
        home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: emptyMetadata });
        home.answer(serverId, `POST ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: { status: 'updated', revision: 2, cursor: 2 } });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } });
        await home.requireUiApproval(serverId, 'connectedServices.acknowledgements.set');
        const { ConnectedServicesAgentSignInView } = await import('@/components/settings/connectedServices/collection/ConnectedServicesAgentSignInView');
        const { ConnectedServicesDefaultAuthRow } = await import('@/components/settings/connectedServices/ConnectedServicesDefaultAuthRow');
        const screen = await renderScreen(<ConnectedServicesAgentSignInView />);
        try {
            await waitForHomeGovernance(() => expect(screen.findAllByType(ConnectedServicesDefaultAuthRow).length).toBeGreaterThan(0));
            const row = screen.findAllByType(ConnectedServicesDefaultAuthRow)[0];
            // Exercise the real collection's dismissal callback, exposed to its mounted presentation row.
            const dismiss = row!.props.onDismissPoolAdoptionSuggestion as NonNullable<React.ComponentProps<typeof ConnectedServicesDefaultAuthRow>['onDismissPoolAdoptionSuggestion']>;
            await act(async () => {
                expect(await dismiss({ kind: 'adoption', agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
                    service, groupId: 'work' })).toBe(false);
            });
            expect(home.requestsFor(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1).filter(request => request.input !== null)).toEqual([]);
            expect(home.requestsFor('/v1/artifacts').some(request => request.input !== null)).toBe(true);
        } finally { await screen.unmount(); await home.reset(); }
    });
    it('holds a mounted Agent own-login default at Action approval without writing the purpose catalog', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Purpose default', serverUrl: 'https://purpose-default-admission.test',
            accountId: 'purpose-owner', currentAccount: true });
        const path = '/v1/account/entity-rows/connected-accounts/purposes';
        home.answer(serverId, `GET ${path}`, { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } });
        await home.requireUiApproval(serverId, 'connectedServices.accounts.purposeDefault.set');
        const { useConnectedAccountPurposeDefaults } = await import('./useConnectedAccountPurposeDefaults');
        const hook = await renderHook(() => useConnectedAccountPurposeDefaults());
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().catalog.status).toBe('ready'));
            await act(async () => {
                await expect(hook.getCurrent().mutateDefaults({ kind: 'service', input: { agentId: 'codex',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, selection: { source: 'native' } } }))
                    .rejects.toMatchObject({ code: 'approval_required' });
            });
            expect(home.requestsFor(path).filter(request => request.input !== null)).toEqual([]);
            expect(hook.getCurrent().catalog.value?.bindings).toEqual([]);
            expect(home.requestsFor('/v1/artifacts').some(request => request.input !== null)).toBe(true);
        } finally { await hook.unmount(); await home.reset(); }
    });
    it('admits the device identity-privacy effect before changing the local identity presenter', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Identity privacy', serverUrl: 'https://identity-privacy-admission.test',
            accountId: 'privacy-owner', currentAccount: true });
        await home.requireUiApproval(serverId, 'connectedServices.identityPrivacy.set');
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState().localSettings.hideConnectedAccountIdentities;
        storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: false }, { source: 'ui' });
        const { useConnectedAccountIdentityPrivacy } = await import('@/hooks/ui/useConnectedAccountIdentityPrivacy');
        const hook = await renderHook(() => useConnectedAccountIdentityPrivacy());
        try {
            await act(async () => { await hook.getCurrent().setHidden(true); });
            expect(hook.getCurrent().hidden).toBe(false);
            expect(home.requestsFor('/v1/artifacts').some(request => request.input !== null)).toBe(true);
        } finally {
            await hook.unmount();
            storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: previous }, { source: 'ui' });
            await home.reset();
        }
    });
    it.each(['create', 'patch', 'switchNow'] as const)('holds a mounted pool %s at the configured Action approval instead of writing the pool directly', async operation => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverUrl = 'https://pool-edit-admission.test';
        const serverId = await home.addHome({ name: 'Pool edit', serverUrl, accountId: 'pool-editor', currentAccount: true });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        auth.credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const group = { v: 1, ref: { service, groupId: 'work' }, displayName: 'Work', incarnation: 'work:1', generation: 2,
            runtimeStateRevision: 3, policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null,
            state: {}, createdAt: 0, updatedAt: 0, members: [] };
        const encodedService = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, service));
        home.answer(serverId, `/v4/connect/qualified/groups?service=${encodedService}`, { body: { groups: [group] } });
        home.answer(serverId, 'PATCH /v4/connect/qualified/group', { body: { group: { ...group, displayName: 'Renamed', generation: 3 } } });
        home.answer(serverId, 'POST /v4/connect/qualified/groups', { body: { group: { ...group, ref: { service, groupId: 'new-pool' } } } });
        home.answer(serverId, 'POST /v4/connect/qualified/group/active-account', { body: { group: { ...group, activeConnectedAccountId: 'work', generation: 3 } } });
        await home.requireUiApproval(serverId, `connectedServices.pools.${operation}`);
        const { useQualifiedConnectedAccountGroups } = await import('./useQualifiedConnectedAccountGroups');
        const peer = { status: 'ready' as const, transport: { protocol: 'v4' as const }, errorCode: null };
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({ serverId, service, peer }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().groups).toHaveLength(1));
            await act(async () => {
                const current = hook.getCurrent();
                if (operation === 'create') await current.create({ groupId: 'new-pool', displayName: 'New pool' });
                else if (operation === 'patch') await current.patch({ group: current.groups[0]!, displayName: 'Renamed' });
                else await current.setActiveAccount({ group: current.groups[0]!, account: { service, accountId: 'work' } }).catch(() => null);
            });
            expect(home.requests.filter(request => request.path.startsWith('/v4/connect/qualified/group') && request.input !== null)).toEqual([]);
            expect(hook.getCurrent().groups[0]?.displayName).toBe('Work');
            expect(home.requestsFor('/v1/artifacts').some(request => request.input !== null)).toBe(true);
        } finally {
            await hook.unmount();
            await home.reset();
        }
    });
    async function runPoolDeletion(partialAcknowledgements: boolean, consumedScreen = false, retireDuringAlert = false, retireAfterDelete = false) {
        navigationBoundary.events.length = 0;
        navigationBoundary.onPending = null;
        const pendingAlert = createDeferred<void>();
        const alertEntered = createDeferred<void>();
        if (retireDuringAlert) navigationBoundary.onPending = async () => { alertEntered.resolve(); await pendingAlert.promise; };
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const accountId = 'pool-metadata-owner';
        const serverUrl = `https://pool-metadata-${partialAcknowledgements}.test`;
        const serverId = await home.addHome({ name: 'Metadata', serverUrl, accountId, currentAccount: true });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        auth.credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!auth.credentials) throw new Error('The Home fixture did not publish its device credential');
        const controller = consumedScreen ? await (await import('@/sync/ops/actions/actionAccountContext')).captureLazyActionAccountContext(serverId) : null;
        if (consumedScreen) {
            const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
            const features = createRootLayoutFeaturesResponse({ features: {
                connectedServices: { enabled: true, accountGroups: { enabled: true } },
            } });
            home.answer(serverId, '/v1/features', { body: features });
            home.answer(serverId, '/v1/features/authenticated', { body: features });
            primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        }
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
            settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        home.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
            connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
        } } } });
        home.answer(serverId, `GET ${PROFILE_TRANSFER_ROUTE_V1}`, { body: { status: 'absent' } });
        home.answer(serverId, 'GET /v2/account/settings/history', { body: AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }) });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const ref = { service, groupId: 'primary' };
        const group = { v: 1, ref, displayName: 'Primary', incarnation: 'primary:1', generation: 2, runtimeStateRevision: 3,
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'least_limited', autoSwitch: true,
                switchOn: { usageLimit: true, authExpired: true, accountChanged: false, refreshFailure: false } }),
            activeConnectedAccountId: null, state: { status: 'ready' }, createdAt: 0, updatedAt: 0,
            members: [{ v: 1, connectedAccountId: 'work', priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 }] };
        let groupDeleted = false;
        const encodedService = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, service));
        home.answer(serverId, `/v4/connect/qualified/groups?service=${encodedService}`, {
            select: () => ({ body: { groups: groupDeleted ? [] : [group] } }),
        });
        const deletion = createDeferred<void>();
        let deletionRequests = 0;
        const request = buildQualifiedConnectedAccountGroupMutationRequestV4('delete', { group: ref,
            expectedIncarnation: group.incarnation, expectedGeneration: group.generation, expectedRuntimeStateRevision: group.runtimeStateRevision });
        home.answer(serverId, `DELETE ${request.path}`, { select: async () => {
            deletionRequests += 1;
            await deletion.promise;
            groupDeleted = true;
            if (retireAfterDelete) {
                await home.switchAccount(serverId, 'another-pool-owner');
                auth.credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
            }
            return { body: { success: true } };
        } });
        const encodedGroup = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, ref));
        home.answer(serverId, `GET /v4/connect/qualified/group?group=${encodedGroup}`, { select: () => groupDeleted
            ? { status: 404, body: { error: 'connect_group_not_found' } } : { body: { group } } });
        home.answer(serverId, 'GET /v1/account/profile', { select: () => ({ body: { ...profileDefaults, id: accountId,
            connectedAccountsV4: [{ ref: { service, accountId: 'work' }, displayName: 'Work', status: 'connected',
                authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
                configurationReady: false, configurationRevision: null, scopes: [] }],
            connectedAccountGroupsV4: groupDeleted ? [] : [group] } }) });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } });
        const presentationPath = '/v1/account/entity-rows/connected-metadata/presentation';
        const acknowledgementsPath = '/v1/account/entity-rows/connected-metadata/acknowledgements';
        const retainedAccountLabel = { v: 1, subject: { kind: 'account', account: { service, accountId: 'work' } }, label: 'Retained account label' };
        home.answer(serverId, `GET ${presentationPath}`, { body: { status: 'present', revision: 4,
            content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'group', ...ref }, label: 'Custom pool' }, retainedAccountLabel] } } } });
        home.answer(serverId, `GET ${acknowledgementsPath}`, { body: { status: 'present', revision: 5,
            content: { t: 'plain', v: { v: 1, entries: [
                { v: 1, subject: { kind: 'adoption', agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }), ...ref },
                    acknowledged: partialAcknowledgements ? 'invalid-known-entry' : true },
                { v: 1, subject: { kind: 'warning', warningId: 'unrelated', scope: { kind: 'account' } }, acknowledged: true },
                ...(partialAcknowledgements ? [{ v: 2, subject: { kind: 'future' }, privateNeighbor: 'retain-opaque' }] : []),
            ] } } } });
        home.answer(serverId, `POST ${presentationPath}`, { body: { status: 'updated', revision: 5, cursor: 5 } });
        home.answer(serverId, `POST ${acknowledgementsPath}`, { body: { status: 'updated', revision: 6, cursor: 6 } });
        const { storage } = await import('@/sync/domains/state/storage');
        const originalLocalKeys = storage.getState().localSettings.collapsedGroupKeysV1;
        const scope = { serverId, accountId };
        const targetMemberKey = resolveConnectedServiceCollapseKey({ scope, service, profileId: 'work', groupId: ref.groupId });
        const keptKeys = {
            [resolveConnectedServiceCollapseKey({ scope, service, profileId: 'work' })]: true,
            [resolveConnectedServiceCollapseKey({ scope, service, profileId: 'work', groupId: 'unrelated' })]: false,
            [resolveConnectedServiceCollapseKey({ scope: { ...scope, accountId: 'another-owner' }, service, profileId: 'work', groupId: ref.groupId })]: false,
            [resolveConnectedServiceCollapseKey({ scope, service: { pluginId: 'custom.safe-profile', localId: service.localId }, profileId: 'work', groupId: ref.groupId })]: false,
        };
        storage.setState({ localSettings: { ...storage.getState().localSettings,
            collapsedGroupKeysV1: { ...originalLocalKeys, ...keptKeys, [targetMemberKey]: false } } });
        const { useQualifiedConnectedAccountGroups } = await import('./useQualifiedConnectedAccountGroups');
        const peer = { status: 'ready' as const, transport: { protocol: 'v4' as const }, errorCode: null };
        let unmount: (() => Promise<void>) | undefined;
        let pending: ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']> | undefined;
        try {
            let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
            let currentGroups: UseQualifiedConnectedAccountGroupsResult | undefined;
            const rendered = consumedScreen ? await (async () => {
                if (!controller) throw new Error('The consumed screen fixture has no captured controller');
                const isControllerCurrent = controller.accountLifetime.isCurrent;
                const { ConnectedAccountServiceContent } = await import('@/components/settings/connectedServices/account/ConnectedAccountServiceContent');
                function PoolScreen() {
                    const groups = useQualifiedConnectedAccountGroups({ serverId, service, peer });
                    currentGroups = groups;
                    return <ConnectedAccountServiceContent
                        serverId={serverId} title="Codex" service={service}
                        focus={{ kind: 'group', groupId: ref.groupId }}
                        modes={[]} accounts={[]} groups={groups} busy={groups.mutating}
                        isControllerCurrent={isControllerCurrent}
                    />;
                }
                screen = await renderScreen(<PoolScreen />);
                return { unmount: screen.unmount, getCurrent: () => {
                    if (!currentGroups) throw new Error('Mounted pool hook did not publish');
                    return currentGroups;
                } };
            })() : await renderHook(() => useQualifiedConnectedAccountGroups({ serverId, service, peer }));
            unmount = rendered.unmount;
            await flushHookEffects();
            expect(rendered.getCurrent().groups).toHaveLength(1);
            await act(async () => {
                if (screen) screen.pressByTestId('connected-services-pool-detail:delete');
                else pending = rendered.getCurrent().delete(rendered.getCurrent().groups[0]!);
            });
            expect(rendered.getCurrent().groups).toHaveLength(1);
            expect(home.requestsFor(presentationPath).filter(record => record.input !== null)).toEqual([]);
            expect(storage.getState().localSettings.collapsedGroupKeysV1[targetMemberKey]).toBe(false);
            let result: Awaited<ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']>> = false;
            await act(async () => { deletion.resolve(); if (pending) result = await pending; });
            if (retireAfterDelete) {
                expect(groupDeleted).toBe(true);
                expect(deletionRequests).toBe(1);
                expect(result).toEqual({ applied: true,
                    metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } });
                expect(home.requestsFor(presentationPath).filter(record => record.input !== null)).toEqual([]);
                expect(storage.getState().localSettings.collapsedGroupKeysV1[targetMemberKey]).toBe(false);
                return;
            }
            if (consumedScreen) {
                if (retireDuringAlert) {
                    await alertEntered.promise;
                    await home.switchAccount(serverId, 'another-pool-owner');
                    expect(controller?.accountLifetime.isCurrent()).toBe(false);
                    await act(async () => { pendingAlert.resolve(); await flushHookEffects(); });
                    expect(navigationBoundary.events).toEqual(['pending']);
                } else {
                    await waitForHomeGovernance(() => expect(navigationBoundary.events).toContain('navigate'));
                    expect(navigationBoundary.events).toEqual(['pending', 'navigate']);
                }
                expect(deletionRequests).toBe(1);
            } else expect(result).toEqual({ applied: true, metadataCleanup: partialAcknowledgements
                ? { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } : { status: 'complete' } });
            expect(rendered.getCurrent().groups).toEqual([]);
            expect(storage.getState().localSettings.collapsedGroupKeysV1).toEqual({ ...originalLocalKeys, ...keptKeys });
            expect(home.requestsFor(presentationPath).map(record => record.input)).toContainEqual({ expectedRevision: 4,
                content: { t: 'plain', v: { v: 1, entries: [retainedAccountLabel] } } });
            if (partialAcknowledgements) {
                // A destructive rewrite may not discard the unparsed retained neighbor.
                expect(home.requestsFor(acknowledgementsPath).filter(record => record.input !== null)).toEqual([]);
            } else {
                expect(home.requestsFor(acknowledgementsPath).map(record => record.input)).toContainEqual({ expectedRevision: 5,
                    content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'warning', warningId: 'unrelated', scope: { kind: 'account' } }, acknowledged: true },
                    ] } } });
            }
        } finally {
            pendingAlert.resolve();
            navigationBoundary.onPending = null;
            await act(async () => { deletion.resolve(); await pending?.catch(() => false); });
            await unmount?.();
            controller?.dispose();
            storage.setState({ localSettings: { ...storage.getState().localSettings, collapsedGroupKeysV1: originalLocalKeys } });
            await home.reset();
        }
    }

    it.each([false, true])('retains the exact deletion receipt and clears ready pool metadata (partial acknowledgements: %s)', async (partialAcknowledgements) => {
        await runPoolDeletion(partialAcknowledgements);
    });

    it('presents canonical pending cleanup before leaving the deleted pool through the live Content wrapper', async () => {
        await runPoolDeletion(true, true);
    });

    it('keeps foreign Home navigation untouched when the captured controller retires during pending cleanup presentation', async () => {
        await runPoolDeletion(true, true, true);
    });

    it('preserves the canonical applied receipt through the real Action front door when Home retires with the DELETE acknowledgement', async () => {
        await runPoolDeletion(false, false, false, true);
    });
});
