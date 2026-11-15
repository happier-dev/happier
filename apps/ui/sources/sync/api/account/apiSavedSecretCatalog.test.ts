import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as catalog from './apiSavedSecretCatalog';
import type { ServerFetch } from '@/sync/http/client';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture, createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { BrowserPasskeysApplyV1Schema } from '@happier-dev/protocol/browser/profile/v1';
import { importSavedSecretPasskeysInContext, importBrowserProfileLoginsInContext } from '@/sync/ops/actions/browserProfileLoginsImport';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { invalidateSavedSecretCatalogProjection, observeSavedSecretCatalog, refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { applyPlannedChangeActions } from '@/sync/runtime/orchestration/changesApplier';
import { planSyncActionsFromChanges, plannedChangesAffectProfileCatalog } from '@/sync/runtime/orchestration/changesPlanner';
import { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { readRetainedAccountSettingsRawSnapshot } from '@/sync/engine/settings/accountSettingsRawSnapshot';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, buildProfilePhysicalKey } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
// Cold source-graph loading belongs to collection, after installing transport
// boundaries. Keep the hook budget for actual per-suite setup and behavior.
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    await connection?.dispose();
    connection = null;
});

describe('SavedSecret catalog captured request boundary', () => {
    it('captures reference revisions from metadata without acquiring Secret contents', async () => {
        const entry = SavedSecretCatalogEntryV1Schema.parse({ ref: 'happier:shared-secret:v1:reference-only', source: 'shared_resource', relationship: 'owner',
            name: 'Reference key', kind: 'token', revision: 7, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
        let resources: unknown[] = [entry];
        const request = vi.fn((async path => {
            expect(path).toBe('/v1/account/saved-secrets/resources');
            return Response.json({ resources });
        }) satisfies ServerFetch);
        const context = { serverId: 'home-a', accountId: 'reference-owner', credentials: { token: createAccountTokenForTests('reference-owner') },
            request, assertCurrent() {}, resolveAccountMode: async () => 'plain' as const,
            resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }) };
        await expect(catalog.captureSavedSecretReferenceRevisionsInContext(context, { references: [entry.ref] })).resolves.toEqual({
            referencedSavedSecretIds: [entry.ref], savedSecretRevisions: [{ resourceId: 'reference-only', expectedRevision: 7 }],
        });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/saved-secrets/resources']);
        await expect(catalog.captureSavedSecretReferenceRevisionsInContext(context, { references: [entry.ref],
            selectedSecrets: [{ ref: entry.ref, resourceRevision: 6 }] })).resolves.toMatchObject({
            savedSecretRevisions: [{ resourceId: 'reference-only', expectedRevision: 6 }],
        });
        for (const unavailable of [[], [{ ...entry, capabilities: { ...entry.capabilities, use: false } }],
            [{ ...entry, materialStatus: 'temporarily_unavailable' }]]) {
            resources = unavailable;
            await expect(catalog.captureSavedSecretReferenceRevisionsInContext(context, { references: [entry.ref] })).rejects.toThrow('saved-secret-unavailable');
        }
    });

    it('reads selectable metadata without requiring a resource material wrapper', async () => {
        const entry = SavedSecretCatalogEntryV1Schema.parse({ ref: 'happier:shared-secret:v1:metadata-only', source: 'shared_resource', relationship: 'owner',
            name: 'Metadata key', kind: 'token', revision: 2, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
        const request = vi.fn((async path => {
            expect(path).toBe('/v1/account/saved-secrets/resources');
            return Response.json({ resources: [entry] });
        }) satisfies ServerFetch);
        await expect(catalog.readSavedSecretCatalogMetadataInContext({ serverId: 'home-a', accountId: 'metadata-owner',
            request, assertCurrent: () => {} })).resolves.toEqual({ ok: true, resources: [entry] });
    });

    it.each(['plain', 'e2ee'] as const)('reads %s passkey contents once for selected references and keeps scalar consumers closed', async mode => {
        const ref = 'happier:shared-secret:v1:passkey';
        const secret = new Uint8Array(32).fill(11);
        const dataKey = new Uint8Array(32).fill(7);
        const credentials: AuthCredentials = mode === 'plain' ? { token: createAccountTokenForTests('passkey-owner') }
            : { token: createAccountTokenForTests('passkey-owner'), secret: encodeBase64(secret, 'base64url') };
        const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : null;
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
        const content = { v: 2 as const, name: 'Example passkey', kind: 'other' as const, source: {
            kind: 'passkey' as const, rpId: 'login.example', credentialId: 'Y3JlZGVudGlhbA==', userHandle: 'dXNlcg==',
            privateKey: 'a2V5', algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true,
        } };
        const storedContent = mode === 'plain' ? sealSavedSecretResourceStoredContentV1({ resourceId: 'passkey', mode, content })
            : sealSavedSecretResourceStoredContentV1({ resourceId: 'passkey', mode, content, resourceDataKey: dataKey,
                randomBytes: length => new Uint8Array(length).fill(3) });
        const recipientEnvelope = mode === 'plain' ? null : {
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey,
                randomBytes: length => new Uint8Array(length).fill(5) })),
            recipientContentPublicKeyFingerprint: snapshot.contentPublicKeyFingerprint,
        };
        let canUse = true;
        let denied = false;
        let current = true;
        let materialReads = 0;
        const context = { serverId: 'home-a', accountId: 'passkey-owner', credentials,
            resolveAccountMode: async () => mode,
            resolveAccountEncryption: async () => ({ accountMode: mode, encryption }),
            assertCurrent: () => { if (!current) throw new Error('account changed'); },
            request: (async path => {
                if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
                materialReads++;
                if (denied) return Response.json({ error: 'forbidden' }, { status: 403 });
                return Response.json({ resources: [{ resourceId: 'passkey', encryptionMode: mode, recipientEnvelope, storedContent,
                    entry: { ref, source: 'shared_resource', relationship: 'owner', name: content.name, kind: content.kind, revision: 2,
                        materialStatus: 'ready', capabilities: { use: canUse, rename: true, rotate: true, manageAccess: true, delete: true } } }] });
            }) satisfies ServerFetch,
        };
        const read = catalog.readSavedSecretContentsInContext;
        const opened = await read(context, [ref]);
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error('Expected admitted content');
        expect(opened.contents.get(ref)).toMatchObject({ content, revision: 2,
            entry: { ref, relationship: 'owner', revision: 2 } });
        await expect(catalog.readSavedSecretReferenceInContext(context, ref)).resolves.toEqual({ ok: false, reason: 'unavailable' });
        const imported = { status: 'completed', records: [{ domain: 'login.example', name: 'Example passkey', status: 'imported' }] };
        const rpc = vi.fn(async (call: Readonly<{ machineId: string; method: string; input: unknown }>) => {
            expect(call.machineId).toBe('machine-a');
            if (!BrowserPasskeysApplyV1Schema.parse(call.input).credentials.length) return { status: 'completed', records: [] };
            expect(BrowserPasskeysApplyV1Schema.parse(call.input)).toEqual({ browserSessionId: 'session-a', viewId: 'view-a',
                profileId: 'profile-a', credentials: [content.source] });
            return imported;
        });
        const input = { kind: 'passkeys' as const, machineId: 'machine-a', browserSessionId: 'session-a', viewId: 'view-a',
            profileId: 'profile-a', refs: [ref, ref] };
        materialReads = 0;
        const nativeRequests: unknown[] = [];
        await expect(importSavedSecretPasskeysInContext(context, input, async call => {
            nativeRequests.push(call.input);
            return { status: 'unavailable', code: 'passkey_import_unavailable' };
        })).resolves.toEqual({ status: 'unavailable', code: 'passkey_import_unavailable' });
        expect(materialReads).toBe(0);
        expect(nativeRequests).toEqual([{ browserSessionId: 'session-a', viewId: 'view-a', profileId: 'profile-a', credentials: [] }]);
        materialReads = 0;
        await expect(importSavedSecretPasskeysInContext(context, input, rpc)).resolves.toEqual(imported);
        // Duplicate selected refs share one material read after one destination probe.
        expect(materialReads).toBe(1);
        expect(rpc).toHaveBeenCalledTimes(2);
        // Exercise the shared Action's admitted UI host port with real content/envelope
        // owners. Only the HTTP and native Machine RPC boundaries are replaced.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            browserProfileLoginsImport: ({ input, context: invocation }) =>
                importBrowserProfileLoginsInContext(context, input, rpc, invocation.signal),
        }));
        const invocation = { surface: 'ui' as const, authority: 'present_user' as const, bypassApprovals: true };
        materialReads = 0;
        await expect(executor.execute('browser.profile.logins.import', input, invocation))
            .resolves.toMatchObject({ ok: true, result: imported });
        expect(materialReads).toBe(1);
        const unsupported = { status: 'completed', records: [{ domain: 'login.example', name: 'Example passkey',
            status: 'failed', code: 'source_format_unsupported', reason: 'this passkey tracks a usage counter' }] };
        rpc.mockResolvedValueOnce({ status: 'completed', records: [] }).mockResolvedValueOnce(unsupported);
        await expect(executor.execute('browser.profile.logins.import', input, invocation))
            .resolves.toMatchObject({ ok: true, result: unsupported });
        rpc.mockClear();
        materialReads = 0;
        await expect(executor.execute('browser.profile.logins.import', { kind: 'cookies', machineId: 'machine-a',
            browserSessionId: 'session-a', viewId: 'view-a', profileId: 'profile-a', sourceMachineId: 'source-a',
            sites: ['https://login.example'] }, invocation))
            .resolves.toMatchObject({ ok: true, result: { status: 'needs_source' } });
        expect(materialReads).toBe(0);
        expect(rpc).not.toHaveBeenCalled();
        rpc.mockClear();
        materialReads = 0;
        await expect(importSavedSecretPasskeysInContext(context, { ...input, refs: [] }, rpc)).resolves.toEqual({ status: 'completed', records: [] });
        expect(materialReads).toBe(0);
        expect(rpc).not.toHaveBeenCalled();
        canUse = false;
        await expect(read(context, [ref])).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(importSavedSecretPasskeysInContext(context, input, rpc)).resolves.toEqual({ status: 'unavailable', code: 'source_unavailable' });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(BrowserPasskeysApplyV1Schema.parse(rpc.mock.calls[0]![0].input).credentials).toEqual([]);
        rpc.mockClear();
        canUse = true;
        denied = true;
        await expect(read(context, [ref])).resolves.toEqual({ ok: false, reason: 'unavailable' });
        denied = false;
        current = false;
        await expect(read(context, [ref])).resolves.toEqual({ ok: false, reason: 'changed' });
        const cancelled = new AbortController(); cancelled.abort();
        await expect(importSavedSecretPasskeysInContext(context, input, rpc, cancelled.signal)).resolves.toEqual({ status: 'unavailable', code: 'canceled' });
        expect(rpc).not.toHaveBeenCalled();
    });
    it.each([
        { status: 401, kind: 'unauthorized', domain: 'secrets' }, { status: 403, kind: 'forbidden', domain: 'secrets' },
        { status: 401, kind: 'unauthorized', domain: 'profiles' }, { status: 403, kind: 'forbidden', domain: 'profiles' },
        { status: 401, kind: 'unauthorized', domain: 'folders' }, { status: 403, kind: 'forbidden', domain: 'folders' },
    ] as const)(
        'settles $domain admission HTTP $status with its typed cause before recovery', async ({ status, kind, domain }) => {
        const accountId = `saved-secret-denied-${domain}-${status}`;
        let denied = true;
        let materialReads = 0;
        const connect = () => restoreServerAccountForTest({ serverUrl: `https://saved-secret-denied-${domain}-${status}.test`, accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async rawUrl => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
                if (path.startsWith('/v1/features')) return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') return denied ? Response.json({ error: kind }, { status })
                    : Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return denied ? Response.json({ error: kind }, { status })
                    : Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/saved-secrets/resources/materials') { materialReads++; return Response.json({ resources: [] }); }
                if (path === '/v2/account/settings') return Response.json({ version: 0, content: { t: 'plain', v: {} } });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        connection = await connect();
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        if (domain !== 'secrets') {
            const read = domain === 'profiles' ? (await import('./apiProfileCatalog')).readProfileCatalogProjection
                : (await import('./apiPromptLibraryCatalog')).readPromptLibraryCatalogProjection;
            const result = await read(scope);
            expect(await TokenStorage.getCredentialsForServerUrl(connection.home.serverUrl, { serverId: scope.serverId }) === null).toBe(status === 401);
            expect(result).toMatchObject({ catalog: { status: 'unavailable', reason: status === 401 ? 'scope-retired' : kind } });
            return;
        }
        await refreshSavedSecretCatalog(scope).catch(() => {});
        expect(await TokenStorage.getCredentialsForServerUrl(connection.home.serverUrl, { serverId: scope.serverId }) === null).toBe(status === 401);
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'error', stale: true,
            data: null, error: status === 401 ? { kind: 'invalid', code: 'scope-retired', retryable: false }
                : { kind, code: kind, retryable: false } });
        denied = false;
        // A terminal authorization refusal needs restored Home admission, not a
        // reinterpretation of the captured refused lifetime as current.
        await connection.dispose();
        connection = await connect();
        const restoredScope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        await refreshSavedSecretCatalog(restoredScope);
        expect(getSavedSecretCatalogSnapshot(restoredScope)).toMatchObject({ status: 'ready', stale: false, data: [], error: null });
        expect(materialReads).toBeGreaterThan(0);
    });
    it.each(['plain', 'e2ee'] as const)('opens only the selected Home-managed Plain resource keylessly in a %s Account and refuses mismatched material', async accountMode => {
        const ref = 'happier:shared-secret:v1:ssh-password';
        let current = true;
        let wrongMode = false;
        const materialReads: string[] = [];
        const context = { serverId: 'home-a', accountId: 'account-a',
            credentials: { token: createAccountTokenForTests('account-a') },
            resolveAccountMode: async () => accountMode,
            resolveAccountEncryption: async () => { throw new Error('Plain resource must not request Account keys'); },
            assertCurrent: () => { if (!current) throw Object.assign(new Error('changed'), { code: 'action_account_scope_changed' }); },
            request: (async path => {
                if (path === '/v1/account/encryption') return Response.json({ mode: accountMode, updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                materialReads.push(String(path));
                return Response.json({ resources: [{ resourceId: 'ssh-password', encryptionMode: wrongMode ? 'e2ee' : 'plain',
                    recipientEnvelope: null, storedContent: { t: 'plain', v: { v: 1, name: 'SSH', kind: 'password', value: 'private-password' } },
                    entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH', kind: 'password', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] });
            }) satisfies ServerFetch,
        };
        const read = 'readSavedSecretReferenceInContext' in catalog ? catalog.readSavedSecretReferenceInContext : undefined;
        expect(typeof read).toBe('function');
        if (typeof read !== 'function') throw new Error('missing_admitted_saved_secret_reference_reader');
        await expect(read(context, ref)).resolves.toEqual({ ok: true, value: 'private-password', revision: 1 });
        expect(materialReads).toEqual(['/v1/account/saved-secrets/resources/materials?resourceId=ssh-password']);
        wrongMode = true;
        await expect(read(context, ref)).resolves.toEqual({ ok: false, reason: 'unavailable' });
        current = false;
        await expect(read(context, ref)).resolves.toEqual({ ok: false, reason: 'changed' });
    });

    it('acquires and opens only the selected reference batch', async () => {
        const row = (id: string) => ({ resourceId: id, encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: id, kind: 'password', value: `${id}-value` } },
            entry: { ref: `happier:shared-secret:v1:${id}`, source: 'shared_resource', relationship: 'owner', name: id, kind: 'password',
                revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
        const rows = ['login-a', 'login-b', ...Array.from({ length: 6 }, (_, index) => `unrelated-${index}`)].map(row);
        const reads: string[] = [];
        const context = { serverId: 'home-a', accountId: 'account-a',
            credentials: { token: createAccountTokenForTests('account-a') },
            resolveAccountMode: async () => 'plain' as const,
            resolveAccountEncryption: async () => { throw new Error('Plain resources must not request Account keys'); },
            assertCurrent: () => {},
            request: (async path => {
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                reads.push(String(path));
                const selected = new URL(String(path), 'https://home.invalid').searchParams.getAll('resourceIds');
                return Response.json({ resources: selected.length ? rows.filter(candidate => selected.includes(candidate.resourceId)) : rows });
            }) satisfies ServerFetch,
        };
        const read = await catalog.readSavedSecretContentsInContext(context,
            ['happier:shared-secret:v1:login-a', 'happier:shared-secret:v1:login-b']);
        expect(read.ok && [...read.contents.keys()]).toEqual(['happier:shared-secret:v1:login-a', 'happier:shared-secret:v1:login-b']);
        expect(reads).toEqual(['/v1/account/saved-secrets/resources/materials?resourceIds=login-a&resourceIds=login-b']);
    });

    it('requires exact managed revision admission for person disclosure through the incumbent reader', async () => {
        const ref = 'happier:shared-secret:v1:managed-login';
        let canManage = true;
        const reads: string[] = [];
        const context = { serverId: 'home-a', accountId: 'owner',
            credentials: { token: createAccountTokenForTests('owner') },
            resolveAccountMode: async () => 'plain' as const,
            resolveAccountEncryption: async () => { throw new Error('plain disclosure must not request keys'); },
            assertCurrent: () => {},
            request: (async path => {
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                reads.push(String(path));
                return Response.json({ resources: [{ resourceId: 'managed-login', encryptionMode: 'plain', recipientEnvelope: null,
                    storedContent: { t: 'plain', v: { v: 1, name: 'Login', kind: 'password', value: 'private-login' } },
                    entry: { ref, source: 'shared_resource', relationship: canManage ? 'owner' : 'recipient', name: 'Login', kind: 'password',
                        revision: 2, materialStatus: 'ready', capabilities: { use: true, rename: canManage, rotate: canManage,
                            manageAccess: canManage, delete: canManage } } }] });
            }) satisfies ServerFetch,
        };
        await expect(catalog.readSavedSecretReferenceInContext(context, ref, undefined,
            { expectedRevision: 2, requireManage: true })).resolves.toEqual({ ok: true, value: 'private-login', revision: 2 });
        expect(reads).toEqual(['/v1/account/saved-secrets/resources/materials?resourceId=managed-login&expectedRevision=2&requireManage=true']);
        await expect(catalog.readSavedSecretReferenceInContext(context, ref, undefined,
            { expectedRevision: 1, requireManage: true })).resolves.toEqual({ ok: false, reason: 'changed' });
        canManage = false;
        await expect(catalog.readSavedSecretReferenceInContext(context, ref, undefined,
            { expectedRevision: 2, requireManage: true })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    });

    it('uses an admitted caller request without opening a second Account authority and refuses malformed metadata', async () => {
        let malformed = false;
        const request: ServerFetch = async (path) => {
            expect(path).toBe('/v1/account/saved-secrets/resources/materials');
            return Response.json(malformed ? { resources: [{ resourceId: 'invalid' }] } : { resources: [] });
        };
        const context = { serverId: 'home-a', accountId: 'account-a', request, assertCurrent: () => {} };
        const read = 'readSavedSecretCatalogInContext' in catalog ? catalog.readSavedSecretCatalogInContext : undefined;
        expect(typeof read).toBe('function');
        if (typeof read !== 'function') throw new Error('missing_captured_saved_secret_reader');
        await expect(read(context)).resolves.toEqual({ ok: true, resources: [] });
        malformed = true;
        await expect(read(context)).resolves.toMatchObject({ ok: false, failure: { kind: 'invalid' } });
    });

    describe('incumbent loaded material demand', () => {

    it('publishes retained-source diagnostics from actual material demand while keeping current resources usable', async () => {
        const accountId = 'saved-secret-demand-account';
        const homeId = 'srv_saved_secret_demand';
        const ref = 'happier:shared-secret:v1:current';
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: homeId } } });
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        let raw: Record<string, unknown> = { secrets: [{ id: 'future-material', name: 'Future', kind: 'token', createdAt: 1, updatedAt: 1,
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque' } } }] };
        let resourceRevision = 1;
        let sourceVersion = 4;
        const writes: string[] = [];
        const reads = new Map<string, number>();
        const socketUpdates = new Set<(update: unknown) => void>();
        const resourceMutationPaths = new Set<string>(Object.values(SHARED_SAVED_SECRET_ACTION_PATHS_V1));
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://saved-secret-demand.test', serverIdentityId: homeId, accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            configureSocket: socket => {
                socketUpdates.add(update => {
                    // Socket.IO delivers incoming events to both catch-all and
                    // named listeners; ApiSocket owns its wire dispatch onAny.
                    for (const listener of socket.listenersAny()) listener('update', update);
                    for (const listener of socket.listeners('update')) listener(update);
                });
                configureConnectedServerSocketBoundary(socket);
            },
            request: async (rawUrl, init) => {
                const path = new URL(String(rawUrl)).pathname;
                reads.set(path, (reads.get(path) ?? 0) + 1);
                if (init?.method === 'POST' && (resourceMutationPaths.has(path) || path === '/v2/account/settings'
                    || path === '/v1/artifacts' || path.endsWith('/mutate'))) writes.push(path);
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: raw }, version: sourceVersion });
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                    resourceId: 'current', encryptionMode: 'plain', recipientEnvelope: null,
                    storedContent: { t: 'plain', v: { v: 1, name: `Current ${resourceRevision}`, kind: 'token', value: 'current-private' } },
                    entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                        name: `Current ${resourceRevision}`, kind: 'token', revision: resourceRevision, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }] });
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        // Measure settled-Home demand independently of legitimate restore and
        // initial Settings publication. Retire only this fixture's loader state.
        await refreshSavedSecretCatalog(scope);
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport)
            .toMatchObject({ status: 'pending', reason: 'source-uncharacterized' }));
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        const materialReadBaseline = reads.get('/v1/account/saved-secrets/resources/materials') ?? 0;
        const sourceReadBaseline = reads.get('/v2/account/settings') ?? 0;
        const modeReadPaths = ['/v1/account/encryption/currentness', '/v1/account/encryption'];
        const modeReadBaseline = modeReadPaths.map(path => reads.get(path) ?? 0);
        const releases = Array.from({ length: 32 }, () => observeSavedSecretCatalog(scope));
        const release = () => releases.forEach(dispose => dispose());
        try {
            await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready',
                legacyImport: { status: 'pending', reason: 'source-uncharacterized' } }));
            expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready',
                secret: { id: ref, encryptedValue: { _isSecretValue: true, value: 'current-private' } } });
            expect(writes).toEqual([]);
            expect((reads.get('/v1/account/saved-secrets/resources/materials') ?? 0) - materialReadBaseline).toBe(1);
            // Passive discovery reuses the settled Sync document; mutation
            // admission still reads the Settings authority.
            expect((reads.get('/v2/account/settings') ?? 0) - sourceReadBaseline).toBe(0);
            // P03 R3: a material load on a connected Home borrows the held Account observation.
            expect(modeReadPaths.map((path, index) => (reads.get(path) ?? 0) - modeReadBaseline[index]!)).toEqual([0, 0]);
            const before = getSavedSecretCatalogSnapshot(scope);
            const machineChanges = planSyncActionsFromChanges([{ cursor: 1, kind: 'machine', entityId: 'machine-a', changedAt: 1 }]);
            for (let index = 0; index < 20; index += 1) publishHomeAccountChange(scope.serverId, ['machine-a'], {
                changeKinds: ['machine'], accountSettingsAffects: false,
                profileCatalogAffects: plannedChangesAffectProfileCatalog(machineChanges),
            });
            expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready' });
            expect(getSavedSecretCatalogSnapshot(scope)).toBe(before);
            const measuredPaths = ['/v1/account/encryption/currentness', '/v1/account/encryption',
                '/v1/account/saved-secrets/resources/materials', '/v2/account/settings'];
            const readCounts = () => measuredPaths.map(path => reads.get(path) ?? 0);
            const idleReads = readCounts();
            for (let index = 0; index < 20; index += 1) {
                // An early content-free wake carries no new material. The
                // subsequent Artifact receipt also changes no Saved Secret.
                publishHomeAccountChange(scope.serverId, undefined, { source: 'catch-up-pending' });
                publishHomeAccountChange(scope.serverId, [`approval-artifact-${index}`], { changeKinds: ['artifact'] });
                publishHomeAccountChange(scope.serverId, [buildProfilePhysicalKey(`profile-${index}`)], {
                    source: 'socket', changeKinds: ['account'], sessionSystemRecords: [],
                    accountSettingsAffects: false, profileCatalogAffects: true,
                });
                publishHomeAccountChange(scope.serverId, undefined, { accountSettingsAffects: false,
                    profileCatalogAffects: false, savedSecretCatalogAffects: false });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            const idleWakeReads = readCounts().map((count, index) => count - idleReads[index]!);
            expect(idleWakeReads).toEqual([0, 0, 0, 0]);
            expect(getSavedSecretCatalogSnapshot(scope)).toBe(before);
            const resourceChanges = planSyncActionsFromChanges([{ cursor: 2, kind: 'savedSecretResource', entityId: 'current', changedAt: 2 }]);
            const beforeResourceReads = readCounts();
            resourceRevision = 2;
            publishHomeAccountChange(scope.serverId, ['current'], {
                changeKinds: ['savedSecretResource'],
                profileCatalogAffects: plannedChangesAffectProfileCatalog(resourceChanges),
            });
            expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'temporarily_unavailable' });
            await vi.waitFor(() => {
                expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', stale: false,
                    legacyImport: { status: 'pending', reason: 'source-uncharacterized' } });
                expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready' });
                expect(getSavedSecretCatalogSnapshot(scope)?.data?.[0]).toMatchObject({ name: 'Current 2', revision: 2 });
            });
            // No known legacy candidates means no history mutation admission.
            // The resource wake reuses the settled Settings source and mode proof.
            expect(readCounts()[0]! - beforeResourceReads[0]!).toBe(0);
            const directChangeReads = readCounts().map((count, index) => count - beforeResourceReads[index]!);
            expect(directChangeReads[1]).toBe(0);
            expect(directChangeReads[2]).toBe(1);
            expect(directChangeReads[3]).toBe(0);
            const beforeSourceReads = readCounts();
            raw = { secrets: [] };
            sourceVersion += 1;
            // A live Account observation receives the new document through the
            // socket owner before its catalog wake; changing only HTTP fixture
            // bytes would leave Sync's admitted document at the previous head.
            const sourceUpdate = UpdateContainerSchema.parse({ id: `source-${sourceVersion}`, seq: sourceVersion, createdAt: sourceVersion,
                body: { t: 'update-account', id: accountId,
                    settingsV2: { content: { t: 'plain', v: raw }, version: sourceVersion },
                    encryptionCurrentness: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }) } });
            expect(socketUpdates.size).toBeGreaterThan(0);
            for (const deliver of socketUpdates) deliver(sourceUpdate);
            await vi.waitFor(() => expect(readRetainedAccountSettingsRawSnapshot(scope))
                .toMatchObject({ version: sourceVersion, raw }));
            publishHomeAccountChange(scope.serverId, ['self'], { changeKinds: ['account'], accountSettingsAffects: true });
            await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', stale: false,
                legacyImport: { status: 'complete' } }));
            expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready' });
            expect(readCounts()[2]! - beforeSourceReads[2]!).toBe(1);
            expect(readCounts()[3]! - beforeSourceReads[3]!).toBe(0);
            // The focused change applier also awaits materialization before it
            // checkpoints. Its Home publication is not a second read demand.
            const focusedReads = readCounts();
            const focusedChanges = planSyncActionsFromChanges([{ cursor: 3, kind: 'savedSecretResource', entityId: 'current', changedAt: 3 }]);
            const unexpectedDomainWork = () => { throw new Error('unexpected_non_secret_domain_work'); };
            const applied = await applyPlannedChangeActions({
                planned: focusedChanges, credentials: connection.credentials,
                isSessionMessagesLoaded: unexpectedDomainWork,
                invalidate: { savedSecretResources: () => invalidateSavedSecretCatalogProjection(scope) },
                publishAccountChanges: (changes, materialization) => {
                    expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'temporarily_unavailable' });
                    publishHomeAccountChange(scope.serverId, changes.map(change => change.entityId), {
                        changeKinds: changes.map(change => change.kind),
                        profileCatalogAffects: plannedChangesAffectProfileCatalog(focusedChanges),
                        ...(materialization?.savedSecretResourcesRefreshStarted
                            ? { savedSecretResourcesRefreshStarted: true as const } : {}),
                    });
                },
                invalidateMessagesForSession: unexpectedDomainWork,
                invalidateScmStatusForSession: unexpectedDomainWork,
                applyTodoSocketUpdates: unexpectedDomainWork,
                kvBulkGet: unexpectedDomainWork,
            });
            expect(applied).toMatchObject({ status: 'complete', safeAdvanceCursor: '3' });
            await vi.waitFor(() => {
                expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', stale: false,
                    legacyImport: { status: 'complete' } });
                // P03 R3: catalog projections borrow the held Account observation.
                expect(readCounts()[1]! - focusedReads[1]!).toBe(0);
                expect(readCounts()[3]! - focusedReads[3]!).toBe(0);
            });
            expect(readCounts()[0]! - focusedReads[0]!).toBe(0);
            expect(readCounts()[2]! - focusedReads[2]!).toBe(1);
            console.info(JSON.stringify({ contract: 'saved-secret-demand-reads', paths: measuredPaths,
                idleWakes: 20, idleReads: idleWakeReads, directChangeReads,
                focusedChangeReads: readCounts().map((count, index) => count - focusedReads[index]!) }));
            publishHomeAccountChange(scope.serverId);
            expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'temporarily_unavailable' });
            await refreshSavedSecretCatalog(scope);
            await vi.waitFor(() => expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready' }));
        } finally { release(); }
    });

    it.each(['personal', 'legacy-inference'] as const)('retries retained %s history through explicit maintenance without replaying an acknowledged import', async sourceKind => {
        const accountId = 'saved-secret-history-account';
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        const secret = { id: 'old-token', name: 'Old', kind: 'token', createdAt: 1, updatedAt: 2,
            encryptedValue: { _isSecretValue: true, value: 'old-private' } };
        const inference = sourceKind === 'legacy-inference';
        let raw: Record<string, unknown> = { ...(inference ? { inferenceOpenAIKey: 'old-private', preferredLanguage: 'fr' } : { secrets: [secret] }), actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'] } }) };
        let version = 4;
        let retained: AccountSettingsStoredContentEnvelope | null = { t: 'plain', v: raw };
        const resources: unknown[] = [];
        const promotions: unknown[] = [];
        const historyWrites: unknown[] = [];
        let historyAttempts = 0;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://saved-secret-history.test',
            serverIdentityId: 'srv_saved_secret_history', accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async (rawUrl, init) => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }));
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: raw }, version });
                if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                    complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] });
                if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
                if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
                // This Account has no rows in the other reference domains. Model
                // explicit wire absence, not an unsupported HTTP boundary.
                if ((init?.method ?? 'GET') === 'GET' && [REMOTE_HOST_ROWS_ROUTE_V1,
                    NOTIFICATION_CHANNELS_ROUTE_V1,
                    MCP_SERVER_CATALOG_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
                    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`,
                    `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`].includes(path)) {
                    return Response.json({ status: 'absent' });
                }
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [{ version: 4,
                    createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(retained).length }] });
                if (path === '/v2/account/settings/history/4') return Response.json({ version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: retained });
                if (path === '/v2/account/settings/history/4/mutate') {
                    historyAttempts++;
                    if (historyAttempts === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
                    const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body)));
                    historyWrites.push(mutation);
                    if (mutation.operation.kind !== 'normalize') throw new Error('Expected canonical history normalization');
                    retained = mutation.operation.content;
                    return Response.json({ status: 'applied' });
                }
                if (path === '/v1/account/saved-secrets/resources/promote') {
                    const mutation = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init?.body)));
                    promotions.push(mutation);
                    if (mutation.nextSettings?.t !== 'plain') throw new Error('Expected Plain source mutation');
                    raw = mutation.nextSettings.v;
                    resources.push({ resourceId: mutation.resourceId, encryptionMode: 'plain', storedContent: mutation.storedContent,
                        recipientEnvelope: null, entry: { ref: `happier:shared-secret:v1:${mutation.resourceId}`, source: 'shared_resource',
                            relationship: 'owner', ownerAccountId: accountId, name: mutation.displayName, kind: mutation.kind, revision: 1,
                            materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
                    return Response.json({ resourceId: mutation.resourceId, settingsVersion: ++version });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        await refreshSavedSecretCatalog(scope);
        await vi.waitFor(() => {
            expect(promotions).toHaveLength(1);
            expect(historyAttempts).toBe(1);
            expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport).toMatchObject({ status: 'pending' });
        });
        expect(promotions).toHaveLength(1);
        const promotion = SharedSavedSecretPromoteInputV1Schema.parse(promotions[0]);
        expect(promotion.referenceCensus).toMatchObject({
            remoteHosts: { revision: 'absent', resourceRefs: [] },
            notificationChannels: { revision: 'absent', resourceRefs: [] },
            catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent',
                connectedConfigurations: 'absent', connectedPurposes: 'absent', registrySources: 'absent' },
        });
        const ref = `happier:shared-secret:v1:${promotion.resourceId}`;
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready',
            secret: { encryptedValue: { _isSecretValue: true, value: 'old-private' } } });
        if (inference) {
            expect(raw).not.toHaveProperty('inferenceOpenAIKey');
            expect(raw).toHaveProperty('preferredLanguage', 'fr');
            expect(raw).not.toHaveProperty('secretBindingsByProfileId');
            expect(promotion.profileMutations).toEqual([]);
        }
        expect(historyAttempts).toBe(1);
        expect(historyWrites).toHaveLength(0);
        // Drop process-local demand custody; retry must derive only canonical source/resource facts.
        resetSavedSecretCatalogEngineForTests();
        await refreshSavedSecretCatalog(scope);
        // Current material demand stays independent of retained history once the
        // source was transferred. Explicit migration still owes its cleanup.
        expect(historyAttempts).toBe(1);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
        const account = await captureLazyActionAccountContext(scope.serverId);
        try { await importLegacySavedSecretsInContext(account, await account.resolveAccountMode(), scope); }
        finally { account.dispose(); }
        await vi.waitFor(() => expect(historyWrites).toHaveLength(1));
        expect(promotions).toHaveLength(1);
        if (inference) {
            expect(retained).toMatchObject({ t: 'plain', v: { preferredLanguage: 'fr' } });
            if (retained.t !== 'plain') throw new Error('Expected Plain retained source');
            expect(retained.v).not.toHaveProperty('inferenceOpenAIKey');
            expect(historyWrites[0]).toMatchObject({ operation: { savedSecretTransfers: [{
                source: { kind: 'legacy-inference-openai-key' }, resourceId: promotion.resourceId, expectedRevision: 1,
            }] } });
        } else expect(retained).toMatchObject({ t: 'plain', v: { secrets: [] } });
    });
    });
});
