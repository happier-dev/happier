import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
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
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowReadResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
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
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { clearActiveUnsavedChangesGuard, runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alert = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn<IModal['confirm']>(async () => false));
const writeClipboard = vi.hoisted(() => vi.fn(async (_value: string) => true));
vi.mock('expo-clipboard', () => ({ setStringAsync: writeClipboard }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert, confirm } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function entry(id: string): SavedSecretCatalogEntryV1 {
    return {
        ref: `happier:shared-secret:v1:${id}`, source: 'shared_resource', relationship: 'owner',
        name: id, kind: 'apiKey', encryptionMode: 'plain', owner: null, accessSources: [],
        audience: { accounts: [{ kind: 'account', accountId: 'recipient', name: 'Recipient', firstName: 'Recipient', lastName: null, username: null, avatarUrl: null }], teams: [], groups: [] },
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
    // A secret's page is the route's `secret`; no test inherits the previous one's.
    (await import('expo-router')).router.setParams({ secret: undefined });
    writeClipboard.mockClear();
    installBrowserClipboardBoundary(async text => { await writeClipboard(text); });
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
            request: (input, init) => harness.request(input, init),
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
        [NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'absent' })],
        [MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'absent' })],
        [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
        [`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`, PromptLibraryRowReadResponseV1Schema.parse({ status: 'absent' })],
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
    const commits = vi.fn<React.ProfilerOnRenderCallback>();
    const screen = await renderScreen(<React.Profiler id="saved-secrets" onRender={commits}><SecretsSettingsScreen /></React.Profiler>);
    if (editAccess) {
        await openSecretPage(entries[0]!.ref);
        await screen.pressByTestIdAsync(`saved-secret:${entries[0]!.ref}:manageAccess`);
        // Removing the recipient from the draft makes the editor dirty; nothing is written yet.
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:recipient');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:recipient');
    }
    return { screen, scope, entries, commits };
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
            // A setState-only policy does not change the real writer's captured
            // Settings baseline. Persist the setup intent through that writer.
            mutate: raw => ({ settings: { ...raw, actionsSettingsV1: settings.actionsSettingsV1 }, value: undefined }),
        })).toMatchObject({ status: 'applied' });
    });
}

describe('Shared Saved Secret person disclosure controller', () => {
    it('projects the old value hidden on the first new-subject layout before passive cleanup', async () => {
        const { scope, entries } = await mount(false);
        const { useSharedSavedSecretReveal } = await import('@/components/secrets/useSharedSavedSecretReveal');
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/activity', { body: { historyEntryId: 'disclosure-entry' } });
        const layouts: string[] = [];
        const hook = await renderHook(({ selected }) => {
            const controller = useSharedSavedSecretReveal({ scope, entry: selected, confirmDisclosure: async () => true });
            React.useLayoutEffect(() => { if (selected.ref === entries[1]!.ref) layouts.push(controller.state.status); });
            return controller;
        }, { initialProps: { selected: entries[0]! } });
        await act(async () => { await hook.getCurrent().reveal(); });
        expect(hook.getCurrent().state.status).toBe('revealed');
        await hook.rerender({ selected: entries[1]! });
        expect(layouts.length).toBeGreaterThan(0);
        expect(layouts.every(status => status === 'hidden')).toBe(true);
    });

    it('refuses a retired leaf after requested history before it reads the exact body', async () => {
        const { scope, entries } = await mount(false);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { openSavedSecretDisclosureInContext } = await import('@/sync/ops/settings/savedSecretDisclosure');
        const response = createDeferred<void>();
        const activityPath = '/v1/account/saved-secrets/resources/activity';
        let exactBodyReads = 0;
        harness.answer(scope.serverId, activityPath, { body: { historyEntryId: 'disclosure-entry' }, respondAfter: response.promise });
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { select: (_input, request) => {
            if (new URL(request.url).searchParams.get('requireManage') === 'true') exactBodyReads++;
            return { body: { resources: [materialFor(entries[0]!)] } };
        } });
        const account = await captureLazyActionAccountContext(scope.serverId);
        let current = true;
        try {
            const opened = openSavedSecretDisclosureInContext(account, { ref: entries[0]!.ref, expectedRevision: 3 },
                'host-device', undefined, () => current);
            await vi.waitFor(() => expect(harness.requestsFor(activityPath)).toHaveLength(1));
            current = false;
            response.resolve();
            expect(await opened).toMatchObject({ ok: false, reason: 'changed' });
            expect(exactBodyReads).toBe(0);
        } finally { account.dispose(); response.resolve(); }
    });

    it('reconciles two consumed history pages on an exact Copy push without dropping older siblings', async () => {
        const { scope } = await mount(false);
        const { useSharedSavedSecretActivity } = await import('@/components/secrets/useSharedSavedSecretActivity');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { savedSecretDisclosureActivityEntityIdV1 } = await import('@happier-dev/protocol/account/settings/savedSecretReferenceV1');
        const row = { id: 'history-a', ref: entry('secret-a').ref, resourceRevision: 3, actorDisplayName: 'Owner',
            deviceId: 'device-a', createdAt: '2026-10-27T00:00:00.000Z', outcome: 'displayed' as const,
            copyOutcome: null as 'succeeded' | null, copyRequestedAt: null as string | null };
        const sibling = { ...row, id: 'history-b', createdAt: '2026-10-27T00:00:01.000Z' };
        const older = { ...row, id: 'history-older', createdAt: '2026-10-26T00:00:00.000Z' };
        let rows = [row, sibling];
        let olderRows = [older];
        const path = '/v1/account/saved-secrets/resources/activity/read';
        harness.answer(scope.serverId, path, { select: input => ({ body: input !== null && typeof input === 'object'
            && 'cursor' in input && typeof input.cursor === 'string' && input.cursor
            ? { items: olderRows, nextCursor: 'older-window-cursor' }
            : { items: rows, nextCursor: 'first-page-cursor' } }) });
        const hook = await renderHook(() => useSharedSavedSecretActivity({ scope, resourceId: 'secret-a', enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
        await act(async () => { hook.getCurrent().loadMore(); });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status === 'ready' && state.entries.length).toBe(3);
        });
        const before = hook.getCurrent().state;
        if (before.status !== 'ready') throw new Error('Expected visible history');
        const observedReads = harness.requestsFor(path).length;
        await act(async () => { for (let index = 0; index < 20; index++) {
            publishHomeAccountChange(scope.serverId, [savedSecretDisclosureActivityEntityIdV1('secret-b')],
                { source: 'socket', changeKinds: ['account'] });
        } });
        expect(harness.requestsFor(path)).toHaveLength(observedReads);
        rows = [{ ...row, copyOutcome: 'succeeded', copyRequestedAt: '2026-10-27T00:00:02.000Z' }, sibling];
        await act(async () => { publishHomeAccountChange(scope.serverId, [savedSecretDisclosureActivityEntityIdV1('secret-a')],
            { source: 'socket', changeKinds: ['account'] }); });
        await vi.waitFor(() => {
            const after = hook.getCurrent().state;
            expect(after.status === 'ready' && after.entries[0]?.copyOutcome).toBe('succeeded');
        });
        const after = hook.getCurrent().state;
        if (after.status !== 'ready') throw new Error('Expected refreshed visible history');
        expect(after.entries[0]).not.toBe(before.entries[0]);
        expect(after.entries[1]).toBe(before.entries[1]);
        expect(after.entries[2]).toBe(before.entries[2]);
        expect(after.nextCursor).toBe('older-window-cursor');
        // A resource hint names no changed entry: reconcile each consumed page.
        expect(harness.requestsFor(path)).toHaveLength(observedReads + 2);
        expect(JSON.stringify(after)).not.toContain('test-secret');
        olderRows = [{ ...older, copyOutcome: 'succeeded', copyRequestedAt: '2026-10-28T00:00:01.000Z' }];
        await act(async () => { publishHomeAccountChange(scope.serverId, [savedSecretDisclosureActivityEntityIdV1('secret-a')],
            { source: 'socket', changeKinds: ['account'] }); });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status === 'ready' && state.entries.at(-1)?.copyOutcome).toBe('succeeded');
        });
        const copiedOlder = hook.getCurrent().state;
        if (copiedOlder.status !== 'ready') throw new Error('Expected reconciled older Copy');
        expect(copiedOlder.entries[0]).toBe(after.entries[0]);
        expect(copiedOlder.entries[1]).toBe(after.entries[1]);
        expect(copiedOlder.entries[2]).not.toBe(after.entries[2]);
        // New disclosures prepend without discarding the consumed tail, and
        // another page still starts from the oldest consumed cursor.
        rows = [{ ...row, id: 'history-new', createdAt: '2026-10-28T00:00:00.000Z' }, rows[0]!];
        olderRows = [sibling, olderRows[0]!];
        await act(async () => { publishHomeAccountChange(scope.serverId, [savedSecretDisclosureActivityEntityIdV1('secret-a')],
            { source: 'socket', changeKinds: ['account'] }); });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status === 'ready' && state.entries[0]?.id).toBe('history-new');
        });
        const advanced = hook.getCurrent().state;
        if (advanced.status !== 'ready') throw new Error('Expected advanced history');
        expect(advanced.entries.map(entry => entry.id)).toEqual(['history-new', 'history-a', 'history-b', 'history-older']);
        const oldest = { ...older, id: 'history-oldest', createdAt: '2026-10-25T00:00:00.000Z' };
        olderRows = [oldest];
        await act(async () => { hook.getCurrent().loadMore(); });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status === 'ready' && state.entries.at(-1)?.id).toBe('history-oldest');
        });
        expect(harness.requestsFor(path).at(-1)?.input).toMatchObject({ cursor: 'older-window-cursor' });
    });

    it('attributes disclosure history to the current person without relabeling other or unknown actors', async () => {
        const { scope } = await mount(false);
        const { SharedSavedSecretHistory } = await import('@/components/secrets/SharedSavedSecretHistory');
        const { Item } = await import('@/components/ui/lists/Item');
        const row = { ref: entry('secret-a').ref, resourceRevision: 3, actorDisplayName: null,
            deviceId: 'other-device', createdAt: '2026-10-27T00:00:00.000Z', outcome: 'displayed' as const,
            copyOutcome: null, copyRequestedAt: null };
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/activity/read', { body: { items: [
            { ...row, id: 'own-unnamed-history', actorIsSelf: true },
            { ...row, id: 'named-history', actorDisplayName: 'History reviewer', actorIsSelf: false },
            { ...row, id: 'unnamed-history', actorIsSelf: false },
            // An older Home lacks the self fact. Missing identity is not evidence of self.
            { ...row, id: 'older-home-history' },
        ], nextCursor: null } });
        const screen = await renderScreen(<SharedSavedSecretHistory testID="disclosure-history-attribution"
            scope={scope} resourceId="secret-a" enabled />);
        const historyRows = () => screen.findAllByType(Item).filter(item =>
            /^disclosure-history-attribution:\d+$/.test(item.props.testID ?? ''));
        await vi.waitFor(() => expect(historyRows()).toHaveLength(4));
        expect(historyRows().map(item => item.props.subtitle)).toEqual([
            'message.accountActorYou · secretsSettings.historyOtherDevice',
            'History reviewer · secretsSettings.historyOtherDevice',
            'secretsSettings.historyUnknownActor · secretsSettings.historyOtherDevice',
            'secretsSettings.historyUnknownActor · secretsSettings.historyOtherDevice',
        ]);
        expect(screen.getTextContent()).not.toContain('test-secret');
        expect(writeClipboard).not.toHaveBeenCalled();
    });

    it.each(['scope', 'ref', 'revision', 'manage', 'mode'] as const)('refuses a pending Copy when its current %s changes before cleanup', async change => {
        const { scope, entries } = await mount(false);
        const { useSharedSavedSecretReveal } = await import('@/components/secrets/useSharedSavedSecretReveal');
        const activityPath = '/v1/account/saved-secrets/resources/activity';
        const copyPath = `${activityPath}/copy`;
        const response = createDeferred<void>();
        harness.answer(scope.serverId, activityPath, { body: { historyEntryId: 'disclosure-entry' } });
        harness.answer(scope.serverId, copyPath, { body: { historyEntryId: 'disclosure-entry' }, respondAfter: response.promise });
        // Keep the live projection mutable to expose the pre-passive-cleanup window,
        // rather than allowing the effect's Hide to make this assertion pass.
        const selected = { ...entries[0]!, capabilities: { ...entries[0]!.capabilities } };
        const selectedScope = { ...scope };
        const hook = await renderHook(() => useSharedSavedSecretReveal({ scope: selectedScope, entry: selected,
            confirmDisclosure: async () => true }));
        await act(async () => { await hook.getCurrent().reveal(); });
        expect(hook.getCurrent().state.status).toBe('revealed');
        let copied!: Promise<'succeeded' | 'refused' | 'outcome_unknown'>;
        await act(async () => { copied = hook.getCurrent().copy(); });
        await vi.waitFor(() => expect(harness.requestsFor(copyPath)).toHaveLength(1));
        if (change === 'scope') selectedScope.accountId = 'another-account';
        if (change === 'ref') selected.ref = entries[1]!.ref;
        if (change === 'revision') selected.revision = 4;
        if (change === 'manage') selected.capabilities.manageAccess = false;
        if (change === 'mode') selected.encryptionMode = 'e2ee';
        await act(async () => { response.resolve(); expect(await copied).toBe('refused'); });
        expect(writeClipboard).not.toHaveBeenCalled();
        expect(harness.requestsFor(copyPath)).toHaveLength(1);
    });

    it('presents a value-free refusal when the admitted disclosure is refused', async () => {
        const { scope, entries } = await mount(false);
        const { useSharedSavedSecretReveal } = await import('@/components/secrets/useSharedSavedSecretReveal');
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/activity', { status: 403, body: { error: 'forbidden' } });
        const hook = await renderHook(() => useSharedSavedSecretReveal({ scope, entry: entries[0]!,
            confirmDisclosure: async () => true }));
        await act(async () => { await hook.getCurrent().reveal(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'refused', reason: 'forbidden' });
        expect(JSON.stringify(hook.getCurrent().state)).not.toContain('test-secret');
        expect(writeClipboard).not.toHaveBeenCalled();
    });

    it('keeps display transient and copies only by a fresh person gesture on the same history entry', async () => {
        const { scope, entries } = await mount(false);
        const { useSharedSavedSecretReveal } = await import('@/components/secrets/useSharedSavedSecretReveal');
        const activityPath = '/v1/account/saved-secrets/resources/activity';
        const copyPath = `${activityPath}/copy`;
        harness.answer(scope.serverId, activityPath, { body: { historyEntryId: 'disclosure-entry' } });
        harness.answer(scope.serverId, copyPath, { body: { historyEntryId: 'disclosure-entry' } });
        confirm.mockResolvedValue(true);
        const hook = await renderHook(({ selected }) => useSharedSavedSecretReveal({ scope, entry: selected,
            confirmDisclosure: () => confirm('Reveal', selected.name ?? '') }), {
            initialProps: { selected: entries[0]! },
        });
        expect(hook.getCurrent().state.status).toBe('hidden');
        expect(writeClipboard).not.toHaveBeenCalled();
        await act(async () => { await hook.getCurrent().reveal(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'revealed', value: 'test-secret', historyEntryId: 'disclosure-entry' });
        expect(writeClipboard).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.getCurrent().copy()).toBe('succeeded'); });
        expect(writeClipboard.mock.calls).toEqual([['test-secret']]);
        expect(harness.requestsFor(copyPath).map(request => request.input)).toEqual([
            expect.objectContaining({ historyEntryId: 'disclosure-entry', outcome: 'requested' }),
            expect.objectContaining({ historyEntryId: 'disclosure-entry', outcome: 'succeeded' }),
        ]);
        expect(JSON.stringify(harness.requestsFor(activityPath).map(request => request.input))).not.toContain('test-secret');
        await hook.rerender({ selected: { ...entries[0]!, revision: 4 } });
        expect(hook.getCurrent().state.status).toBe('hidden');
        await act(async () => { expect(await hook.getCurrent().copy()).toBe('refused'); });
        expect(writeClipboard).toHaveBeenCalledTimes(1);
    });
});

describe('Saved Secrets editor continuity through the settings screen', () => {
    it('ignores unrelated Settings revisions while readiness and an opened sharing baseline stay current', async () => {
        const { screen, commits } = await mount(false);
        const { storage } = await import('@/sync/domains/state/storage');
        const { SecretsSettingsPage } = await import('./SecretsSettingsPage');
        commits.mockClear();
        for (let index = 0; index < 20; index += 1) {
            await act(async () => storage.setState(state => ({
                settings: { ...state.settings, showFlavorIcons: index % 2 === 0 }, settingsVersion: index + 2,
            })));
        }
        expect(commits).not.toHaveBeenCalled();
        await act(async () => storage.setState({ settingsVersion: null }));
        expect(screen.findByType(SecretsSettingsPage).props.onSharePersonal).toBeUndefined();
        await act(async () => storage.setState({ settingsVersion: 30 }));
        const share = screen.findByType(SecretsSettingsPage).props.onSharePersonal;
        expect(share).toBeTypeOf('function');
        await act(async () => share({ id: 'legacy-personal', name: 'Personal key', kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'private' }, createdAt: 1, updatedAt: 1 }));
        expect(screen.findByType(SecretsSettingsPage).props.accessEditor.element.props.target.expectedSettingsVersion).toBe(30);
        await act(async () => storage.setState({ settingsVersion: 31 }));
        expect(screen.findByType(SecretsSettingsPage).props.accessEditor.element.props.target.expectedSettingsVersion).toBe(30);
    });

    it('honors waived shared-secret deletion without a caller confirmation', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, true));
        const secret = entries[0]!;
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { body: { resourceId: 'secret-a' } });
        await openSecretPage(secret.ref);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:delete`);
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
        expect(confirm).not.toHaveBeenCalled();
    });
    it('captures the current deletion version at the gesture and refuses a retired Account callback', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, true));
        const { storage } = await import('@/sync/domains/state/storage');
        const { SecretsSettingsPage } = await import('./SecretsSettingsPage');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const remove = screen.findByType(SecretsSettingsPage).props.onDeleteShared;
        const version = storage.getState().settingsVersion;
        expect(version).not.toBeNull();
        await act(async () => {
            expect(await getSyncSingleton().mutateAccountSettingsOnce({
                expectedSettingsScope: scope, expectedSettingsVersion: version!,
                mutate: raw => ({ settings: { ...raw, showFlavorIcons: raw.showFlavorIcons !== true }, value: undefined }),
            })).toMatchObject({ status: 'applied' });
        });
        const currentVersion = storage.getState().settingsVersion;
        expect(currentVersion).toBeGreaterThan(version!);
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { body: { resourceId: 'secret-a' } });
        await act(async () => remove(entries[0]!));
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
        expect(harness.requestsFor(path)[0]?.input).toMatchObject({ expectedSettingsVersion: currentVersion });
        await act(async () => storage.setState({ settingsScope: { ...scope, accountId: 'another-account' } }));
        await act(async () => remove(entries[1]!));
        expect(harness.requestsFor(path)).toHaveLength(1);
    });
    it('honors explicit Account Ask for deletion, reviews the Inbox-executed failure, and asks again for the exact manual retry', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, false, false, true));
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().settings.actionsSettingsV1.actions['secrets.shared.delete']).toMatchObject({ approvalRequiredSurfaces: ['ui'] });
        const resource = createManagedResourceDependencyFixture();
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { select: input => input && typeof input === 'object' && 'managedResourceDispositions' in input
            ? { body: { resourceId: 'secret-a' } }
            : { status: 409, body: { error: 'managed_resources_review_required', resources: [resource] } } });
        confirm.mockResolvedValue(true);
        const secret = entries[0]!;
        await openSecretPage(secret.ref);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:delete`);
        const artifacts = harness.artifacts(scope.serverId);
        await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
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
        const { readApprovalExecutionFailure } = await import('@happier-dev/protocol/approvals/approvalExecutionFailure');
        expect(readApprovalExecutionFailure(readApproval(firstId))).toMatchObject({
            errorCode: 'managed_resources_review_required',
            details: { error: 'managed_resources_review_required', resources: [resource] },
        });
        await vi.waitFor(() => expect(confirm, JSON.stringify({
            localStatus: storage.getState().artifacts[firstId]?.header?.approvalStatus,
            localBodyAvailable: typeof storage.getState().artifacts[firstId]?.body === 'string',
            approvalReads: harness.requestsFor(`/v1/artifacts/${firstId}`).length,
            alerts: alert.mock.calls.map(([title]) => title),
        })).toHaveBeenCalledTimes(1));
        expect(confirm.mock.calls[0]?.[1]).toContain('native-1');
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
        const { SecretsSettingsPage } = await import('./SecretsSettingsPage');
        const resource = createManagedResourceDependencyFixture();
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const originalLifetime = captureActiveServerAccountScopeLifetime();
        expect(originalLifetime?.isCurrent()).toBe(true);
        const path = '/v1/account/saved-secrets/resources/delete';
        harness.answer(scope.serverId, path, { select: input => input && typeof input === 'object' && 'managedResourceDispositions' in input
            ? { status: 500, body: { error: 'unknown' } }
            : { status: 409, body: { error: 'managed_resources_review_required', resources: [resource] } } });
        confirm.mockImplementationOnce(async () => {
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
        } else await openSecretPage(secret.ref);
        await screen.pressByTestIdAsync(deleteTestId);
        await vi.waitFor(() => expect(harness.requestsFor(path)).not.toHaveLength(0));
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(confirm.mock.calls[0]?.[1]).toContain('native-1');
        const accepted = choice === 'manual' || choice === 'corrupt';
        if (accepted) await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
        if (choice === 'retired') await vi.waitFor(() => {
            expect(screen.findByType(SecretsSettingsPage).props.scope).toEqual({ ...scope, accountId: 'account-next' });
        });
        await vi.waitFor(() => expect(screen.findByType(SecretsSettingsPage).props.sharedMutationsDisabled).toBe(false));
        const requests = harness.requestsFor(path);
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
        await openSecretPage(secret.ref);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:rename`);
        expect(harness.requestsFor(path)).toHaveLength(0);
        await act(async () => screen.changeTextByTestId(`saved-secret:${secret.ref}:edit-input`, '  Renamed key  '));
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:edit-save`);
        await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
        expect(harness.requestsFor(path)[0]?.input).toEqual(expect.objectContaining({
            resourceId, expectedRevision: 3, displayName: 'Renamed key',
            storedContent: { storage: { kind: 'value' }, t: 'plain', v: { v: 1, name: 'Renamed key', kind: 'apiKey', value: 'original-secret' } },
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
            storedContent: { storage: { kind: 'value' }, t: 'plain', v: { v: 1, name: 'secret-a', kind: 'apiKey', value: '  exact replacement\n' } },
        }));
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.ref}:edit-input`)).toBeNull());
    });

    it('settles an acknowledged rename while the Saved Secret material refresh is pending', async () => {
        const { screen, scope, entries } = await mount(false, true, scope => initializeRemovalSettings(scope, false, true));
        const secret = entries[0]!;
        const revalidation = createDeferred<void>();
        let acknowledged = false;
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { select: async () => {
            if (acknowledged) await revalidation.promise;
            return { body: { resources: [materialFor(acknowledged ? { ...secret, name: 'Acknowledged name', revision: 4 } : secret)] } };
        } });
        harness.answer(scope.serverId, '/v1/account/saved-secrets/resources/update', { select: () => {
            acknowledged = true;
            return { body: { resourceId: 'secret-a', revision: 4 } };
        } });
        await openSecretPage(secret.ref);
        await screen.pressByTestIdAsync(`saved-secret:${secret.ref}:rename`);
        await act(async () => screen.changeTextByTestId(`saved-secret:${secret.ref}:edit-input`, 'Acknowledged name'));
        try {
            await act(async () => screen.pressByTestId(`saved-secret:${secret.ref}:edit-save`));
            await vi.waitFor(() => expect(acknowledged).toBe(true));
            await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.ref}:edit-input`)).toBeNull());
            expect(screen.getTextContent()).toContain('Acknowledged name');
        } finally {
            await act(async () => { revalidation.resolve(); });
        }
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
        await openSecretThroughList(screen, entries[1]!.ref);
        expect(alert).toHaveBeenCalledOnce();
        const buttons = alert.mock.calls[0]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => buttons.find((button) => button.style === 'cancel')?.onPress?.());
        // A is still editing and opening B was declined.
        expect(screen.findByTestId(`saved-secret:${entries[1]!.ref}:manageAccess`)).toBeNull();
        expect(screen.findByTestId(`saved-secret:${entries[0]!.ref}:manageAccess`)).toBeNull();
        await openSecretThroughList(screen, entries[1]!.ref);
        const discardButtons = alert.mock.calls[1]?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => discardButtons.find((button) => button.style === 'destructive')?.onPress?.());
        await followPushedSecretRoute();
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
        await openSecretPage(ref);
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
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

describe('Saved Secret reveal leaf on the Saved Secrets page', () => {
    const activityPath = '/v1/account/saved-secrets/resources/activity';
    const historyPath = `${activityPath}/read`;
    function answerDisclosure(serverId: string) {
        harness.answer(serverId, activityPath, { body: { historyEntryId: 'disclosure-entry' } });
        harness.answer(serverId, `${activityPath}/copy`, { body: { historyEntryId: 'disclosure-entry' } });
        harness.answer(serverId, historyPath, { body: { items: [{ id: 'history-a', ref: entry('secret-a').ref, resourceRevision: 3,
            actorDisplayName: 'Owner', deviceId: 'device-elsewhere', createdAt: '2026-10-27T00:00:00.000Z', outcome: 'displayed',
            copyOutcome: 'succeeded', copyRequestedAt: '2026-10-27T00:00:01.000Z' }], nextCursor: null } });
    }

    it('reveals after the person confirms, copies only on the explicit gesture, shows history and forgets the value on hide', async () => {
        const { screen, scope, entries } = await mount(false);
        answerDisclosure(scope.serverId);
        const ref = entries[0]!.ref;
        await openSecretPage(ref);
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:history:0`)).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('test-secret');

        await screen.pressByTestIdAsync(`saved-secret:${ref}:value-reveal`);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(activityPath)).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('test-secret');

        confirm.mockResolvedValue(true);
        await screen.pressByTestIdAsync(`saved-secret:${ref}:value-reveal`);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('test-secret'));
        expect(writeClipboard).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync(`saved-secret:${ref}:value-copy`);
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:value-copied`)).not.toBeNull());
        expect(writeClipboard.mock.calls).toEqual([['test-secret']]);
        expect(harness.requestsFor(`${activityPath}/copy`).map(request => request.input)).toEqual([
            expect.objectContaining({ historyEntryId: 'disclosure-entry', outcome: 'requested' }),
            expect.objectContaining({ historyEntryId: 'disclosure-entry', outcome: 'succeeded' }),
        ]);

        await screen.pressByTestIdAsync(`saved-secret:${ref}:value-reveal`);
        expect(screen.getTextContent()).not.toContain('test-secret');
        expect(screen.findByTestId(`saved-secret:${ref}:value-copy`)).toBeNull();
        expect(writeClipboard).toHaveBeenCalledTimes(1);
    });

    it('offers no reveal where the person cannot manage the secret or this device cannot read it', async () => {
        const { screen, scope, entries } = await mount(false);
        answerDisclosure(scope.serverId);
        const [useOnly, unreadable] = entries;
        await act(async () => applySavedSecretCatalogPage({ scope, observedAt: 2, entries: [
            { ...useOnly!, capabilities: { ...useOnly!.capabilities, manageAccess: false } },
            { ...unreadable!, materialStatus: 'preparing_encrypted_access' },
        ] }));
        await openSecretPage(useOnly!.ref);
        await openSecretPage(unreadable!.ref);
        expect(screen.findByTestId(`saved-secret:${useOnly!.ref}:value-reveal`)).toBeNull();
        expect(screen.findByTestId(`saved-secret:${unreadable!.ref}:value-reveal`)).toBeNull();
        expect(screen.findByTestId(`saved-secret:${unreadable!.ref}:value-unavailable`)).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.requestsFor(activityPath)).toHaveLength(0);
        // History is metadata: a manager still sees it while the value is unreadable here; use-only sees none.
        expect(screen.findByTestId(`saved-secret:${useOnly!.ref}:history`)).toBeNull();
        expect(screen.findByTestId(`saved-secret:${unreadable!.ref}:history`)).not.toBeNull();
    });

    it('says a refused reveal showed nothing and keeps the value masked', async () => {
        const { screen, scope, entries } = await mount(false);
        harness.answer(scope.serverId, activityPath, { status: 403, body: { error: 'forbidden' } });
        harness.answer(scope.serverId, historyPath, { body: { items: [], nextCursor: null } });
        const ref = entries[0]!.ref;
        confirm.mockResolvedValue(true);
        await openSecretPage(ref);
        await screen.pressByTestIdAsync(`saved-secret:${ref}:value-reveal`);
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:value-refused`)).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('test-secret');
        expect(screen.findByTestId(`saved-secret:${ref}:value-copy`)).toBeNull();
        expect(writeClipboard).not.toHaveBeenCalled();
    });
});

/** Opens a secret's own page the way the Credentials rail and the Secrets list do: through the route. */
async function openSecretPage(ref: string) {
    const { router } = await import('expo-router');
    await act(async () => { router.setParams({ secret: ref }); });
}

/** Opens a secret from the list the way a person does: through the screen's guarded navigation. */
async function openSecretThroughList(screen: Awaited<ReturnType<typeof renderScreen>>, ref: string) {
    const { SecretsSettingsPage } = await import('./SecretsSettingsPage');
    await act(async () => { screen.findByType(SecretsSettingsPage).props.onOpenSecret(ref); });
}

/** The router boundary does not navigate; apply the secret route the screen last pushed. */
async function followPushedSecretRoute() {
    const { router } = await import('expo-router');
    const calls: ReadonlyArray<readonly unknown[]> = vi.mocked(router.push).mock.calls;
    const href = String(calls.at(-1)?.[0] ?? '');
    const secret = new URLSearchParams(href.split('?')[1] ?? '').get('secret');
    expect(secret).not.toBeNull();
    await openSecretPage(secret!);
}
