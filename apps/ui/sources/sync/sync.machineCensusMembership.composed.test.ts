import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, countStoreNotifications, flushHookEffects } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { publishMachineContributionRegistryProjectionRefresh, publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { Socket } from 'socket.io-client';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { InvalidateSync } from '@/utils/sessions/sync';
import { projectLegacySessionAccessCapabilitiesV1, projectSessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await disposeHome?.(); disposeHome = undefined;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
});

describe('Machine census membership through public Sync and real stores', () => {
    it.each(['plain', 'e2ee'] as const)('keeps a fresh %s embed Machine wake inside its existing Session corridor without repeating the initial snapshot', async (encryptionMode) => {
        const { sync } = await import('@/sync/sync');
        const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
        const encryption = await createEmbedEncryption();
        const sessionDataKey = new Uint8Array(32).fill(61);
        const [{ sealEncryptedDataKeyEnvelopeV1}, { sealSessionOwnerMetadataEnvelopeV1}, { SessionOwnerMetadataV1Schema}] = await Promise.all([import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'), import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1'), import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1')]);
        const sessionKey = encryptionMode === 'e2ee' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey, recipientPublicKey: decodeBase64(encryption.embedPublicKey, 'base64url'),
            randomBytes: length => new Uint8Array(length).fill(62),
        }), 'base64') : undefined;
        const writer = await Encryption.create(new Uint8Array(32).fill(63));
        await writer.initializeSessions(new Map([['embed-wake', sessionDataKey]]));
        const cipher = writer.getSessionEncryption('embed-wake')!;
        const metadata = encryptionMode === 'e2ee'
            ? await cipher.encryptRaw(projectSessionSharedMetadataV1({ metadata: { flavor: 'codex' } }))
            : JSON.stringify({ path: '/repo', host: 'test', name: 'Embedded' });
        const messages = encryptionMode === 'e2ee' ? [{ id: 'first-input', seq: 1, localId: null, createdAt: 1,
            messageRole: 'user', content: { t: 'encrypted', c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: 'Analyse this lead' } }) } }] : [];
        writer.removeSessionEncryption('embed-wake');
        const sessionRecord = SessionCurrentProjectionRecordV1Schema.parse({
            id: 'embed-wake', createdAt: 1, updatedAt: 1, seq: messages.length, active: false, activeAt: 0,
            encryptionMode, dataEncryptionKey: null, metadataLayoutVersion: encryptionMode === 'e2ee' ? 1 : 0,
            metadataVersion: 1, metadata,
            ...(encryptionMode === 'e2ee' ? { ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
                ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { path: '/repo' } }),
                material: { type: 'legacy', secret: new Uint8Array(32).fill(63) },
                randomBytes: length => new Uint8Array(length).fill(64),
            }) } : {}),
            agentStateVersion: 0, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: encryptionMode === 'e2ee'
                ? { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }
                : { v: 1, level: 'view', sources: [], capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }) },
        });
        const requests: string[] = [];
        let cursor = 40;
        const { AccountApiTokenSelfV1Schema } = await import('@happier-dev/protocol/auth/accountApiTokens');
        const initialConfig = { v: 1 as const, ui: { attachments: true }, newChat: null,
            organization: { folderId: null, tagIds: [] }, style: null };
        let embedConfig: typeof import('@happier-dev/protocol/embed')['EmbedConfigV1'] = initialConfig;
        let holdSelf: Promise<void> | null = null;
        let socket: Socket | undefined;
        const boundary = installDisconnectedServerSocketBoundary(current => { socket = current; });
        vi.stubGlobal('window', { location: { pathname: '/embed/session/embed-wake' }, localStorage: globalThis.localStorage,
            addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            requests.push(url.pathname);
            if (url.pathname === '/v1/auth/api-tokens/self') {
                const response = Response.json(AccountApiTokenSelfV1Schema.parse({
                accountId: 'embed-wake-account', accountEncryptionMode: encryptionMode,
                credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
                grant: { v: 1, actions: { families: ['session_transcripts'], ids: [] },
                    targets: { sessions: ['embed-wake'], machines: [] }, approve: false,
                    origins: ['https://allowed.example'], models: null, permissionModes: null, create: null }, embedConfig,
                }));
                if (holdSelf) await holdSelf;
                return response;
            }
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v2/cursor') return Response.json({ cursor, changesFloor: 0 });
            // A child Session credential cannot read the Account's Machine feed.
            if (url.pathname === '/v2/changes') return Response.json({ changes: [], nextCursor: cursor });
            if (url.pathname === '/v2/sessions/embed-wake') return Response.json({ session: sessionRecord });
            if (url.pathname === '/v1/sessions/embed-wake/turns') return Response.json({ v: 1, sessionId: 'embed-wake', updatedAt: 1, turns: [] });
            if (url.pathname === '/v1/sessions/embed-wake/messages') return Response.json({ messages, nextAfterSeq: null });
            if (url.pathname === '/v2/sessions/embed-wake/pending') return Response.json({ pending: [], pendingVersion: 0 });
            throw new Error(`Account request escaped embed: ${url.pathname}`);
        }));
        const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
        const endpointUrl = 'https://embed-wake.example.test';
        const runtime = createEmbedSessionRuntime({ encryption, endpointUrl });
        // Observe the real public hydration result without replacing or repeating admission.
        const hydrateSession = vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute');
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', sessionId: 'embed-wake', credential: {
                token: 'hap_v1_child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
                ...(sessionKey ? { sessionKey } : {}),
            } });
            const admission = hydrateSession.mock.results[0];
            const hydrationResult = admission?.type === 'return' ? await admission.value : undefined;
            expect(runtime.getSnapshot().phase, JSON.stringify({ error: runtime.getSnapshot().error,
                hydrationResult, requests })).toBe('ready');
            expect(requests.filter(path => path === '/v2/cursor')).toHaveLength(1);
            expect(requests.indexOf('/v2/cursor')).toBeLessThan(requests.indexOf('/v2/sessions/embed-wake'));
            requests.length = 0;
            // The ready embed already owns its exact reader; warm route acquisition must
            // hand that reader to the same snapshot owner without another HTTP request.
            const { resolveHydratedServerIdForRouteResult } = await import('@/hooks/session/routeHydrationSnapshot');
            let readSessionEncryption: (() => ReturnType<Encryption['getSessionEncryption']>) | undefined;
            const hydrated = await sync.ensureSessionVisibleForMessageRoute('embed-wake', {
                serverId: endpointUrl,
                onHydratedSessionReader: read => { readSessionEncryption = read; },
            });
            expect(storage.getState().sessionMessages['embed-wake']?.isLoaded).toBe(true);
            if (encryptionMode === 'e2ee') expect(storage.getState().sessionMessages['embed-wake']?.messageIdsOldestFirst).toHaveLength(1);
            expect(hydrated.kind).toBe('available');
            if (hydrated.kind !== 'available') throw new Error('Expected an admitted Session');
            if (encryptionMode === 'e2ee') {
                expect(resolveHydratedServerIdForRouteResult('embed-wake', endpointUrl, hydrated)).toBeNull();
            }
            expect(resolveHydratedServerIdForRouteResult('embed-wake', endpointUrl, hydrated, readSessionEncryption)).toBe(endpointUrl);
            expect(requests).toEqual([]);
            cursor = 41;
            const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
            for (const listener of socket!.listenersAny()) listener('update', UpdateContainerSchema.parse({
                id: 'embed-machine-wake', seq: 1, createdAt: 1,
                body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['not-in-child-scope'] },
            }));
            await sync.resumeSync('changes-catch-up');
            expect(requests.filter(path => path !== '/v2/changes')).toEqual([]);
            expect(requests.filter(path => path === '/v2/changes')).toHaveLength(1);
            const before = runtime.getSnapshot();
            requests.length = 0;
            embedConfig = { ...initialConfig, ui: { attachments: false }, style: { v: 1, mode: 'dark' } };
            for (const listener of socket!.listenersAny()) listener('ephemeral', { type: 'api-token-embed-config-changed' });
            await vi.waitFor(() => expect(runtime.getSnapshot().self?.embedConfig).toEqual(embedConfig));
            expect(runtime.getSnapshot().credential).toBe(before.credential);
            expect(runtime.getSnapshot().presentationTargetKey).toBe(before.presentationTargetKey);
            expect(runtime.getSnapshot().phase).toBe('ready');
            expect(requests).toEqual(['/v1/auth/api-tokens/self']);
            let publications = 0;
            const unsubscribe = runtime.subscribe(() => { publications += 1; });
            for (const listener of socket!.listenersAny()) listener('ephemeral', { type: 'api-token-embed-config-changed' });
            await vi.waitFor(() => expect(requests).toHaveLength(2));
            await flushHookEffects();
            expect(publications).toBe(0);
            unsubscribe();
            const heldRead = createDeferred<void>();
            holdSelf = heldRead.promise;
            requests.length = 0;
            const wake = () => { for (const listener of socket!.listenersAny()) listener('ephemeral', { type: 'api-token-embed-config-changed' }); };
            wake();
            await vi.waitFor(() => expect(requests).toHaveLength(1));
            embedConfig = { ...initialConfig, style: { v: 1, mode: 'light' } };
            for (let index = 0; index < 10; index += 1) wake();
            expect(requests).toHaveLength(1);
            holdSelf = null;
            heldRead.resolve();
            await vi.waitFor(() => expect(runtime.getSnapshot().self?.embedConfig).toEqual(embedConfig));
            expect(requests).toEqual(['/v1/auth/api-tokens/self', '/v1/auth/api-tokens/self']);
            runtime.dispose();
            requests.length = 0;
            wake();
            await flushHookEffects();
            expect(requests).toEqual([]);
        } finally {
            hydrateSession.mockRestore();
            runtime.dispose();
            sync.disposeEmbedSession();
            boundary.dispose();
            installDisconnectedServerSocketBoundary();
            vi.unstubAllGlobals();
        }
    });

    it('keeps a fresh Account Machine wake row-scoped instead of repeating the bootstrap snapshot', async () => {
        const accountId = 'machine-wake-cost-account';
        let fleet = Array.from({ length: 137 }, (_, index) => createPlainMachineRowFixture({ id: `wake-${index}`, accountId }));
        let revision = 0;
        const requests: string[] = [];
        const rowReadEntered = createDeferred<void>();
        const releaseRowReads = createDeferred<void>();
        let holdRowReads = false;
        let socket: Socket | undefined;
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const restored = await restoreServerAccountForTest({
            serverUrl: 'https://machine-wake-cost.example.test', accountId,
            configureSocket: current => {
                socket = current;
                configureConnectedServerSocketBoundary(current);
                vi.spyOn(current, 'timeout').mockReturnValue(current);
                // The real transport ACK binds method absence to this issued
                // call; another socket cannot make this daemon support it.
                vi.spyOn(current, 'emitWithAck').mockImplementation(async event => event === 'rpc-call'
                    ? { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
                    : { v: 1, ok: true, admittedSessionIds: [] });
            },
            request: async (input, init) => {
                const url = new URL(String(input));
                requests.push(url.pathname);
                if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
                if (url.pathname === '/v2/cursor') return Response.json({ cursor: revision, changesFloor: 0 });
                if (url.pathname === '/v2/changes') return Response.json({ changes: Number(url.searchParams.get('after')) < revision
                    ? [{ cursor: revision, kind: 'machine', entityId: 'wake-0', changedAt: revision, hint: null }] : [], nextCursor: revision });
                if (url.pathname === '/v1/machines') return Response.json(fleet);
                if (url.pathname === '/v1/machines/read-batch') {
                    if (holdRowReads) { rowReadEntered.resolve(); await releaseRowReads.promise; }
                    return createMachineReadBatchResponseFixture(init?.body, id => fleet.find(row => row.id === id) ?? null);
                }
                if (url.pathname === '/v1/artifacts') return Response.json([]);
                if (url.pathname === '/v1/friends' || url.pathname === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
                if (url.pathname === '/v1/kv') return Response.json({ items: [] });
                return createEmptyAccountBootstrapHttpResponse(url.pathname, init);
            },
        });
        disposeHome = restored.dispose;
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await sync.refreshMachines();
        const queues = sync as unknown as { settingsSync: InvalidateSync; profileSync: InvalidateSync;
            machinesSync: InvalidateSync; sessionsSync: InvalidateSync; artifactsSync: InvalidateSync; pluginAvailabilitySync: InvalidateSync };
        await Promise.all([queues.settingsSync, queues.profileSync, queues.machinesSync, queues.sessionsSync,
            queues.artifactsSync, queues.pluginAvailabilitySync].map(queue => queue.awaitQueue()));
        expect(requests.filter(path => path === '/v2/cursor')).toHaveLength(1);
        expect(storage.getState().machines['wake-0']?.daemonStateVersion).toBe(fleet[0]!.daemonStateVersion);
        const accountSocket = socket!;
        expect(accountSocket.listenersAny().length).toBeGreaterThan(0);
        const { probeSessionHandoffSourceReachability } = await import('@/sync/domains/sessionHandoff/probeSessionHandoffSourceReachability');
        const untouched = storage.getState().machines['wake-136'];
        const initialRequests = [...requests];
        requests.length = 0;
        revision = 1;
        const daemonState = encodePlainMachineStoredContent({ status: 'running', pid: 42 });
        fleet = fleet.map(row => row.id === 'wake-0' ? { ...row, daemonState,
            daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 } : row);
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        // H30 delivers a real row record before its same-entity feed wake.
        for (const listener of accountSocket.listenersAny()) listener('update', UpdateContainerSchema.parse({
            id: 'one-machine-record', seq: 1, createdAt: 1, body: { t: 'update-machine', machineId: 'wake-0',
                daemonState: { value: daemonState, version: fleet[0]!.daemonStateVersion! } },
        }));
        await vi.waitFor(() => expect(storage.getState().machines['wake-0']?.daemonState?.pid).toBe(42));
        holdRowReads = true;
        const wake = UpdateContainerSchema.parse({ id: 'one-machine-wake', seq: 1, createdAt: 1,
            body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['wake-0'] } });
        for (const listener of accountSocket.listenersAny()) listener('update', wake);
        // A cold SDK need not have dialed yet. The wake's public catch-up owner
        // is independently callable and owns the same cursor/repair decision.
        const catchUp = sync.resumeSync('changes-catch-up');
        void catchUp.catch(() => {});
        await rowReadEntered.promise;
        // The open Session's real handoff query exercises issued method absence,
        // not a synthetic independent force-scoped fresh read.
        const handoff = probeSessionHandoffSourceReachability({ serverId: restored.serverId, sourceMachineId: 'wake-0' });
        try { await flushHookEffects({ cycles: 20, turns: 2 }); }
        finally { releaseRowReads.resolve(); }
        expect(await handoff).toBe('unavailable');
        await catchUp;
        expect(requests.filter(path => path === '/v1/machines' || path === '/v1/machines/read-batch'),
            JSON.stringify(requests)).toHaveLength(1);
        expect(requests.filter(path => path === '/v1/machines')).toHaveLength(0);
        expect(requests.filter(path => path === '/v1/machines/read-batch')).toHaveLength(1);
        await catchUp;
        expect(storage.getState().machines['wake-0']?.daemonStateVersion).toBe(fleet[0]!.daemonStateVersion);
        expect(requests.filter(path => ['/v2/cursor', '/v2/account/settings', '/v1/account/profile', '/v1/artifacts', '/v2/sessions'].includes(path))).toEqual([]);
        expect(storage.getState().machines['wake-136']).toBe(untouched);
        expect(Object.keys(storage.getState().machines)).toHaveLength(137);
        expect(initialRequests.filter(path => path === '/v2/cursor')).toHaveLength(1);
        for (const snapshotPath of ['/v2/account/settings', '/v1/account/profile', '/v1/machines']) {
            expect(initialRequests.indexOf('/v2/cursor')).toBeLessThan(initialRequests.indexOf(snapshotPath));
        }
        // A later same-Home bootstrap must replay the persisted checkpoint,
        // not replace it with a newly captured server base.
        requests.length = 0;
        await sync.switchServer(restored.credentials);
        await sync.awaitBootstrapForegroundAcquisition();
        // Settle the real switch's incumbent resume before its Home is retired;
        // no pending recovery may cross into the next cold fixture's transport.
        await sync.resumeSync('changes-catch-up');
        await Promise.all([queues.settingsSync, queues.profileSync, queues.machinesSync, queues.sessionsSync,
            queues.artifactsSync, queues.pluginAvailabilitySync].map(queue => queue.awaitQueue()));
        expect(requests.filter(path => path === '/v2/cursor')).toHaveLength(0);
    });

    it('hydrates the CLOUD10 controller through connection, reconnect and a same-Home switch while retiring withdrawn Account material', async () => {
        // CLOUD10 captured IDs/version facts only;
        // all Account material and encrypted content below are synthetic.
        const fact = { id: '8af4e544-25b4-4d2a-a5e2-5cf759e40b46', installationId: '204630bf-252c-4541-b841-2413b155c606', metadataVersion: 3128, revision: 383 };
        const accountId = 'encrypted-census-account';
        let accountMode: 'plain' | 'e2ee' = 'e2ee';
        const secret = new Uint8Array(32).fill(17);
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature`,
            secret: encodeBase64(secret, 'base64url') };
        const publisher = await Encryption.create(secret);
        const key = new Uint8Array(32).fill(29);
        const envelope = encodeBase64(await publisher.encryptEncryptionKey(key), 'base64');
        const fixture = createMachineFixture({ id: fact.id, seq: 0, activeAt: Date.now(),
            daemonState: { status: 'running' }, installationId: fact.installationId,
            metadataVersion: fact.metadataVersion, operationProtocolCapabilitiesRevision: fact.revision,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } });
        const codec = await publisher.openEncryption(key);
        const [metadata, daemonState] = await codec.encrypt([fixture.metadata, fixture.daemonState]);
        const row = { ...createPlainMachineRowFixture({ id: fixture.id, accountId, machine: fixture }),
            metadata: encodeBase64(metadata!, 'base64'), daemonState: encodeBase64(daemonState!, 'base64'),
            storageMode: 'e2ee' as const, dataEncryptionKey: envelope,
            keyBasis: { dataEncryptionKey: envelope, metadataVersion: fixture.metadataVersion, daemonStateVersion: fixture.daemonStateVersion },
            access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId, displayName: 'Test Account' },
                role: 'manage', resourceMode: 'e2ee', accessState: 'ready' }) };
        let socket: Socket | undefined;
        const restored = await restoreServerAccountForTest({ serverUrl: 'https://encrypted-census.example.test', accountId, credentials,
            configureSocket: current => { socket = current; configureConnectedServerSocketBoundary(current); },
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: accountMode, updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(accountMode === 'plain'
                    ? createPlainAccountEncryptionCurrentnessFixture() : createLegacyAccountEncryptionCurrentnessFixture({ secret }));
                if (path === '/v1/machines') return Response.json([row]);
                return null;
            },
        });
        disposeHome = restored.dispose;
        const { sync } = await import('@/sync/sync');
        const { resolveScopedAccountEncryption } = await import('@/sync/encryption/scopedAccountEncryption');
        const resolveEncryption = () => resolveScopedAccountEncryption({ serverId: restored.serverId,
            serverUrl: 'https://encrypted-census.example.test', credentials });
        const encryption = await resolveEncryption();
        await sync.refreshMachines();
        expect(storage.getState().machines[row.id]).toMatchObject({ metadata: fixture.metadata,
            daemonState: fixture.daemonState, installationId: row.installationId, availability: { kind: 'available' } });
        expect(encryption?.getMachineEncryptionContext(row.id)?.isCurrent()).toBe(true);
        const retained = storage.getState().machines[row.id];
        socket!.disconnect(); socket!.connect();
        await sync.refreshMachines();
        expect(await resolveEncryption()).toBe(encryption);
        expect(encryption?.getMachineEncryptionContext(row.id)?.isCurrent()).toBe(true);
        expect(storage.getState().machines[row.id]).toBe(retained);
        await sync.switchServer(credentials);
        await sync.refreshMachines();
        expect(storage.getState().machines[row.id]).toMatchObject({ metadata: fixture.metadata,
            installationId: row.installationId, metadataVersion: fact.metadataVersion,
            operationProtocolCapabilitiesRevision: fact.revision,
            operationProtocolCapabilities: fixture.operationProtocolCapabilities, availability: { kind: 'available' } });
        const { isManagedControllerCandidate } = await import('@/components/settings/machines/managed/useManagedControllerScope');
        expect(isManagedControllerCandidate(storage.getState().machines[row.id]!)).toBe(true);
        expect(storage.getState().machineListByServerId[restored.serverId]?.find(machine => machine.id === row.id))
            .toBe(storage.getState().machines[row.id]);
        const switchedEncryption = await resolveEncryption();
        const context = switchedEncryption!.getMachineEncryptionContext(row.id)!;
        expect(context.isCurrent()).toBe(true);
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        // Invalidation without an admitted mode change may retain material.
        // Actual persisted withdrawal must still retire the controller context.
        accountMode = 'plain';
        invalidateAccountEncryptionModeCache({ serverId: restored.serverId });
        expect(await resolveEncryption()).toBeNull();
        expect(context.isCurrent()).toBe(false);
    });

    it('orders held census membership and withdraws shared access on a complete current census without republishing equal rows', async () => {
        const accountId = 'census-account';
        const rows = Array.from({ length: 173 }, (_, index) => createPlainMachineRowFixture({
            id: `census-${index}`, accountId: index === 172 ? 'census-custodian' : accountId,
            machine: createMachineFixture({ id: `census-${index}`, activeAt: Date.now() }),
        }));
        let census = rows;
        let hold: ReturnType<typeof createDeferred<void>> | null = null;
        const entered = createDeferred<void>();
        const restored = await restoreServerAccountForTest({
            serverUrl: 'https://census-membership.example.test', accountId,
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/machines') {
                    const captured = census;
                    if (hold) { entered.resolve(); await hold.promise; }
                    return Response.json(captured);
                }
                return null;
            },
        });
        disposeHome = restored.dispose;
        const { sync } = await import('@/sync/sync');
        await sync.refreshMachines();
        const serverId = restored.serverId;
        const before = storage.getState();
        expect(Object.values(before.machines)).toHaveLength(173);
        let target = before.machines[rows[172]!.id]!;
        expect(target.isShared).toBe(true);
        expect(target.revokedAt).toBeNull();
        const heartbeatAt = target.activeAt + 1;
        const display = before.machineDisplayById[target.id];
        const notifications = countStoreNotifications(storage);
        const release = createDeferred<void>();
        let pending: Promise<void> | undefined;
        try {
            publishMachineContributionRegistryProjectionRefresh(serverId);
            publishMachineContributionRegistryProjectionRefresh('another-home');
            publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: target.id }, 'authority');
            storage.getState().applyMachineActivityUpdates([{ id: target.id, active: true, activeAt: heartbeatAt }], { sourceServerId: serverId });
            expect(storage.getState().machines).toBe(before.machines);
            expect(storage.getState().machineListByServerId).toBe(before.machineListByServerId);
            notifications.reset();

            // The network captured an older census before a newer Machine
            // sequence was published. That membership cannot be overwritten.
            census = rows.slice(0, 172);
            hold = release;
            pending = sync.refreshMachines();
            await entered.promise;
            storage.getState().applyMachines([{ ...target, seq: target.seq + 1 }], false, { sourceServerId: serverId });
            target = storage.getState().machines[target.id]!;
            const newer = storage.getState();
            notifications.reset();
            release.resolve(); await pending; hold = null;
            expect.soft(storage.getState().machines[target.id]).toBe(target);
            expect.soft(storage.getState().machineDisplayById[target.id]).toBe(display);
            expect.soft(storage.getState().machineListByServerId[serverId]).toHaveLength(173);
            expect.soft(storage.getState().machines).toBe(newer.machines);
            expect.soft(storage.getState().machineListByServerId).toBe(newer.machineListByServerId);
            expect.soft(notifications.read().filter(fields => fields.some(field =>
                ['machines', 'machineDisplayById', 'machineListByServerId'].includes(field)))).toHaveLength(0);
            expect.soft(readMachineActivity(target).activeAt).toBe(heartbeatAt);

            census = rows.map(row => row.id === target.id ? { ...row, seq: target.seq } : row);
            await sync.refreshMachines();
            expect(storage.getState().machines[target.id]).toBe(target);
            expect(storage.getState().machineListByServerId[serverId]).toHaveLength(173);

            // A later complete current census withdraws shared access without revocation.
            census = census.slice(0, 172);
            await sync.refreshMachines();
            expect(storage.getState().machines[target.id]).toBeUndefined();
            expect(storage.getState().machineDisplayById[target.id]).toBeUndefined();
            expect(storage.getState().machineListByServerId[serverId]).toHaveLength(172);
            expect(storage.getState().machines[rows[0]!.id]).toBe(before.machines[rows[0]!.id]);
            expect(storage.getState().machineDisplayById[rows[0]!.id]).toBe(before.machineDisplayById[rows[0]!.id]);
            notifications.reset();
            await sync.refreshMachines();
            expect(notifications.read().filter(fields => fields.some(field =>
                ['machines', 'machineDisplayById', 'machineListByServerId'].includes(field)))).toHaveLength(0);

            // includeRevoked returns an owned revoked row; revoked foreign
            // rows are omitted by the real access projection, not returned.
            const revokedId = rows[171]!.id;
            census = census.map(row => row.id === revokedId ? { ...row, revokedAt: Date.now() } : row);
            await sync.refreshMachines();
            expect(storage.getState().machines[revokedId]?.revokedAt).toBeTypeOf('number');
            expect(storage.getState().machineListByServerId[serverId]?.find(row => row.id === revokedId)?.revokedAt).toBeTypeOf('number');
            census = census.slice(0, 171);
            await sync.refreshMachines();
            expect(storage.getState().machines[revokedId]).toBeUndefined();
            expect(storage.getState().machineListByServerId[serverId]).toHaveLength(171);
            census = [];
            await sync.refreshMachines();
            expect(Object.keys(storage.getState().machines)).toHaveLength(0);
            expect(Object.keys(storage.getState().machineDisplayById)).toHaveLength(0);
            expect(storage.getState().machineListByServerId[serverId]).toEqual([]);
        } finally { release.resolve(); await pending; notifications.stop(); }
    });
});
