import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';
import { parseSavedSecretCatalogReferenceV1, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ProfileRowsListResponseV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { IModal } from '@/modal';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { clearActiveUnsavedChangesGuard, runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alert = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn<IModal['confirm']>(async () => false));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert, confirm } }).module;
    },
});
// Keep the store and its selectors real; the settings helper defaults to a stub.
vi.doUnmock('@/sync/domains/state/storage');
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function entry(id: string): SavedSecretCatalogEntryV1 {
    return {
        ref: `happier:shared-secret:v1:${id}`, source: 'shared_resource', relationship: 'owner',
        name: id, kind: 'apiKey', encryptionMode: 'plain', owner: null, accessSources: [],
        audience: { accounts: [{ kind: 'account', accountId: 'recipient', firstName: 'Recipient', lastName: null, username: null, avatarUrl: null }], teams: [], groups: [] },
        ownerAccountId: 'account-owner', revision: 3, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
    };
}

function materialFor(entry: SavedSecretCatalogEntryV1): SavedSecretResourceMaterialV1 {
    const ref = parseSavedSecretCatalogReferenceV1(entry.ref);
    if (ref?.kind !== 'shared_resource') throw new Error('The fixture must name a shared resource');
    return { resourceId: ref.id, encryptionMode: 'plain', entry,
        storedContent: { t: 'plain', v: { v: 1, name: entry.name ?? ref.id, kind: 'apiKey', value: 'test-secret' } },
        recipientEnvelope: null };
}

beforeEach(async () => {
    await harness.reset();
    const { resetSavedSecretCatalogEngineForTests } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetTeamActionClientForTests();
    clearActiveUnsavedChangesGuard();
    alert.mockReset();
    confirm.mockReset().mockResolvedValue(false);
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockImplementation(confirm);
    vi.mocked(Modal.alert).mockImplementation(alert);
});
afterEach(async () => { await connection?.dispose(); connection = null; standardCleanup(); clearActiveUnsavedChangesGuard(); });

async function mount(editAccess = true, initializeSync = false, beforeRender?: (scope: ServerAccountScope) => Promise<void>) {
    const serverId = await harness.addHome({ name: 'Secrets Home', serverUrl: 'https://secret-editor.test', accountId: 'account-owner', teamsEnabled: true, currentAccount: true });
    await harness.selectHomes([serverId]);
    if (initializeSync) {
        connection = await restoreServerAccountForTest({ serverUrl: 'https://secret-editor.test', accountId: 'account-owner',
            credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }) },
        });
    }
    const scope = { serverId, accountId: 'account-owner' };
    const entries = [entry('secret-a'), entry('secret-b')];
    const { storage } = await import('@/sync/domains/state/storage');
    if (initializeSync) {
        storage.getState().activateProfileScope(scope);
        await storage.getState().activateSettingsScope(scope);
        storage.getState().applySettings(storage.getState().settings, 1);
    } else storage.setState({ settingsScope: scope, profileScope: scope, settingsVersion: 1 });
    // These continuity cases exercise settled writers. The Account's explicit
    // waiver is persisted at the real policy boundary; it is not a local bypass.
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1, approvalWaivedSurfaces: { 'secrets.shared.update': ['ui'], 'secrets.shared.grants.set': ['ui'] },
    }) };
    storage.setState({ settings });
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) });
    harness.answer(serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: [], nextCursor: null, complete: true, referenceGuardRevision: 'absent',
        transferControl: { status: 'absent' }, diagnostics: [],
    }) });
    harness.answer(serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 'absent' } });
    harness.answer(serverId, PROFILE_TRANSFER_ROUTE_V1, { body: { status: 'absent' } });
    harness.answer(serverId, REMOTE_HOST_ROWS_ROUTE_V1, {
        body: RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }),
    });
    for (const [route, body] of [
        [MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'absent' })],
        [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
    ] as const) harness.answer(serverId, route, { body });
    harness.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: entries.map(materialFor) } });
    await beforeRender?.(scope);
    if (initializeSync) {
        const { readRemoteHostCatalog } = await import('@/sync/api/account/apiRemoteHostCatalog');
        const remoteHosts = await readRemoteHostCatalog(scope);
        expect(remoteHosts, JSON.stringify(remoteHosts)).toMatchObject({ status: 'ready', hosts: [], revision: 'absent' });
    }
    applySavedSecretCatalogPage({ scope, entries, observedAt: 1 });
    const { SecretsSettingsScreen } = await import('./SecretsSettingsScreen');
    const screen = await renderScreen(<SecretsSettingsScreen />);
    if (editAccess) {
        await screen.pressByTestIdAsync(`saved-secret:${entries[0]!.ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${entries[0]!.ref}:manageAccess`);
        // Removing the recipient from the draft makes the editor dirty; nothing is written yet.
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:recipient');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:recipient');
    }
    return { screen, scope, entries };
}

async function initializeRemovalSettings(scope: ServerAccountScope, waiveApproval: boolean, waiveWriterApprovals = false, requireDeletionApproval = false) {
    const { storage } = await import('@/sync/domains/state/storage');
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1, ...(requireDeletionApproval ? { actions: { 'secrets.shared.delete': { approvalRequiredSurfaces: ['ui'] } } } : {}),
        approvalWaivedSurfaces: {
            ...(waiveApproval ? { 'secrets.shared.delete': ['ui'] } : {}),
            ...(waiveWriterApprovals ? { 'secrets.shared.update': ['ui'], 'secrets.shared.grants.set': ['ui'] } : {}),
        },
    }) };
    storage.setState({ settings });
    let serverContent: unknown = { t: 'plain', v: settings };
    let serverVersion = 1;
    harness.answer(scope.serverId, '/v2/account/settings', { select: input => {
        if (input !== null) {
            const write = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(write.expectedVersion).toBe(serverVersion);
            serverContent = write.content;
            return { body: { success: true, version: ++serverVersion } };
        }
        return { body: { content: serverContent, version: serverVersion } };
    } });
    harness.answer(scope.serverId, '/v1/account/encryption/currentness', { select: () => ({
        body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: serverVersion }),
    }) });
    const { readProfileCatalog } = await import('@/sync/api/account/apiProfileCatalog');
    expect(await readProfileCatalog(scope)).toMatchObject({ status: 'ready' });
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    await act(async () => {
        // Initial Sync normalization can conflict with this fixture's baseline.
        // The actual deletion always uses the settled version without rebasing.
        expect(await getSyncSingleton().mutateAccountSettingsOnce({
            expectedSettingsScope: scope, expectedSettingsVersion: serverVersion, rebaseOnConflict: true,
            mutate: raw => ({ settings: { ...raw }, value: undefined }),
        })).toMatchObject({ status: 'applied' });
    });
}

describe('Saved Secrets editor continuity through the settings screen', () => {
    it('honors explicit Account Ask for deletion, reviews the Inbox-executed failure, and asks again for the exact manual retry', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, false, false, true));
        const resource = createManagedResourceDependencyFixture();
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { select: input => input && typeof input === 'object' && 'managedResourceDispositions' in input
            ? { body: { resourceId: 'secret-a' } }
            : { status: 409, body: { error: 'managed_resources_review_required', resources: [resource] } } });
        confirm.mockResolvedValue(true);
        const secret = entries[0]!;
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:delete`);
        const artifacts = harness.artifacts(scope.serverId);
        await vi.waitFor(() => expect(artifacts.list(), JSON.stringify({ alerts: alert.mock.calls,
            hosts: harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1), settings: harness.requestsFor('/v2/account/settings').map(request => {
                const parsed = AccountSettingsV2UpdateRequestSchema.safeParse(request.input);
                return parsed.success ? { expectedVersion: parsed.data.expectedVersion } : { read: true };
            }),
            deletes: harness.requestsFor(path),
        })).toHaveLength(1));
        const firstId = artifacts.list()[0]!.id;
        const readApproval = (id: string) => ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(id)!));
        expect(readApproval(firstId)).toMatchObject({ actionId: 'secrets.shared.delete', status: 'open' });
        expect(harness.requestsFor(path)).toHaveLength(0);
        // The generic Inbox executor owns replay, failure projection and Artifact
        // persistence. The test does not fabricate terminal failure details.
        await decideApprovalAsInbox(scope.serverId, firstId, 'approve');
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(readApproval(firstId)).toMatchObject({ status: 'failed', execution: {
            ok: false, errorCode: 'managed_resources_review_required',
        } });
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
        expect(confirm.mock.calls[1]?.[1]).toContain('native-1');
        await vi.waitFor(() => expect(artifacts.list()).toHaveLength(2));
        const retryId = artifacts.list()[1]!.id;
        const dispositions = [{ managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedResource: resource.resource,
            expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery,
            responsibility: 'manual' as const }];
        expect(readApproval(retryId)).toMatchObject({ status: 'open', actionId: 'secrets.shared.delete',
            actionArgs: { ...readApproval(firstId).actionArgs as object, managedResourceDispositions: dispositions } });
        // Manual consent does not waive ordinary Action admission. No retry is
        // sent to the Home until this second normal approval is granted.
        expect(harness.requestsFor(path)).toHaveLength(1);
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', {
            body: { resources: [materialFor(entries[1]!)] },
        });
        await decideApprovalAsInbox(scope.serverId, retryId, 'approve');
        expect(readApproval(retryId)).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(harness.requestsFor(path)[1]?.input).toEqual({ ...harness.requestsFor(path)[0]!.input as object,
            managedResourceDispositions: dispositions });
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.ref}:header`)).toBeNull());
        expect(alert).not.toHaveBeenCalled();
    });

    it.each(['cancel', 'manual', 'retired', 'corrupt'] as const)('reviews retained managed resources through the shared secret deletion owner (%s)', async (choice) => {
        const { screen, scope, entries } = await mount(false, true, async scope => {
            const { storage } = await import('@/sync/domains/state/storage');
            const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, approvalWaivedSurfaces: { 'secrets.shared.delete': ['ui'] },
            }) };
            storage.setState({ settings });
            let serverContent: unknown = { t: 'plain', v: settings };
            let serverVersion = 1;
            harness.answer(scope.serverId, '/v2/account/settings', { select: input => {
                if (input !== null) {
                    const write = AccountSettingsV2UpdateRequestSchema.parse(input);
                    expect(write.expectedVersion).toBe(serverVersion);
                    serverContent = write.content;
                    return { body: { success: true, version: ++serverVersion } };
                }
                return { body: { content: serverContent, version: serverVersion } };
            } });
            harness.answer(scope.serverId, '/v1/account/encryption/currentness', { select: () => ({
                body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: serverVersion }),
            }) });
            harness.answer(scope.serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
                status: 'listed', rows: [], nextCursor: null, complete: true, referenceGuardRevision: 'absent',
                transferControl: { status: 'absent' }, diagnostics: [],
            }) });
            harness.answer(scope.serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 'absent' } });
            harness.answer(scope.serverId, PROFILE_TRANSFER_ROUTE_V1, { body: { status: 'absent' } });
            const { readProfileCatalog } = await import('@/sync/api/account/apiProfileCatalog');
            const profiles = await readProfileCatalog(scope);
            expect(profiles, JSON.stringify(profiles)).toMatchObject({ status: 'ready' });
            const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
            await act(async () => {
                const initialized = await getSyncSingleton().mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: serverVersion,
                    // Fixture initialization may first flush canonical Settings normalization.
                    // The later delete still captures the settled version and never rebases.
                    rebaseOnConflict: true,
                    mutate: raw => ({ settings: { ...raw }, value: undefined }),
                });
                expect(initialized, JSON.stringify({ initialized, serverVersion,
                    settingsVersion: storage.getState().settingsVersion, requests: harness.requestsFor('/v2/account/settings').map(request => {
                        const write = AccountSettingsV2UpdateRequestSchema.safeParse(request.input);
                        return write.success ? { expectedVersion: write.data.expectedVersion,
                            settingKeys: write.data.content?.t === 'plain' ? Object.keys(write.data.content.v) : [] } : { method: 'GET' };
                    }),
                })).toMatchObject({ status: 'applied' });
            });
        });
        const secret = entries[0]!;
        const { storage } = await import('@/sync/domains/state/storage');
        const resource = createManagedResourceDependencyFixture();
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const originalLifetime = captureActiveServerAccountScopeLifetime();
        expect(originalLifetime?.isCurrent()).toBe(true);
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { select: input => input && typeof input === 'object' && 'managedResourceDispositions' in input
            ? { status: 500, body: { error: 'unknown' } }
            : { status: 409, body: { error: 'managed_resources_review_required', resources: [resource] } } });
        confirm.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
            if (choice === 'retired') {
                await harness.switchAccount(scope.serverId, 'account-next');
                // Publish the new Account through the actual scope producers, as
                // Sync does after credential restoration. A settings-only fixture
                // cannot claim that the Profile-owned active lifetime retired.
                const nextScope = { ...scope, accountId: 'account-next' };
                storage.getState().activateProfileScope(nextScope);
                await storage.getState().activateSettingsScope(nextScope);
                expect(originalLifetime?.isCurrent()).toBe(false);
                expect(storage.getState().settingsScope).toEqual(nextScope);
            }
            return choice !== 'cancel';
        });
        const deleteTestId = choice === 'corrupt' ? 'saved-secret-corrupt:owner:0:delete' : `saved-secret:${secret.ref}:delete`;
        if (choice === 'corrupt') {
            const corruptEntry = {
                materialStatus: 'resource_corrupt', relationship: 'owner', repair: {
                    kind: 'delete_resource', resourceId: 'corrupt-secret', expectedRevision: secret.revision!,
                },
            } as const;
            harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', {
                body: { resources: [...entries.map(materialFor), { entry: corruptEntry }] },
            });
            act(() => applySavedSecretCatalogPage({ scope, entries, observedAt: 2, corruptEntries: [corruptEntry] }));
        } else await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:header`);
        await screen.pressByTestIdAsync(deleteTestId);
        expect(harness.requestsFor(path), JSON.stringify({ alerts: alert.mock.calls,
            hosts: harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1), settings: harness.requestsFor('/v2/account/settings').map(request => {
                const parsed = AccountSettingsV2UpdateRequestSchema.safeParse(request.input);
                return parsed.success ? { expectedVersion: parsed.data.expectedVersion } : { read: true };
            }),
        })).not.toHaveLength(0);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
        expect(confirm.mock.calls[1]?.[1]).toContain('native-1');
        const requests = harness.requestsFor(path);
        const accepted = choice === 'manual' || choice === 'corrupt';
        expect(requests).toHaveLength(accepted ? 2 : 1);
        if (accepted) {
            expect(requests[1]?.input).toEqual({ ...requests[0]?.input as object, managedResourceDispositions: [{
                managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
                expectedAllocation: resource.allocation, expectedResource: resource.resource,
                expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery,
                responsibility: 'manual',
            }] });
        }
        if (choice !== 'retired') expect(screen.findByTestId(deleteTestId)).not.toBeNull();
        expect(alert).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });

    it('commits inline names and exact replacement bytes through the canonical shared resource writer', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, false, true));
        const secret = entries[0]!;
        const resourceId = 'secret-a';
        const path = '/v1/account/saved-secrets/resources/update';
        const materials = '/v1/account/saved-secrets/resources/materials';
        harness.answer(scope.serverId, materials, { body: { resources: [{
            resourceId, encryptionMode: 'plain', entry: secret,
            storedContent: { t: 'plain', v: { v: 1, name: 'secret-a', kind: 'apiKey', value: 'original-secret' } },
            recipientEnvelope: null,
        }] } });
        harness.answer(scope.serverId, path, { body: { resourceId, revision: 4 } });
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:rename`);
        expect(harness.requestsFor(path)).toHaveLength(0);
        await act(async () => screen.changeTextByTestId(`saved-secret:${secret.ref}:edit-input`, '  Renamed key  '));
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:edit-save`);
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
        expect(harness.requestsFor(path)[0]?.input).toEqual(expect.objectContaining({
            resourceId, expectedRevision: 3, displayName: 'Renamed key',
            storedContent: { t: 'plain', v: { v: 1, name: 'Renamed key', kind: 'apiKey', value: 'original-secret' } },
        }));
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.ref}:edit-input`)).toBeNull());

        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:rotate`);
        const input = screen.findAllByTestId(`saved-secret:${secret.ref}:edit-input`).find((node) => typeof node.props.onChangeText === 'function');
        expect(input?.props.secureTextEntry).toBe(true);
        expect(input?.props.value).toBe('');
        await act(async () => screen.changeTextByTestId(`saved-secret:${secret.ref}:edit-input`, '  exact replacement\n'));
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:edit-save`);
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(2));
        expect(harness.requestsFor(path)[1]?.input).toEqual(expect.objectContaining({
            resourceId, expectedRevision: 3,
            storedContent: { t: 'plain', v: { v: 1, name: 'secret-a', kind: 'apiKey', value: '  exact replacement\n' } },
        }));
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.ref}:edit-input`)).toBeNull());
    });

    it('preserves a new secret when collapse is declined and discards only after confirmation', async () => {
        const { screen } = await mount(false);
        await screen.pressByTestIdAsync('saved-secret-add');
        await act(async () => screen.changeTextByTestId('saved-secret-create-name', 'Draft key'));
        const draft = screen.findAllByTestId('saved-secret-draft').find((node) => typeof node.props.onExpandedChange === 'function');
        await act(async () => draft?.props.onExpandedChange(false));
        expect(alert).toHaveBeenCalledOnce();
        const buttons = alert.mock.calls[0]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => buttons.find((button) => button.style === 'cancel')?.onPress?.());
        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('Draft key');
        await act(async () => draft?.props.onExpandedChange(false));
        const discardButtons = alert.mock.calls[1]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => discardButtons.find((button) => button.style === 'destructive')?.onPress?.());
        expect(screen.findByTestId('saved-secret-create-name')).toBeNull();
    });

    it.each([false, true])('settles a save whose catalog revision changed and leaves reload and cancel usable (lost response: %s)', async (dispatchThenFail) => {
        const { screen, scope, entries } = await mount(true, true, scope => initializeRemovalSettings(scope, false, true));
        const response = createDeferred<void>();
        const path = '/v1/account/saved-secrets/resources/grants';
        harness.answer(scope.serverId, path, { body: { resourceId: 'secret-a', revision: 4 }, respondAfter: response.promise, dispatchThenFail });
        await screen.pressByTestIdAsync('saved-secret-access-save');
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
        const revisedEntries = [{ ...entries[0]!, revision: 4 }, entries[1]!];
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: revisedEntries.map(materialFor) } });
        act(() => applySavedSecretCatalogPage({ scope, entries: revisedEntries, observedAt: 2 }));
        await act(async () => { response.resolve(); await response.promise; });
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-reload')?.props.disabled).not.toBe(true));
        expect(screen.findByTestId('saved-secret-access-reload')).not.toBeNull();
        expect(screen.findByTestId('saved-secret-access-cancel')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('saved-secret-access-reload');
        // Reload adopts the current audience as both draft and baseline. A
        // clean no-op Save is disabled, while a fresh edit remains usable.
        expect(screen.findByTestId('saved-secret-access-save')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:recipient');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:recipient');
        expect(screen.findByTestId('saved-secret-access-save')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('saved-secret-access-cancel');
        const navigate = vi.fn();
        await act(async () => { await runGuardedNavigation(navigate); });
        expect(navigate).toHaveBeenCalledOnce();
        expect(alert).not.toHaveBeenCalled();
    });

    it('keeps a dirty recipient draft until the person confirms switching to another secret', async () => {
        const { screen, entries } = await mount();
        await screen.pressByTestIdAsync(`saved-secret:${entries[1]!.ref}:header`);
        expect(alert).toHaveBeenCalledOnce();
        const buttons = alert.mock.calls[0]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => buttons.find((button) => button.style === 'cancel')?.onPress?.());
        // A is still editing and B's attempted expansion was declined.
        expect(screen.findByTestId(`saved-secret:${entries[1]!.ref}:manageAccess`)).toBeNull();
        expect(screen.findByTestId(`saved-secret:${entries[0]!.ref}:manageAccess`)).toBeNull();
        await screen.pressByTestIdAsync(`saved-secret:${entries[1]!.ref}:header`);
        const discardButtons = alert.mock.calls[1]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => discardButtons.find((button) => button.style === 'destructive')?.onPress?.());
        expect(screen.findByTestId(`saved-secret:${entries[1]!.ref}:manageAccess`)).not.toBeNull();
        await screen.pressByTestIdAsync(`saved-secret:${entries[1]!.ref}:manageAccess`);
        expect(screen.findByTestId(`saved-secret:${entries[1]!.ref}:manageAccess`)).toBeNull();
        // The replacement starts clean; the same canonical guard also covers global navigation.
        const navigate = vi.fn();
        await act(async () => { await runGuardedNavigation(navigate); });
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('keeps a typed name when switching editor is declined, then retires it before access opens', async () => {
        const { screen, entries } = await mount(false);
        const ref = entries[0]!.ref;
        await screen.pressByTestIdAsync(`saved-secret:${ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${ref}:rename`);
        await act(async () => screen.changeTextByTestId(`saved-secret:${ref}:edit-input`, 'Unsaved name'));
        await screen.pressByTestIdAsync(`saved-secret:${ref}:manageAccess`);
        expect(alert).toHaveBeenCalledOnce();
        const buttons = alert.mock.calls[0]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => buttons.find((button) => button.style === 'cancel')?.onPress?.());
        expect(screen.findByTestId(`saved-secret:${ref}:edit-input`)?.props.value).toBe('Unsaved name');
        expect(screen.findByTestId('saved-secret-access-save')).toBeNull();
        await screen.pressByTestIdAsync(`saved-secret:${ref}:manageAccess`);
        const discard = alert.mock.calls[1]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => discard.find((button) => button.style === 'destructive')?.onPress?.());
        expect(screen.findByTestId(`saved-secret:${ref}:edit-input`)).toBeNull();
        expect(screen.findByTestId('saved-secret-access-save')).not.toBeNull();
    });
});
