import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema} from '@happier-dev/protocol/profiles/backendProfileSchema';
import { buildBackendTargetKeyV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DaemonProviderProfileMigrationPreviewResponseV1Schema,
    DaemonProviderProfileMigrationPreviewRequestV1Schema,
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
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { createMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';
import ProfileEditScreen from '@/app/(app)/new/pick/profile-edit';
import { LaunchProfileEditForm } from '@/components/profiles/edit/LaunchProfileEditForm';
import { ProfileDetailScreen } from '@/components/settings/profiles/ProfileDetailScreen';
import { Alert } from 'react-native';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

const routeBoundary = vi.hoisted(() => ({ params: {} as ExpoRouterParams, reset: () => {} }));

// Hoist the shared Socket.IO boundary before statically imported RPC owners.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
    const boundary = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeBoundary.params });
    routeBoundary.reset = boundary.resetParams;
    return boundary.module;
});
// Only the native portal/window measurement is replaced. Menu rows, selection,
// navigation guards and the Profile detail caller beneath it remain real.
vi.mock('@/components/ui/popover/Popover', async importOriginal =>
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

await loadSyncSingletonForTests();
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
const [{ getStorage }, { settingsParse }, { profileDefaults }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 },
    { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime }, { getActiveServerSnapshot },
    { getServerProfileById, resolveServerProfileScopeIdForIdentifier }, { disconnectActiveServerConnection }, { getSyncSingleton },
    { applyProfileCatalogSnapshot, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests },
    { refreshProfileCatalog, resetProfileCatalogEngineForTests }, { serverScopedRpcSocketPool }, { resetRuntimeFetch }, { t }, { newProfileRoute }] = await Promise.all([
    import('@/sync/domains/state/storageStore'), import('@/sync/domains/settings/settings'), import('@/sync/domains/profiles/profile'),
    import('@/sync/domains/machines/administration/selectionPreferences'), import('@/sync/domains/scope/activeServerAccountScope'),
    import('@/sync/domains/server/serverRuntime'), import('@/sync/domains/server/serverProfiles'),
    import('@/sync/runtime/orchestration/connectionManager'), import('@/sync/runtime/getSyncSingleton'),
    import('@/sync/store/settings/profileCatalogSnapshot'), import('@/sync/engine/settings/profileCatalogEngine'),
    import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool'), import('@/utils/system/runtimeFetch'),
    import('@/text'), import('@/components/settings/profiles/profileCollectionRoutes'),
]);

const serverUrl = 'https://profile-migration-home.example.test';
const { refreshAcpCatalog, resetAcpCatalogEngineForTests } = await import('@/sync/engine/settings/acpCatalogEngine');
const { resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const serverIdentityId = 'srv_profile_migration_home';
const accountId = 'profile-migration-account';
const migrationPreferences = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
    approvalWaivedSurfaces: { 'launch_profiles.legacy.convert': ['ui'] },
}) };
const selectedMachineId = 'machine-selected';
const machineLoginTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' });
const profile = AIBackendProfileSchema.parse({ id: 'legacy-a', name: 'Legacy A', createdAt: 1, updatedAt: 1,
    environmentVariables: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'source-literal-needs-promotion', isSecret: true },
    ], envVarRequirements: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true }] });

describe('Legacy Profile guided source preparation', () => {
    let homeScope: Readonly<{ serverId: string; accountId: string }>;
    const catalogReads = vi.fn<RuntimeFetch>();
    const transferWrites = vi.fn<RuntimeFetch>();
    const profileRecordWrites = vi.fn<RuntimeFetch>();
    const resourceWrites: string[] = [];
    let rawSettings: Readonly<Record<string, unknown>>;
    let settingsVersion: number;
    let transferControl: ProfileTransferRowReadResponseV1;
    let referenceGuardRevision: number | 'absent';
    let acknowledgeConfirmation: (() => void) | undefined;
    let publishConfirmedRows: (() => void) | undefined;
    let disposeConnection: (() => Promise<void>) | undefined;
    let restoreNativeDialogs: (() => void) | undefined;

    beforeEach(async () => {
        // Drive the person's decisions at the native dialog boundary. The
        // unsaved-changes guard and dangerous-Action confirmation stay real.
        const dialogs = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
            const discard = buttons?.find(button => button.text === t('common.discard'));
            if (discard) discard.onPress?.();
            else if (buttons?.length === 2 && buttons[0].style === 'cancel') buttons[1].onPress?.();
        });
        restoreNativeDialogs = () => dialogs.mockRestore();
        routeBoundary.params = {};
        routeBoundary.reset();
        await disconnectActiveServerConnection();
        retireActiveServerAccountScopeLifetime();
        serverScopedRpcSocketPool.resetForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        rpc.mockReset();
        catalogReads.mockReset();
        transferWrites.mockReset();
        profileRecordWrites.mockReset();
        resourceWrites.length = 0;
        acknowledgeConfirmation = undefined;
        publishConfirmedRows = undefined;
        rawSettings = { ...migrationPreferences, profiles: [profile] };
        settingsVersion = 13;
        transferControl = { status: 'absent' };
        referenceGuardRevision = 'absent';
        const machineRows = ['machine-nearest', selectedMachineId].map(id => {
            const fixture = createMachineFixture({ id, kind: 'persistent', activeAt: Date.now(),
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
            return MachinePublishedRowV1Schema.parse({ ...fixture, metadata: encodePlainMachineStoredContent(fixture.metadata), daemonState: null });
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
            if (path === '/v1/artifacts') return createArtifactListHttpResponse(requested, []);
            if (path === '/v1/account/saved-secrets/resources/materials' || path === '/v1/account/saved-secrets/resources') {
                const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({
                resources: ['auth-private', 'extra-private'].map(resourceId => ({ resourceId, encryptionMode: 'plain',
                    entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
                        name: resourceId, kind: 'apiKey', revision: 3, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'apiKey', value: 'private-boundary-material' } },
                    recipientEnvelope: null })),
                });
                return Response.json(path.endsWith('/materials') ? materials : {
                    resources: materials.resources.map(resource => resource.entry),
                });
            }
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (path === '/v1/machines') return Response.json(machineRows);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => machineRows.find(row => row.id === id) ?? null);
            const machine = machineRows.find(row => path === `/v1/machines/${row.id}`);
            if (machine) return Response.json({ machine });
            if (path === PROFILE_ROWS_ROUTE_V1) return catalogReads(url, init);
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }));
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
        homeScope = { serverId: getActiveServerSnapshot().serverId, accountId };
        getStorage().setState({ isDataReady: true, profileScope: homeScope,
            profile: { ...profileDefaults, id: accountId }, settingsScope: homeScope, settingsVersion: 13,
            settings: settingsParse(rawSettings) });
        await getSyncSingleton().refreshMachines();
        // Home discovery may replace a URL-derived profile id during hydration.
        // Capture the Account scope after that real transition has settled.
        homeScope = { serverId: getActiveServerSnapshot().serverId, accountId };
        getStorage().setState({ profileScope: homeScope, settingsScope: homeScope });
        await refreshAcpCatalog(homeScope);
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
            if (call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW}`)) {
                return DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({ status: 'success', sourceProfileId: profile.id,
                    sourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}` });
            }
            return { status: 'error', error: createProviderErrorV1('agent_unavailable', { machineId: selectedMachineId }) };
        });
    });

    afterEach(async () => {
        acknowledgeConfirmation?.();
        publishConfirmedRows?.();
        standardCleanup();
        await disposeConnection?.();
        disposeConnection = undefined;
        retireActiveServerAccountScopeLifetime();
        serverScopedRpcSocketPool.resetForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        resetRuntimeFetch();
        restoreNativeDialogs?.();
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
        const target = current.resolveCurrentTarget();
        expect(target).not.toBeNull();
        expect({ ...target, serverId: resolveServerProfileScopeIdForIdentifier(target!.serverId) })
            .toEqual({ serverId: homeScope.serverId, machineId: selectedMachineId });
    }

    async function seedDestinationLegacy(input: Readonly<{ holdPublication: boolean; machineLogin?: boolean }>) {
        // An acknowledged destination row, never authority fabricated by a
        // preparation ACK. Private-copy and guided-confirmation callers consume it.
        const legacy = AIBackendProfileSchema.parse(input.machineLogin ? { id: profile.id, name: profile.name,
            authMode: 'machineLogin', requiresMachineLoginTargetKey: machineLoginTargetKey,
            compatibilityByTargetKey: { [machineLoginTargetKey]: true }, createdAt: 1, updatedAt: 1,
            environmentVariables: [{ name: 'DEPLOY_REGION', value: 'west' }], envVarRequirements: [],
        } : { ...profile, environmentVariables: profile.environmentVariables.filter(entry => entry.isSecret !== true) });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id,
            definition: { kind: 'legacy', profile: legacy }, enabled: false,
            promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'private-prompt-document' },
                enabled: true, placement: 'system_append' }],
            secretBindings: { ANTHROPIC_AUTH_TOKEN: formatSharedSavedSecretRefV1('auth-private'),
                TOKEN: formatSharedSavedSecretRefV1('extra-private'), MASKED: null } });
        let rows: ProfileRowV1[] = [{ id: record.id, revision: 7, content: { t: 'plain', v: record } }];
        rawSettings = migrationPreferences;
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
                            secretBindings: { TOKEN: record.secretBindings.TOKEN, MASKED: record.secretBindings.MASKED } });
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

    it('previews on the explicitly selected migration Machine without mutating the source or publishing transfer authority', async () => {
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        expect(getStorage().getState().machines[selectedMachineId]).toMatchObject({ storageMode: 'plain',
            availability: { kind: 'available' } });
        await target.unmount();
        const { LegacyProfileMigrationFlow } = await import('./LegacyProfileMigrationFlow');
        const { Item } = await import('@/components/ui/lists/Item');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<LegacyProfileMigrationFlow profile={profile} secretBindings={{}} onClose={vi.fn()} />);
        expect(rpc).not.toHaveBeenCalled();
        catalogReads.mockClear();
        const machinePicker = screen.findAllByType(DropdownMenu).find(row =>
            row.props.items?.some((item: DropdownMenuItem) => item.id === selectedMachineId));
        expect(machinePicker).toBeDefined();
        await act(async () => { machinePicker!.props.onSelect(selectedMachineId); });
        const preview = screen.findAllByType(Item).find(item => item.props.title === t('settingsProviders.migration.preview'));
        expect(preview).toBeDefined();
        expect(preview?.props.disabled).not.toBe(true);
        await pressTestInstanceAsync(preview, 'Profile migration preview');
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        const call = rpc.mock.calls[0][0];
        expect(call.method).toBe(`${selectedMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW}`);
        expect(new URL(call.serverUrl ?? '').origin).toBe(serverUrl);
        expect(DaemonProviderProfileMigrationPreviewRequestV1Schema.parse(call.payload)).toMatchObject({
            machineId: selectedMachineId, sourceProfileId: profile.id });
        expect(JSON.stringify(call.payload)).not.toContain('source-literal-needs-promotion');
        expect(transferWrites).not.toHaveBeenCalled();
        expect(profileRecordWrites).not.toHaveBeenCalled();
        expect(resourceWrites).toEqual([]);
        expect(getProfileCatalogSnapshot(homeScope)?.source).not.toBe('destination');
        await screen.unmount();
    });

    it('cancels guided migration without an RPC or a source, resource or transfer mutation', async () => {
        const [{ LegacyProfileMigrationFlow }, { Item }, { router }] = await Promise.all([
            import('./LegacyProfileMigrationFlow'),
            import('@/components/ui/lists/Item'),
            import('expo-router'),
        ]);
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        await target.unmount();

        const onClose = vi.fn();
        const sourceBefore = structuredClone(rawSettings);
        const screen = await renderScreen(<LegacyProfileMigrationFlow profile={profile} secretBindings={{}} onClose={onClose} />);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        const cancel = screen.findAllByType(Item).find(item => item.props.title === t('common.cancel'));
        await pressTestInstanceAsync(cancel, 'Cancel Profile duplicate review');

        expect(onClose).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        expect(transferWrites).not.toHaveBeenCalled();
        expect(profileRecordWrites).not.toHaveBeenCalled();
        expect(resourceWrites).toEqual([]);
        expect(rawSettings).toEqual(sourceBefore);
        expect(getProfileCatalogSnapshot(homeScope)?.source).toBe('legacy');
        await screen.unmount();
    });

    it.each([
        { cancel: false, outcome: 'saves the exact captured legacy source and private pair without migration' },
        { cancel: true, outcome: 'discards the captured copy without a source or Resource mutation' },
    ])('already-transferred legacy duplicate $outcome', async ({ cancel }) => {
        const record = await seedDestinationLegacy({ holdPublication: false, machineLogin: true });
        const [{ LegacyProfileMigrationFlow }, { router }] = await Promise.all([
            import('./LegacyProfileMigrationFlow'),
            import('expo-router'),
        ]);
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const target = await renderHook(useProviderSettingsTarget);
        expectSelectedProviderTarget(target.getCurrent());
        await target.unmount();
        const savedScreen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: profile.id }} />);
        await savedScreen.pressByTestIdAsync('settings.profiles.detail.menu.trigger');
        await flushHookEffects({ cycles: 1, frames: 1 });
        await vi.waitFor(() => expect(savedScreen.findByTestId('settings.profiles.detail.duplicate')).not.toBeNull());
        await savedScreen.pressByTestIdAsync('settings.profiles.detail.duplicate');
        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(newProfileRoute(profile.id)));
        await savedScreen.unmount();
        vi.mocked(router.replace).mockClear();
        const posted: ProfileRowMutationV1[] = [];
        profileRecordWrites.mockImplementation(async (_url, init) => {
            const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            posted.push(mutation);
            catalogReads.mockImplementation(async () => Response.json(ProfileRowsListResponseV1Schema.parse({
                status: 'listed', rows: [{ id: record.id, revision: 7, content: { t: 'plain', v: record } },
                    { id: mutation.id, revision: 0, content: mutation.content }], nextCursor: null, complete: true,
                diagnostics: [], referenceGuardRevision: 4, transferControl,
            })));
            return Response.json({ status: 'updated', revision: 0, cursor: 27, referenceGuardRevision: 4 });
        });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: profile.id }} />);
        expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(0);
        const editor = screen.findAllByType(LaunchProfileEditForm)[0];
        const copiedId: string = editor.props.profile.id;
        expect(copiedId).not.toBe(record.id);
        expect(editor.props).toMatchObject({ profile: { enabled: record.enabled, promptStack: record.promptStack },
            draftSecretBindings: record.secretBindings, legacyCloneSource: { id: record.id, revision: 7 }, sourcePreservingClone: true });
        if (cancel) {
            await screen.unmount();
            expect(posted).toEqual([]);
            expect(router.replace).not.toHaveBeenCalled();
        } else {
            await act(async () => { screen.changeTextByTestId('profile-legacy-name', 'Captured legacy copy'); });
            await screen.pressByTestIdAsync('settings.profiles.detail.save');
            await vi.waitFor(() => expect(posted).toHaveLength(1));
            expect(posted[0]).toMatchObject({ id: copiedId, operation: 'clone-legacy', expectedRevision: 'absent',
                legacyCloneSource: { id: record.id, revision: 7 }, content: { t: 'plain', v: {
                    definition: { kind: 'legacy', profile: { name: 'Captured legacy copy', authMode: 'machineLogin', requiresMachineLoginTargetKey: machineLoginTargetKey, environmentVariables:
                        record.definition.kind === 'legacy' ? record.definition.profile.environmentVariables : [] } },
                    enabled: record.enabled, promptStack: record.promptStack, secretBindings: record.secretBindings } } });
            await screen.unmount();
        }
        expect(getProfileCatalogSnapshot(homeScope)?.data?.find(row => row.record.id === record.id))
            .toEqual({ record, revision: 7 });
        expect(rpc).not.toHaveBeenCalled();
        expect(resourceWrites).toEqual([]);
        expect(transferWrites).not.toHaveBeenCalled();
        expect(rawSettings).toEqual(migrationPreferences);
    });

    it('opens an API-source copy only after guided confirmation publishes the canonical migrated row', async () => {
        const record = await seedDestinationLegacy({ holdPublication: true });
        const [{ LegacyProfileMigrationFlow }, { Item }, { DropdownMenu }] = await Promise.all([
            import('./LegacyProfileMigrationFlow'), import('@/components/ui/lists/Item'),
            import('@/components/ui/forms/dropdown/DropdownMenu'),
        ]);
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: record.id }} />);
        expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(1);
        const picker = screen.findAllByType(DropdownMenu).find(row => row.props.items?.some((item: DropdownMenuItem) => item.id === selectedMachineId));
        await act(async () => { picker!.props.onSelect(selectedMachineId); });
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.title === t('settingsProviders.migration.preview')));
        await vi.waitFor(() => expect(screen.findAllByType(Item).some(row => row.props.title === t('settingsProviders.migration.confirm'))).toBe(true));
        await vi.waitFor(() => expect(screen.findAllByType(Item).find(row => row.props.title === t('settingsProviders.migration.confirm'))?.props.disabled).toBe(false));
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.title === t('settingsProviders.migration.confirm')));
        await vi.waitFor(() => expect(acknowledgeConfirmation).toBeTypeOf('function'));
        const confirmation = rpc.mock.calls.map(([call]) => call).find(call => call.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM}`));
        expect(confirmation?.method).toBe(`${selectedMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM}`);
        expect(new URL(confirmation?.serverUrl ?? '').origin).toBe(serverUrl);
        expect(DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(confirmation?.payload)).toMatchObject({
            machineId: selectedMachineId, sourceProfileId: record.id,
            expectedSourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}`,
        });
        catalogReads.mockClear();
        await act(async () => { acknowledgeConfirmation?.(); });
        await vi.waitFor(() => expect(catalogReads).toHaveBeenCalled());
        expect(getProfileCatalogSnapshot(homeScope)?.data).toMatchObject([{ revision: 7, record }]);
        expect(screen.findAllByType(LaunchProfileEditForm)).toHaveLength(0);
        await act(async () => { publishConfirmedRows?.(); });
        await vi.waitFor(() => expect(screen.findAllByType(LaunchProfileEditForm)).toHaveLength(1));
        const copy = screen.findAllByType(LaunchProfileEditForm)[0];
        expect(copy.props.profile.id).not.toBe(record.id);
        expect(copy.props).toMatchObject({ profile: { v: 2, enabled: record.enabled, promptStack: record.promptStack },
            draftSecretBindings: { TOKEN: record.secretBindings.TOKEN, MASKED: null } });
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ revision: 8, record: { definition: { kind: 'inline' } } }] });
        expect(profileRecordWrites).not.toHaveBeenCalled();
        expect(transferWrites).not.toHaveBeenCalled();
        expect(resourceWrites).toEqual([]);
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
        const [{ HeaderHeightContext }, { router }] = await Promise.all([
            import('@react-navigation/elements'),
            import('expo-router'),
        ]);
        routeBoundary.params = { cloneFromProfileId: source.id };
        routeBoundary.reset();
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

    it.each(['inline', 'legacy'] as const)('refuses a dirty same-ID %s picker save after its captured row revision becomes stale', async kind => {
        const original = ProfileRecordV1Schema.parse({ v: 1, id: 'stale-picker-profile',
            definition: kind === 'inline'
                ? { kind, profile: { v: 2, id: 'stale-picker-profile', name: 'Captured original Profile',
                    extraEnvironmentVariables: [], createdAt: 1, updatedAt: 1 } }
                : { kind, profile: { id: 'stale-picker-profile', name: 'Captured original Profile',
                    environmentVariables: [], compatibilityByTargetKey: { [machineLoginTargetKey]: true }, createdAt: 1, updatedAt: 1 } },
            enabled: false, promptStack: [], secretBindings: { MASKED: null } });
        const nameField = kind === 'inline' ? 'profile-slim-name' : 'profile-legacy-name';
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
        const [{ HeaderHeightContext }, { router, Stack }, { Alert, Platform }] = await Promise.all([
            import('@react-navigation/elements'),
            import('expo-router'),
            import('react-native'),
        ]);
        routeBoundary.params = { profileId: original.id };
        routeBoundary.reset();
        vi.mocked(router.replace).mockClear();
        vi.mocked(router.push).mockClear();
        const wrapper = ({ children }: React.PropsWithChildren) => <HeaderHeightContext.Provider value={0}>{children}</HeaderHeightContext.Provider>;
        const screen = await renderScreen(<ProfileEditScreen />, { wrapper });
        // The canonical Node/native fixture presents alerts through this OS
        // boundary. Keep Modal and the save/refusal logic beneath it real.
        expect(Platform.OS).not.toBe('web');
        const nativeAlert = vi.mocked(Alert.alert);
        nativeAlert.mockClear();
        try {
            expect(screen.findAllByType(LaunchProfileEditForm)[0].props.profile).toMatchObject({ profileRecordRevision: 7 });
            await act(async () => { screen.changeTextByTestId(nameField, 'My dirty original-baseline edit'); });
            const competing = ProfileRecordV1Schema.parse({ ...original,
                definition: { ...original.definition, profile: { ...original.definition.profile, name: 'Competing server edit', updatedAt: 2 } } });
            durable = { id: original.id, revision: 8, content: { t: 'plain', v: competing } };
            referenceGuardRevision = 4;
            await act(async () => { await refreshProfileCatalog(homeScope); });
            expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
                records: [{ revision: 8, record: competing }] });
            expect(screen.findByTestId(nameField)?.props.value).toBe('My dirty original-baseline edit');
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
            expect(screen.findByTestId(nameField)?.props.value).toBe('My dirty original-baseline edit');
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
