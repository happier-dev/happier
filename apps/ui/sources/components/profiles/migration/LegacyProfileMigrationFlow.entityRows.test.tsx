import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, createProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderProfileMigrationPrepareSourceRequestV1Schema,
    DaemonProviderProfileMigrationPrepareSourceResponseV1Schema,
    DaemonProviderProfileMigrationPreviewResponseV1Schema,
    DaemonProviderProfileMigrationConfirmRequestV1Schema,
    DaemonProviderProfileMigrationConfirmResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema,
    ProfileRowsListResponseV1Schema, ProfileRowMutationV1Schema, type ProfileRowMutationV1,
    type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema,
    type ProfileTransferRowReadResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { createMachineFixture, createPlainAccountEncryptionCurrentnessFixture,
    createRootLayoutFeaturesResponse, pressTestInstanceAsync, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { applyProfileCatalogSnapshot, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { t } from '@/text';
import { newProfileRoute } from '@/components/settings/profiles/profileCollectionRoutes';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

// Hoist the shared Socket.IO boundary before statically imported RPC owners.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Only the native portal/window measurement is replaced. Menu rows, selection,
// navigation guards and the Profile detail caller beneath it remain real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

type RpcBoundaryCall = Readonly<{ serverUrl: string | undefined; method: string; payload: unknown }>;
const rpc = vi.fn<(call: RpcBoundaryCall) => Promise<unknown>>();
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    // The actual Socket and all application listeners remain real. Only the
    // external handshake, outgoing emission and remote ACK are simulated.
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        queueMicrotask(() => { for (const listener of socket.listeners('connect')) listener(); });
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, ...args: unknown[]) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return {};
        const request = args[0];
        if (request === null || typeof request !== 'object') throw new Error('Expected a Socket RPC request');
        const method: unknown = Reflect.get(request, 'method');
        if (typeof method !== 'string') throw new Error('Expected a Socket RPC method');
        return { ok: true, result: await rpc({ serverUrl, method, payload: Reflect.get(request, 'params') }) };
    });
});

const serverUrl = 'https://profile-migration-home.example.test';
const serverIdentityId = 'srv_profile_migration_home';
const accountId = 'profile-migration-account';
const selectedMachineId = 'machine-selected';
const profile = AIBackendProfileSchema.parse({ id: 'legacy-a', name: 'Legacy A', createdAt: 1, updatedAt: 1,
    environmentVariables: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'source-literal-needs-promotion', isSecret: true },
    ], envVarRequirements: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true }] });

describe('Legacy Profile guided source preparation', () => {
    beforeAll(loadSyncSingletonForTests);
    let homeScope: Readonly<{ serverId: string; accountId: string }>;
    const catalogReads = vi.fn<RuntimeFetch>();
    const transferWrites = vi.fn<RuntimeFetch>();
    const profileRecordWrites = vi.fn<RuntimeFetch>();
    const resourceWrites: string[] = [];
    let acknowledgePreparation: ((response: unknown) => void) | undefined;
    let rawSettings: Readonly<Record<string, unknown>>;
    let settingsVersion: number;
    let transferControl: ProfileTransferRowReadResponseV1;
    let referenceGuardRevision: number | 'absent';
    let acknowledgeConfirmation: (() => void) | undefined;
    let publishConfirmedRows: (() => void) | undefined;
    let disposeConnection: (() => Promise<void>) | undefined;

    beforeEach(async () => {
        await disconnectActiveServerConnection();
        retireActiveServerAccountScopeLifetime();
        serverScopedRpcSocketPool.resetForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        rpc.mockReset();
        catalogReads.mockReset();
        transferWrites.mockReset();
        profileRecordWrites.mockReset();
        resourceWrites.length = 0;
        acknowledgePreparation = undefined;
        acknowledgeConfirmation = undefined;
        publishConfirmedRows = undefined;
        rawSettings = { profiles: [profile] };
        settingsVersion = 13;
        transferControl = { status: 'absent' };
        referenceGuardRevision = 'absent';
        const machineRows = ['machine-nearest', selectedMachineId].map(id => {
            const fixture = createMachineFixture({ id, kind: 'persistent', activeAt: Date.now(),
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
            return { ...fixture, metadata: encodePlainMachineStoredContent(fixture.metadata), daemonState: null };
        });
        catalogReads.mockImplementation(async () => Response.json(ProfileRowsListResponseV1Schema.parse({ status: 'listed',
            rows: [], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 'absent',
            transferControl: { status: 'absent' } })));
        const http: RuntimeFetch = async (url, init) => {
            const requested = new URL(String(url));
            if (requested.origin !== serverUrl) throw new Error(`Unexpected Profile migration Home: ${requested.origin}`);
            const path = requested.pathname;
            if (init?.method && !['GET', 'HEAD'].includes(init.method)
                && (path.startsWith('/v1/artifacts') || path.startsWith('/v1/account/saved-secrets/resources'))) {
                resourceWrites.push(path);
                throw new Error(`Unexpected Resource mutation during Profile authoring: ${path}`);
            }
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId } },
            }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: rawSettings }, version: settingsVersion });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({
                resources: ['auth-private', 'extra-private'].map(resourceId => ({ resourceId, encryptionMode: 'plain',
                    entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
                        name: resourceId, kind: 'apiKey', revision: 3, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'apiKey', value: 'private-boundary-material' } },
                    recipientEnvelope: null })),
            }));
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (path === '/v1/machines') return Response.json(machineRows);
            const machine = machineRows.find(row => path === `/v1/machines/${row.id}`);
            if (machine) return Response.json({ machine });
            if (path === PROFILE_ROWS_ROUTE_V1) return catalogReads(url, init);
            if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') return profileRecordWrites(url, init);
            if (path === PROFILE_TRANSFER_ROUTE_V1) {
                if (init?.method && init.method !== 'GET') return transferWrites(url, init);
                return Response.json(transferControl);
            }
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: referenceGuardRevision });
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        const connected = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId, request: http });
        disposeConnection = connected.dispose;
        homeScope = { serverId: connected.home.id, accountId };
        getStorage().setState({ isDataReady: true, profileScope: homeScope,
            profile: { ...profileDefaults, id: accountId }, settingsScope: homeScope, settingsVersion: 13,
            settings: settingsParse({ profiles: [profile] }) });
        await getSyncSingleton().refreshMachines();
        // The selection is device-local. A raw setState-only fixture is erased
        // by real Account settings hydration, which merges its persisted local
        // fields. Use the same local writer as the actual target controller.
        getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers]: { serverIdentityId, machineId: selectedMachineId },
        } }, { expectedSettingsScope: homeScope, source: 'ui' });
        applyProfileCatalogSnapshot(homeScope, { status: 'ready', source: 'legacy', authority: 'inactive',
            records: [], control: null, controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [] },
        true, new Map(), { legacyProfiles: [profile] });
        rpc.mockImplementation(async call => {
            if (call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE}`)) {
                return await new Promise(resolve => { acknowledgePreparation = resolve; });
            }
            if (call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW}`)) {
                return DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({ status: 'success', sourceProfileId: profile.id,
                    sourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}` });
            }
            return { status: 'error', error: createProviderErrorV1('agent_unavailable', { machineId: selectedMachineId }) };
        });
    });

    afterEach(async () => {
        // Release only a typed partial preparation outcome, never an invented
        // active control. ACK→begin/import/activate is the root API owner's gate.
        acknowledgePreparation?.(DaemonProviderProfileMigrationPrepareSourceResponseV1Schema.parse({
            status: 'partial', settingsVersion: 13,
            diagnostics: [{ profileId: profile.id, reason: 'inline-secret-requires-promotion' }],
        }));
        acknowledgeConfirmation?.();
        publishConfirmedRows?.();
        standardCleanup();
        await disposeConnection?.();
        disposeConnection = undefined;
        retireActiveServerAccountScopeLifetime();
        serverScopedRpcSocketPool.resetForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        resetRuntimeFetch();
    });

    function expectSelectedProviderTarget(current: ReturnType<typeof useProviderSettingsTarget>) {
        expect(getActiveServerSnapshot().serverId).toBe(homeScope.serverId);
        expect(getServerProfileById(homeScope.serverId)?.serverIdentityId).toBe(serverIdentityId);
        expect(captureActiveServerAccountScopeLifetime()).toMatchObject({ scope: homeScope });
        expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
        expect(getStorage().getState().settings.machineAdministrationTargetsLocalV1).toMatchObject({
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers]: { serverIdentityId, machineId: selectedMachineId },
        });
        expect(getStorage().getState().machines[selectedMachineId]).toMatchObject({ kind: 'persistent', storageMode: 'plain',
            availability: { kind: 'available' } });
        expect(current.selection.selectedTarget).toEqual({ serverIdentityId, machineId: selectedMachineId });
        expect(current.selection.candidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { serverIdentityId, machineId: selectedMachineId },
                observation: 'live', availability: 'online' }),
        ]));
        expect(current.selection.state).toMatchObject({ kind: 'online', target: { serverIdentityId, machineId: selectedMachineId } });
        expect(current.selectedTargetServerMatchesActiveAccount).toBe(true);
        expect(current.resolveCurrentTarget()).toEqual({ serverId: homeScope.serverId, machineId: selectedMachineId });
    }

    async function seedDestinationLegacy(input: Readonly<{ holdPublication: boolean }>) {
        // This is an already transferred private legacy row, not an authority
        // fabricated by the source preparation ACK. Source transfer is tested
        // separately; these cases isolate confirmed-copy caller continuation.
        const legacy = AIBackendProfileSchema.parse({ ...profile,
            environmentVariables: profile.environmentVariables.filter(entry => entry.isSecret !== true) });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id,
            definition: { kind: 'legacy', profile: legacy }, enabled: false,
            promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'private-prompt-document' },
                enabled: true, placement: 'system_append' }],
            secretBindings: { ANTHROPIC_AUTH_TOKEN: formatSharedSavedSecretRefV1('auth-private'),
                TOKEN: formatSharedSavedSecretRefV1('extra-private') } });
        let rows: ProfileRowV1[] = [{ id: record.id, revision: 7, content: { t: 'plain', v: record } }];
        rawSettings = {};
        referenceGuardRevision = 3;
        transferControl = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 13, migratedLogicalRevision: 13,
                inventory: [{ kind: 'account_row', id: record.id, revision: 7 }] } } });
        let confirmed = false;
        let published = false;
        const publication = new Promise<void>(resolve => { publishConfirmedRows = () => { published = true; resolve(); }; });
        catalogReads.mockImplementation(async () => {
            if (confirmed && input.holdPublication && !published) await publication;
            return Response.json(ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows, nextCursor: null,
                complete: true, diagnostics: [], referenceGuardRevision, transferControl }));
        });
        await refreshProfileCatalog(homeScope);
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ revision: 7, record: { definition: { kind: 'legacy' } } }] });
        rpc.mockImplementation(async call => {
            if (call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW}`)) {
                return DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({ status: 'success', sourceProfileId: profile.id,
                    sourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}` });
            }
            if (call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM}`)) {
                const request = DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(call.payload);
                return await new Promise(resolve => {
                    acknowledgeConfirmation = () => {
                        acknowledgeConfirmation = undefined;
                        confirmed = true;
                        settingsVersion = 14;
                        const converted = ProfileRecordV1Schema.parse({ ...record,
                            definition: { kind: 'inline', profile: { v: 2, id: profile.id, name: 'Confirmed converted Profile',
                                extraEnvironmentVariables: [], createdAt: 1, updatedAt: 14 } },
                            secretBindings: { TOKEN: record.secretBindings.TOKEN } });
                        rows = [{ id: record.id, revision: 8, content: { t: 'plain', v: converted } }];
                        referenceGuardRevision = 4;
                        resolve(DaemonProviderProfileMigrationConfirmResponseV1Schema.parse({ status: 'success',
                            sourceProfileId: profile.id, connectionId: request.reviewedMapping.connection.id, settingsVersion }));
                    };
                });
            }
            throw new Error(`Unexpected RPC for already-transferred Profile: ${call.method}`);
        });
        return record;
    }

    it('prepares on the exact Provider-selected machine before preview or transfer publication', async () => {
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        expect(getStorage().getState().machines[selectedMachineId]).toMatchObject({ storageMode: 'plain',
            availability: { kind: 'available' } });
        await target.unmount();
        const { LegacyProfileMigrationFlow } = await import('./LegacyProfileMigrationFlow');
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderScreen(<LegacyProfileMigrationFlow profile={profile} secretBindings={{}} onClose={vi.fn()} />);
        expect(rpc).not.toHaveBeenCalled();
        catalogReads.mockClear();
        const preview = screen.findAllByType(Item).find(item => item.props.title === t('settingsProviders.migration.preview'));
        expect(preview).toBeDefined();
        expect(preview?.props.disabled).not.toBe(true);
        await pressTestInstanceAsync(preview, 'Profile migration preview');
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        const call = rpc.mock.calls[0][0];
        expect(call.method).toBe(`${selectedMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE}`);
        expect(new URL(call.serverUrl ?? '').origin).toBe(serverUrl);
        expect(DaemonProviderProfileMigrationPrepareSourceRequestV1Schema.parse(call.payload)).toEqual({
            machineId: selectedMachineId, expectedSettingsVersion: 13 });
        expect(acknowledgePreparation).toBeTypeOf('function');
        expect(rpc.mock.calls.some(([request]) => request.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW}`))).toBe(false);
        // Reading the current rows/control is required to decide whether source
        // preparation is needed. It must not activate or publish destination
        // authority while the actual Machine preparation is still pending.
        expect(transferWrites).not.toHaveBeenCalled();
        expect(getProfileCatalogSnapshot(homeScope)?.source).not.toBe('destination');
        await screen.unmount();
    });

    it('opens retained-legacy duplicate review and never continues when the person cancels', async () => {
        const [{ ProfileDetailScreen }, { LegacyProfileMigrationFlow }, { Item }, { router }] = await Promise.all([
            import('@/components/settings/profiles/ProfileDetailScreen'),
            import('./LegacyProfileMigrationFlow'),
            import('@/components/ui/lists/Item'),
            import('expo-router'),
        ]);
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        await target.unmount();

        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: profile.id }} />);
        await screen.pressByTestIdAsync('settings.profiles.detail.menu.trigger');
        await screen.pressByTestIdAsync('settings.profiles.detail.duplicate');

        // A retained body is not yet an editable V2 copy. Choosing Duplicate must
        // enter the existing review, not immediately open cloneFrom navigation.
        expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(1);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        const cancel = screen.findAllByType(Item).find(item => item.props.title === t('common.cancel'));
        await pressTestInstanceAsync(cancel, 'Cancel Profile duplicate review');

        expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(0);
        expect(screen.findByTestId('settings.profiles.detail.menu.trigger')).not.toBeNull();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        expect(transferWrites).not.toHaveBeenCalled();
        expect(getProfileCatalogSnapshot(homeScope)?.source).toBe('legacy');
        await screen.unmount();
    });

    it.each([
        { cancel: false, outcome: 'opens the copy only after confirmed V2 publication' },
        { cancel: true, outcome: 'never opens a copy after cancellation and a late confirm ACK' },
    ])('already-transferred legacy duplicate $outcome', async ({ cancel }) => {
        const record = await seedDestinationLegacy({ holdPublication: !cancel });
        const [{ ProfileDetailScreen }, { LegacyProfileMigrationFlow }, { Item }, { router }] = await Promise.all([
            import('@/components/settings/profiles/ProfileDetailScreen'),
            import('./LegacyProfileMigrationFlow'),
            import('@/components/ui/lists/Item'),
            import('expo-router'),
        ]);
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        await target.unmount();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: profile.id }} />);
        await screen.pressByTestIdAsync('settings.profiles.detail.menu.trigger');
        await screen.pressByTestIdAsync('settings.profiles.detail.duplicate');
        expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(1);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();

        const preview = screen.findAllByType(Item).find(item => item.props.title === t('settingsProviders.migration.preview'));
        expect(preview?.props.disabled).not.toBe(true);
        await pressTestInstanceAsync(preview, 'Preview converted Profile duplicate');
        await vi.waitFor(() => expect(screen.findAllByType(Item).some(item => item.props.title === t('settingsProviders.migration.confirm'))).toBe(true));
        const confirm = screen.findAllByType(Item).find(item => item.props.title === t('settingsProviders.migration.confirm'));
        await pressTestInstanceAsync(confirm, 'Confirm converted Profile duplicate');
        await vi.waitFor(() => expect(acknowledgeConfirmation).toBeTypeOf('function'));
        const confirmCall = rpc.mock.calls.map(([call]) => call).find(call =>
            call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM}`));
        expect(confirmCall?.method).toBe(`${selectedMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM}`);
        expect(new URL(confirmCall?.serverUrl ?? '').origin).toBe(serverUrl);
        expect(DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(confirmCall?.payload)).toMatchObject({
            machineId: selectedMachineId, sourceProfileId: profile.id,
            expectedSourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}`,
        });
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();

        if (cancel) {
            const close = screen.findAllByType(Item).find(item => item.props.title === t('common.cancel'));
            await pressTestInstanceAsync(close, 'Cancel pending Profile duplicate confirmation');
            expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(0);
            // Remote publication may finish after cancellation; its late ACK is
            // not permission to resume the dismissed caller's copy operation.
            await act(async () => { acknowledgeConfirmation?.(); });
            await refreshProfileCatalog(homeScope);
            await flushHookEffects();
            expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
                records: [{ revision: 8, record: { definition: { kind: 'inline', profile: { v: 2 } } } }] });
            expect(router.replace).not.toHaveBeenCalled();
            expect(router.push).not.toHaveBeenCalled();
            expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(0);
        } else {
            catalogReads.mockClear();
            await act(async () => { acknowledgeConfirmation?.(); });
            await vi.waitFor(() => expect(catalogReads).toHaveBeenCalled());
            // A successful RPC alone cannot construct a copy of the old legacy
            // source. The same captured Home's actual V2 row is still pending.
            expect(router.replace).not.toHaveBeenCalled();
            expect(router.push).not.toHaveBeenCalled();
            expect(getProfileCatalogSnapshot(homeScope)?.data).toMatchObject([
                { revision: 7, record: { definition: { kind: 'legacy' } } },
            ]);
            await act(async () => { publishConfirmedRows?.(); });
            await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(newProfileRoute(profile.id)));
            expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
                records: [{ revision: 8, record: { definition: { kind: 'inline', profile: { v: 2, name: 'Confirmed converted Profile' } },
                    enabled: record.enabled, promptStack: record.promptStack,
                    secretBindings: { TOKEN: record.secretBindings.TOKEN } } }] });
            expect(router.push).not.toHaveBeenCalled();
            expect(vi.mocked(router.replace).mock.calls).toHaveLength(1);
        }
        expect(transferWrites).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps the picker V2 copy identity and private draft pair when its source refreshes', async () => {
        const source = ProfileRecordV1Schema.parse({ v: 1, id: 'picker-source',
            definition: { kind: 'inline', profile: { v: 2, id: 'picker-source', name: 'Original picker source',
                extraEnvironmentVariables: [], createdAt: 1, updatedAt: 1 } },
            enabled: false,
            promptStack: [{ id: 'copied-private-prompt', ref: { kind: 'doc', artifactId: 'copied-private-document' },
                enabled: true, placement: 'system_append' }],
            secretBindings: { TOKEN: formatSharedSavedSecretRefV1('extra-private'), MASKED: null } });
        if (source.definition.kind !== 'inline') throw new Error('Picker continuity fixture requires an inline V2 source');
        let rows: ProfileRowV1[] = [{ id: source.id, revision: 7, content: { t: 'plain', v: source } }];
        rawSettings = {};
        referenceGuardRevision = 3;
        catalogReads.mockImplementation(async () => Response.json(ProfileRowsListResponseV1Schema.parse({
            status: 'listed', rows, nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision,
            transferControl: { status: 'absent' },
        })));
        const posted: ProfileRowMutationV1[] = [];
        profileRecordWrites.mockImplementation(async (_url, init) => {
            const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            posted.push(mutation);
            rows = [...rows, { id: mutation.id, revision: 0, content: mutation.content }];
            referenceGuardRevision = typeof referenceGuardRevision === 'number' ? referenceGuardRevision + 1 : 1;
            return Response.json({ status: 'updated', revision: 0, cursor: 27, referenceGuardRevision });
        });
        await refreshProfileCatalog(homeScope);
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ revision: 7, record: source }] });
        const [{ default: ProfileEditScreen }, { LaunchProfileEditForm }, { HeaderHeightContext }, { router }] = await Promise.all([
            import('@/app/(app)/new/pick/profile-edit'),
            import('@/components/profiles/edit/LaunchProfileEditForm'),
            import('@react-navigation/elements'),
            import('expo-router'),
        ]);
        await act(async () => { router.setParams({ cloneFromProfileId: source.id }); });
        // Supply the measured native-header context, preserving the SDK hook
        // and the actual route/editor below it.
        const wrapper = ({ children }: React.PropsWithChildren) => <HeaderHeightContext.Provider value={0}>{children}</HeaderHeightContext.Provider>;
        const screen = await renderScreen(<ProfileEditScreen />, { wrapper });
        try {
            const initialEditor = screen.findAllByType(LaunchProfileEditForm)[0];
            expect(initialEditor).toBeDefined();
            const copiedId: string = initialEditor.props.profile.id;
            expect(copiedId).not.toBe(source.id);
            expect(initialEditor.props.profile).toMatchObject({ enabled: source.enabled, promptStack: source.promptStack });
            await act(async () => { screen.changeTextByTestId('profile-slim-name', 'My unsaved picker draft'); });
            expect(screen.findByTestId('profile-slim-name')?.props.value).toBe('My unsaved picker draft');

            const updatedSource = ProfileRecordV1Schema.parse({ ...source, enabled: true, promptStack: [],
                definition: { kind: 'inline', profile: { ...source.definition.profile, name: 'Source updated elsewhere', updatedAt: 2 } },
                secretBindings: { TOKEN: formatSharedSavedSecretRefV1('auth-private'), MASKED: formatSharedSavedSecretRefV1('auth-private') } });
            rows = [{ id: source.id, revision: 8, content: { t: 'plain', v: updatedSource } }];
            referenceGuardRevision = 4;
            await act(async () => { await refreshProfileCatalog(homeScope); });
            expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
                records: [{ revision: 8, record: updatedSource }] });
            // Local field state alone can hide a reminted copy. The logical
            // editor identity and private pair must still be the original draft.
            expect(screen.findAllByType(LaunchProfileEditForm)[0].props.profile.id).toBe(copiedId);
            expect(screen.findByTestId('profile-slim-name')?.props.value).toBe('My unsaved picker draft');
            expect(resourceWrites).toEqual([]);

            await screen.pressByTestIdAsync('profile-edit-save');
            await vi.waitFor(() => expect(posted).toHaveLength(1));
            expect(posted[0]).toMatchObject({ id: copiedId, operation: 'create', expectedRevision: 'absent',
                content: { t: 'plain', v: { id: copiedId, definition: { kind: 'inline', profile: { name: 'My unsaved picker draft' } },
                    enabled: source.enabled, promptStack: source.promptStack, secretBindings: source.secretBindings } },
                referencedSavedSecretIds: [formatSharedSavedSecretRefV1('extra-private')],
            });
            expect(resourceWrites).toEqual([]);
            expect(transferWrites).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            await act(async () => { router.setParams({ cloneFromProfileId: undefined }); });
        }
    });

    it('refuses a dirty same-ID picker save after its captured row revision becomes stale', async () => {
        const original = ProfileRecordV1Schema.parse({ v: 1, id: 'stale-picker-profile',
            definition: { kind: 'inline', profile: { v: 2, id: 'stale-picker-profile', name: 'Captured original Profile',
                extraEnvironmentVariables: [], createdAt: 1, updatedAt: 1 } },
            enabled: false, promptStack: [], secretBindings: { MASKED: null } });
        if (original.definition.kind !== 'inline') throw new Error('Stale picker fixture requires an inline V2 row');
        let durable: ProfileRowV1 = { id: original.id, revision: 7, content: { t: 'plain', v: original } };
        rawSettings = {};
        referenceGuardRevision = 3;
        catalogReads.mockImplementation(async () => Response.json(ProfileRowsListResponseV1Schema.parse({
            status: 'listed', rows: [durable], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision,
            transferControl: { status: 'absent' },
        })));
        const posted: ProfileRowMutationV1[] = [];
        profileRecordWrites.mockImplementation(async (_url, init) => {
            const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            posted.push(mutation);
            // Genuine server CAS: captured revision7 is refused. Borrowing the
            // freshly published revision8 would instead overwrite the winner,
            // so this fixture makes that plausible incorrect edit observable.
            if (mutation.expectedRevision !== durable.revision) return Response.json({ status: 'conflict', revision: durable.revision });
            durable = { id: mutation.id, revision: durable.revision + 1, content: mutation.content };
            referenceGuardRevision = typeof referenceGuardRevision === 'number' ? referenceGuardRevision + 1 : 1;
            return Response.json({ status: 'updated', revision: durable.revision, cursor: 28, referenceGuardRevision });
        });
        await refreshProfileCatalog(homeScope);
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ revision: 7, record: original }] });
        const [{ default: ProfileEditScreen }, { LaunchProfileEditForm }, { HeaderHeightContext }, { router, Stack }, { Alert, Platform }] = await Promise.all([
            import('@/app/(app)/new/pick/profile-edit'),
            import('@/components/profiles/edit/LaunchProfileEditForm'),
            import('@react-navigation/elements'),
            import('expo-router'),
            import('react-native'),
        ]);
        await act(async () => { router.setParams({ profileId: original.id, cloneFromProfileId: undefined }); });
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const wrapper = ({ children }: React.PropsWithChildren) => <HeaderHeightContext.Provider value={0}>{children}</HeaderHeightContext.Provider>;
        const screen = await renderScreen(<ProfileEditScreen />, { wrapper });
        // The canonical Node/native fixture presents alerts through this OS
        // boundary. Keep Modal and the save/refusal logic beneath it real.
        expect(Platform.OS).not.toBe('web');
        const nativeAlert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
        try {
            expect(screen.findAllByType(LaunchProfileEditForm)[0].props.profile.profileRecordRevision).toBe(7);
            await act(async () => { screen.changeTextByTestId('profile-slim-name', 'My dirty original-baseline edit'); });
            const competing = ProfileRecordV1Schema.parse({ ...original,
                definition: { kind: 'inline', profile: { ...original.definition.profile, name: 'Competing server edit', updatedAt: 2 } } });
            durable = { id: original.id, revision: 8, content: { t: 'plain', v: competing } };
            referenceGuardRevision = 4;
            await act(async () => { await refreshProfileCatalog(homeScope); });
            expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
                records: [{ revision: 8, record: competing }] });
            expect(screen.findByTestId('profile-slim-name')?.props.value).toBe('My dirty original-baseline edit');
            await screen.pressByTestIdAsync('profile-edit-save');
            // A parser or caller failure is not a stale-editor refusal. Require
            // the actual save path's revision conflict to reach the user.
            await vi.waitFor(() => expect(nativeAlert).toHaveBeenCalledWith(
                t('common.error'), 'profile_revision_conflict', undefined,
            ));
            await flushHookEffects();
            // A fresh local catalog may reject before transport; an issued CAS
            // must still use the original baseline, never authorize via row8.
            expect(posted.every(mutation => mutation.expectedRevision === 7)).toBe(true);
            expect(durable).toEqual({ id: original.id, revision: 8, content: { t: 'plain', v: competing } });
            expect(screen.findByTestId('profile-slim-name')?.props.value).toBe('My dirty original-baseline edit');
            // Native Stack's real options still expose the enabled dirty Save
            // control; conflict must not clear the mounted draft's dirty state.
            expect(screen.findAllByType(Stack.Screen)[0].props.options.headerRight().props.disabled).toBe(false);
            expect(router.replace).not.toHaveBeenCalled();
            expect(router.push).not.toHaveBeenCalled();
            expect(resourceWrites).toEqual([]);
            expect(transferWrites).not.toHaveBeenCalled();
        } finally {
            nativeAlert.mockRestore();
            await screen.unmount();
            await act(async () => { router.setParams({ profileId: undefined }); });
        }
    });
});
