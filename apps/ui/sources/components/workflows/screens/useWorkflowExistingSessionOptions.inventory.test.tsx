import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createCompactSessionListFetchBoundary, createCompactSessionListRowFixture, createSessionListSourceFixture, createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

// Compile the real Sync graph outside individual case IO budgets, with its
// canonical SDK transport boundary installed before importing the singleton.
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

// Real layout-1 wire producers: ordinary lists may leave content unopened;
// explicit metadata inventory and detail admission use the same Account material.
async function encryptedSessionFixture(id: string, accountId: string, progressBytes = 0, continuable = true, hidden = false) {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { encodeBase64 } = await import('@/encryption/base64');
    const secret = new Uint8Array(32).fill(9);
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
        secret: encodeBase64(secret, 'base64url') };
    const encryption = await Encryption.create(secret);
    const key = new Uint8Array(32).fill(7);
    const cipher = await encryption.openEncryption(key);
    const plain = createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata: {
        flavor: 'claude', ...(continuable ? { claudeSessionId: `resume-${id}`, claudeTranscriptPath: `/tmp/${id}.jsonl` } : {}),
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: id,
        ...(hidden ? { systemSessionV1: { v: 1 as const, key: 'voice_transcript_history', hidden: true } } : {}),
    } });
    if (plain.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical owner fixture');
    const [metadata] = await cipher.encrypt([JSON.parse(plain.metadata)]);
    const record = SessionCurrentProjectionRecordV1Schema.parse({ ...plain, encryptionMode: 'e2ee',
        metadata: encodeBase64(metadata!, 'base64'),
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64'),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
            ownerMetadata: { ...plain.ownerMetadata.v, ...(progressBytes ? { cursors: { externalSessionAttentionV1: {
                v: 1 as const, observedProgressToken: 'p'.repeat(progressBytes),
            } } } : {}) }, randomBytes: length => new Uint8Array(length).fill(3) }),
    });
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'e2ee', version: 1, updatedAt: 1,
        signingKeyFingerprint: 'synthetic-signing-key',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
        recipientEnvelopeReadiness: { status: 'available' },
    });
    return { record, credentials, currentness, encryption, key };
}

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
const serveWorkflowHomes: typeof serveAccountHomes = params => serveAccountHomes({ ...params,
    homes: params.homes.map(home => ({ currentAccount: true, ...home })),
    route: async request => await params.route(request)
        ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined,
});

// Ordinary list arrivals can remain unopened after an earlier metadata inventory
// completed. Exercise that real producer for the chooser's missing-only fallback;
// the explicitly demanded metadata inventory itself now admits all fetched rows.
async function publishOrdinaryEncryptedSessionRows(params: Readonly<{
    serverId: string;
    fixture: Awaited<ReturnType<typeof encryptedSessionFixture>>;
    requiredHydrationSessionIds?: readonly string[];
}>) {
    const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
    await act(async () => { await fetchAndApplySessions({
        serverId: params.serverId, credentials: params.fixture.credentials, accountCurrentness: params.fixture.currentness,
        encryption: params.fixture.encryption, sessionDataKeys: new Map(),
        source: { kind: 'query', body: { v: 1, storage: 'active', includeInactive: true,
            scope: 'my_work', attention: 'any', audiences: [], tagIds: [] }, allowV1Fallback: false },
        requiredHydrationSessionIds: params.requiredHydrationSessionIds ?? [], awaitSessionListHydration: true,
        sessionListMaxPages: 1, sessionListEagerHydrationCount: 0, sessionListBackgroundHydrationMaxRows: 0,
        request: (path, init) => homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init),
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[params.serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(params.serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(params.serverId, patches),
        applySessions: () => {}, log: { log() {} },
    }); });
}

afterEach(async () => {
    setServerReachabilityNetworkAllowed(true);
    standardCleanup();
    await homes?.dispose();
    homes = undefined;
    storage.setState(storage.getInitialState(), true);
});

it.each([true, false])('offers admitted inventory pages before completion without claiming empty; first eligible=%s', async firstEligible => {
    const accountId = `chooser-paged-${firstEligible}`;
    const first = await encryptedSessionFixture('paged-first', accountId, 0, firstEligible);
    const later = await encryptedSessionFixture('paged-later', accountId);
    const nextPage = createDeferred<void>();
    const archivedPage = createDeferred<void>();
    let demanded = false;
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: async request => {
        if (!demanded && ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(request.path)) {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active') return Response.json({ sessions: [] });
        if (request.path === '/v2/sessions/archived') {
            await archivedPage.promise;
            return Response.json({ sessions: [{ ...later.record, id: 'paged-archived', archivedAt: 1 }], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions') {
            if (!request.url.searchParams.has('cursor')) return Response.json({ sessions: [first.record], nextCursor: 'later', hasNext: true });
            await nextPage.promise;
            return Response.json({ sessions: [later.record], nextCursor: null, hasNext: false });
        }
        return undefined;
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const before = homes.requests.length;
        const started = performance.now();
        demanded = true;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(homes!.requests.some(request => request.url.searchParams.get('cursor') === 'later')).toBe(true));
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[first.record.id]).toBeDefined();
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId))
            .toEqual(firstEligible ? [first.record.id] : []));
        const firstUsableMs = firstEligible ? performance.now() - started : null;
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        await act(async () => { nextPage.resolve(); });
        await waitForHomeGovernance(() => expect(homes!.requests.some(request => request.path === '/v2/sessions/archived')).toBe(true));
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([
            ...(firstEligible ? [first.record.id] : []), later.record.id,
        ]));
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        await act(async () => { archivedPage.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([
            ...(firstEligible ? [first.record.id] : []), later.record.id,
        ]);
        expect(Object.keys(storage.getState().sessionListRowsByServerId[serverId]!)).toHaveLength(3);
        expect(storage.getState().sessions).toEqual({});
        const reads = homes.requests.slice(before).filter(request => request.path.startsWith('/v2/sessions'));
        expect(new Set(reads.filter(request => ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(request.path))
            .map(request => request.path))).toEqual(new Set(['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived']));
        expect(reads.some(request => request.path === '/v2/sessions' && request.url.searchParams.get('cursor') === 'later')).toBe(true);
        expect(reads.some(request => request.path === '/v2/sessions/query')).toBe(false);
        console.info('SWEEP22 paged chooser', { firstEligible, firstUsableMs, completeMs: performance.now() - started,
            detailBatches: reads.filter(request => request.path === '/v2/sessions/read-batch').length });
    } finally { nextPage.resolve(); archivedPage.resolve(); await hook.unmount(); }
});

it.each(['absent', 'published', 'miswired'] as const)('DIAG187 admits the list producer envelope through the real chooser; project=%s', async shape => {
    const record = createPlainSessionCurrentProjectionRecordFixture({ id: `diag187-${shape}`, active: true,
        metadata: { flavor: 'claude', claudeSessionId: 'resume-diag187', claudeTranscriptPath: '/tmp/diag187.jsonl',
            machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Synthetic diagnostic Session' } });
    // The loaded fin2 active-list producer returns only `sessions`; ordinary
    // and archived pages add their own cursor fields. No private response is copied.
    const viewer = createSessionViewerFixture();
    const { latestFailureSeq: _latestFailureSeq, ...olderViewer } = viewer;
    const fullWireRecord = { ...record, viewer,
        ...(shape === 'published' ? { projectKey: 'synthetic-project' } : {}) };
    const wireRecord = shape === 'miswired'
        ? { ...createCompactSessionListRowFixture(SessionCurrentProjectionRecordV1Schema.parse(fullWireRecord)), viewer: olderViewer }
        : fullWireRecord;
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://diag187-${shape}.test`,
        accountId: `diag187-${shape}` }], route: request => {
        // fin2's loaded producer omits viewer.latestFailureSeq; preserve that
        // exact public shape, using synthetic values for every other field.
        if (request.path === '/v2/sessions/active') return Response.json({ sessions: [wireRecord] });
        if (request.path === '/v2/sessions') return Response.json({ sessions: [wireRecord], nextCursor: null,
            hasNext: false, attentionNextCursor: null, attentionHasNext: false });
        if (request.path === '/v2/sessions/archived') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        return undefined;
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
    await act(async () => { storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null }); });
    const before = homes.requests.length;
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe(shape === 'miswired' ? 'error' : 'ready'));
    expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual(shape === 'miswired' ? [] : [record.id]);
    expect(storage.getState().sessions).toEqual({});
    const reads = homes.requests.slice(before);
    expect(reads.some(request => request.path === '/v2/sessions/active')).toBe(true);
    expect(reads.some(request => request.path === '/v2/sessions/read-batch')).toBe(shape !== 'miswired');
    await hook.unmount();
});

it.each(['loading', 'idle'] as const)('settles the chooser independently of Home Machine readiness; inventory=%s', async machineStatus => {
    const record = createPlainSessionCurrentProjectionRecordFixture({ id: `home-readiness-${machineStatus}`, active: true,
        metadata: { flavor: 'claude', claudeSessionId: 'resume-readiness', claudeTranscriptPath: '/tmp/readiness.jsonl',
            machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Readiness candidate' } });
    let demanded = false;
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://chooser-readiness-${machineStatus}.test`,
        accountId: `chooser-readiness-${machineStatus}` }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: demanded ? [record] : [], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {}, socketStatus: 'connected',
        endpointStatus: 'online', syncError: null, machineListByServerId: { [serverId]: [] },
        machineListStatusByServerId: { [serverId]: machineStatus } });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useActiveHomeConnectionHealth } = await import('@/components/navigation/connectionStatus/useConnectionHealth');
    const { useSettlingHomeServerId } = await import('@/components/navigation/connectionStatus/HomeReachabilityGate');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        health: useActiveHomeConnectionHealth(), settlingHome: useSettlingHomeServerId(),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
    // This fixture serves Session acquisition, not the unrelated bootstrap
    // resources. Establish the incident's exact transport/list state after
    // bootstrap's intentionally unanswered background reads have settled.
    await act(async () => { storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null,
        machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: machineStatus } }); });
    expect(hook.getCurrent().health.kind).toBe(machineStatus === 'loading' ? 'connecting' : 'no_machine');
    const readsBefore = homes.requests.length;
    const startedAt = performance.now();
    demanded = true;
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
    const current = hook.getCurrent();
    expect(current.existingSessions.map(option => option.sessionId)).toEqual([record.id]);
    expect(current.health.kind).toBe(machineStatus === 'loading' ? 'connecting' : 'no_machine');
    const reads = homes.requests.slice(readsBefore);
    expect(reads.some(request => request.path === '/v2/sessions')).toBe(true);
    expect(reads.filter(request => request.path === '/v2/sessions/archived')).toHaveLength(1);
    expect(reads.filter(request => request.path === '/v2/sessions/read-batch')
        .flatMap(request => SessionReadBatchRequestV1Schema.parse(request.body).sessionIds)).toContain(record.id);
    expect(storage.getState().sessions).toEqual({});
    console.info('DIAG186 chooser readiness comparison', { machineStatus, health: current.health.kind,
        settling: current.settlingHome !== null, elapsedMs: performance.now() - startedAt,
        inventoryReads: 2, detailReads: 0, options: current.existingSessions.length });
    await hook.unmount();
});

it.each([1, 0] as const)('reuses already-admitted plain list continuation facts without duplicate snapshot reads; layout=%s', async layout => {
    const metadataFor = (index: number, continuable = true) => ({
        flavor: 'claude', ...(continuable ? { claudeSessionId: `resume-${index}`, claudeTranscriptPath: `/tmp/${index}.jsonl` } : {}),
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: `Admitted ${index}`,
    });
    const records = Array.from({ length: 3 }, (_, index) => {
        const record = createPlainSessionCurrentProjectionRecordFixture({ id: `admitted-plain-${index}`, active: true, metadata: metadataFor(index) });
        if (layout === 0) {
            const legacy = { ...record, metadataLayoutVersion: 0, metadata: JSON.stringify(metadataFor(index)) };
            // Layout0 forbids the property itself, even when its value is undefined.
            Reflect.deleteProperty(legacy, 'ownerMetadata');
            return SessionCurrentProjectionRecordV1Schema.parse(legacy);
        }
        // Public display identity is not the owner's execution configuration.
        return SessionCurrentProjectionRecordV1Schema.parse({ ...record,
            metadata: JSON.stringify({ ...JSON.parse(record.metadata), agentPresentation: { agentId: 'codex' } }),
        });
    });
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://chooser-admitted-plain.test', accountId: 'chooser-admitted-plain' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({
                sessions: request.accountId === 'chooser-admitted-plain' ? records : [], nextCursor: null, hasNext: false,
            });
            if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    let optionRenders = 0;
    const hook = await renderHook(({ enabled }) => {
        optionRenders += 1;
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding }); });
        expect(Object.keys(storage.getState().sessionListRowsByServerId[serverId] ?? {})).toHaveLength(records.length);
        expect(storage.getState().sessions).toEqual({});
        const readsBeforeOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions).toEqual(records.map((record, index) => ({
            sessionId: record.id, machineId: 'machine-a', label: `Admitted ${index}`,
            // The Agent a row presents publicly, which a layout-1 owner's execution flavor does not decide.
            ...(layout === 1 ? { agentId: 'codex', contextLabel: 'Codex · host-a' } : { agentId: 'claude', contextLabel: 'Claude · host-a' }),
        })));
        const rendersBeforePreferences = optionRenders;
        await act(async () => {
            for (let index = 0; index < 20; index += 1) storage.setState(state => ({
                settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
            }));
        });
        expect(optionRenders - rendersBeforePreferences).toBe(0);
        const readsAfterOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        expect(readsAfterOpen - readsBeforeOpen).toBe(layout === 1 ? 0 : 1);
        if (layout === 0) expect(SessionReadBatchRequestV1Schema.parse(
            homes.requests.filter(request => request.path === '/v2/sessions/read-batch').at(-1)!.body,
        ).sessionIds).toEqual(records.map(record => record.id));
        // List reuse is not full-snapshot authority: a selected Session still
        // passes the exact current authenticated read when the next step needs it.
        const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const { serverFetch } = await import('@/sync/http/client');
        await act(async () => { await runWithServerRequestAuthorityForServerAccountScope({ scope: binding.scope, activeRequest: serverFetch }, async authority => {
            const selected = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [records[0]!.id], includeTurns: false })).get(records[0]!.id);
            if (!selected?.ok) throw new Error('Expected the selected Session to pass full snapshot admission');
            expect(readSessionOwnerMetadataView(selected.snapshot.session)).toMatchObject({ flavor: 'claude', claudeSessionId: 'resume-0' });
        }); });
        const selectedReads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').slice(readsAfterOpen);
        expect(selectedReads).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(selectedReads[0]!.body).sessionIds).toEqual([records[0]!.id]);
        if (layout === 1) {
            const originalSettings = storage.getState().settings;
            await act(async () => { storage.setState({ settings: { ...originalSettings,
                backendEnabledByTargetKey: { ...originalSettings.backendEnabledByTargetKey,
                    'agent:happier.agent.codex/codex': false },
            } }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
            await act(async () => { storage.setState({ settings: { ...originalSettings,
                backendEnabledByTargetKey: { ...originalSettings.backendEnabledByTargetKey,
                    'agent:happier.agent.claude/claude': false },
            } }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toEqual([]);
            await act(async () => { storage.setState({ settings: originalSettings }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
            // Re-admit changed private continuation facts through the real list
            // producer. Display identity/title stay equal; eligibility must not.
            records[0] = { ...createPlainSessionCurrentProjectionRecordFixture({ id: records[0]!.id, active: true,
                metadataVersion: records[0]!.metadataVersion + 1, metadata: metadataFor(0, false) }), metadata: records[0]!.metadata };
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = (await TokenStorage.getCredentialsForServerUrl(homes.homes.a!.serverUrl))!;
            const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
            await act(async () => { await fetchAndApplySessions({ serverId, credentials, encryption: null, sessionDataKeys: new Map(),
                request: (path, init) => homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init),
                getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
                applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
                applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
                applySessions: () => {}, awaitSessionListHydration: true, log: { log() {} },
            }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual(records.slice(1).map(record => record.id));
            expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(readsAfterOpen + 2);
            // Reused options must leave with their credential/Account lifetime,
            // even with no outstanding detail request to abort.
            await act(async () => { await homes!.switchAccount('a', 'replacement-plain-account'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        }
    } finally { await hook.unmount(); }
});

it('retains unopened owner provenance only when the list producer receives its previous row', async () => {
    const { record, credentials, currentness } = await encryptedSessionFixture('diag183-projection', 'diag183-projection');
    const { buildRenderableFromRowAndCache } = await import('@/sync/engine/sessions/sessionSnapshot');
    const { readSessionListRenderableOwnerMetadataView } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
    const first = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    const retained = buildRenderableFromRowAndCache(record, credentials, currentness, undefined, undefined, first);
    // Deliberately omit the previous-row input so this witness remains sensitive
    // to a producer losing its baseline. No internal owner is mocked.
    const miswired = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    expect(first[SESSION_OWNER_METADATA_PROJECTION]).toBeTruthy();
    expect(retained[SESSION_OWNER_METADATA_PROJECTION]).toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
    expect(miswired[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
    for (const row of [first, retained, miswired]) {
        // Reusing provenance cannot admit still-unopened Session content.
        expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: {
            credentials, accountCurrentness: currentness, isCurrent: () => true,
        } })).toBeNull();
    }
    const changed = await encryptedSessionFixture(record.id, 'diag183-projection', 0, false);
    const changedEnvelope = buildRenderableFromRowAndCache({ ...record, ownerMetadata: changed.record.ownerMetadata },
        credentials, currentness, undefined, undefined, first);
    expect(changedEnvelope[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
});

it('retains unopened owner provenance when exact Account credentials are recaptured without changing material', async () => {
    const { record, credentials, currentness } = await encryptedSessionFixture('diag183-recaptured', 'diag183-recaptured');
    const { buildRenderableFromRowAndCache } = await import('@/sync/engine/sessions/sessionSnapshot');
    const first = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    const recaptured = { ...credentials };
    expect(recaptured).not.toBe(credentials);
    expect(first[SESSION_OWNER_METADATA_PROJECTION]?.isCurrentAuthority?.({ credentials: recaptured,
        accountCurrentness: currentness })).toBe(true);
    const retained = buildRenderableFromRowAndCache(record, recaptured, currentness, undefined, undefined, first);
    expect(retained[SESSION_OWNER_METADATA_PROJECTION]).toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
});

it('retains admitted canonical inventory rows across identical refreshes, then publishes changed owner facts and removal', async () => {
    const accountId = 'diag190-canonical-identity';
    const first = await encryptedSessionFixture('canonical-a', accountId, 0, false);
    const second = await encryptedSessionFixture('canonical-b', accountId, 0, false);
    const third = await encryptedSessionFixture('canonical-c', accountId, 0, false);
    const records = [first.record, second.record, third.record];
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: records, nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const { readSessionListRenderableOwnerMetadataView } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding }); });
        const baseline = storage.getState().sessionListRowsByServerId[serverId]!;
        for (const record of records) {
            expect(readSessionListRenderableOwnerMetadataView(baseline[record.id]!, { requireAdmitted: {
                credentials: first.credentials, accountCurrentness: first.currentness, isCurrent: () => binding.isCurrent(),
            } })).toBeTruthy();
        }
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions).toEqual([]);
        for (let refresh = 0; refresh < 3; refresh += 1) {
            await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding, refresh: true,
            }); });
            const current = storage.getState().sessionListRowsByServerId[serverId]!;
            for (const record of records) {
                expect(current[record.id]?.[SESSION_OWNER_METADATA_PROJECTION]).toBe(baseline[record.id]?.[SESSION_OWNER_METADATA_PROJECTION]);
                expect(current[record.id]).toBe(baseline[record.id]);
                expect(readSessionListRenderableOwnerMetadataView(current[record.id]!, { requireAdmitted: {
                    credentials: first.credentials, accountCurrentness: first.currentness, isCurrent: () => binding.isCurrent(),
                } })).toBeTruthy();
            }
            expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
            expect(hook.getCurrent().existingSessions).toEqual([]);
        }
        const changed = await encryptedSessionFixture(first.record.id, accountId);
        records[0] = { ...first.record, ownerMetadata: changed.record.ownerMetadata,
            metadataVersion: first.record.metadataVersion + 1 };
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
            scope: binding.scope, accountLifetime: binding, refresh: true,
        }); });
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[first.record.id]?.[SESSION_OWNER_METADATA_PROJECTION])
            .not.toBe(baseline[first.record.id]?.[SESSION_OWNER_METADATA_PROJECTION]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([first.record.id]));
        records.shift();
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
            scope: binding.scope, accountLifetime: binding, refresh: true,
        }); });
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[first.record.id]).toBeUndefined();
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length).toBeGreaterThan(0);
        expect(storage.getState().sessions).toEqual({});
    } finally { await hook.unmount(); }
});

// Compact inventory must keep one pending document acquisition through refresh demand.
it.each([
    { missing: false, refreshes: 0 },
    { missing: true, refreshes: 0 },
    { missing: false, refreshes: 3 },
    { missing: true, refreshes: 3 },
])('settles cold ineligible Sessions across concurrent inventory demand; missing=$missing refreshes=$refreshes', async ({ missing, refreshes }) => {
    const accountId = `diag183-empty-${missing}-${refreshes}`;
    const first = await encryptedSessionFixture('diag183-a', accountId, 0, false);
    const second = await encryptedSessionFixture('diag183-b', accountId, 0, false);
    const third = await encryptedSessionFixture('diag183-c', accountId, 0, false);
    const records = [first.record, second.record, third.record];
    const detail = createDeferred<void>();
    let successfulBatchResponses = 0;
    let demanded = false;
    const batches: AbortSignal[] = [];
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === '/v2/sessions/read-batch') {
            batches.push(request.signal!);
            return undefined;
        }
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        if (!record) return undefined;
        await detail.promise;
        return missing ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ session: record });
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: async request => {
        if (request.path === '/v2/sessions') return Response.json({
            // The primary attention bootstrap is a separate filtered demand;
            // this case owns only the explicit Account-wide inventory.
            sessions: demanded && !request.url.searchParams.has('includeAttention') ? records : [],
            nextCursor: null, hasNext: false,
        });
        if (request.path === '/v2/sessions/query') return Response.json(createSessionListSourceFixture({
            // Filtered primary-Sync queries are unrelated to the explicitly
            // demanded Account-wide inventory under test.
            sessions: [],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }));
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        const response = await batch.handle(request);
        if (request.path === '/v2/sessions/read-batch' && response?.status === 200) successfulBatchResponses += 1;
        return response;
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const hook = await renderHook(({ enabled }) => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        demanded = true;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(batches).toHaveLength(1));
        const refreshesInFlight: Promise<void>[] = [];
        const refreshFailures: unknown[] = [];
        for (let refresh = 0; refresh < refreshes; refresh += 1) {
            refreshesInFlight.push(ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding,
            }).catch(error => { refreshFailures.push(error); }));
            await flushHookEffects();
            expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
            expect(hook.getCurrent().existingSessions).toEqual([]);
        }
        expect(batches).toHaveLength(1);
        expect(batches[0]!.aborted).toBe(false);
        await act(async () => { detail.resolve(); });
        await Promise.all(refreshesInFlight);
        expect(refreshFailures).toHaveLength(missing ? refreshes : 0);
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe(missing ? 'error' : 'ready'));
        expect(hook.getCurrent().existingSessions).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(batches).toHaveLength(1);
        expect(successfulBatchResponses).toBe(1);
        if (refreshes === 3 && !missing) {
            const before = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            const changed = await encryptedSessionFixture(first.record.id, accountId, 0, true);
            // The compact descriptor advances the private document version.
            records[0] = { ...first.record, ownerMetadata: changed.record.ownerMetadata,
                metadataVersion: first.record.metadataVersion + 1 };
            await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding, refresh: true,
            }); });
            const after = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            expect(after[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(before[SESSION_OWNER_METADATA_PROJECTION]);
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([first.record.id]);
            // A filtered ordinary query does not own Account-wide absence;
            // canonical metadata inventory removal is exercised above.
        }
    } finally { detail.resolve(); await hook.unmount(); }
});

it('batch-reads only a new encrypted compact row alongside warm admitted rows', async () => {
    const accountId = 'chooser-mixed-encrypted';
    const first = await encryptedSessionFixture('admitted-encrypted-a', accountId);
    const second = await encryptedSessionFixture('admitted-encrypted-b', accountId);
    const unopened = await encryptedSessionFixture('never-admitted-encrypted', accountId);
    const records = [first.record, second.record, unopened.record];
    const page = { sessions: records, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    let listedRecords = records.slice(0, 2);
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://chooser-mixed-encrypted.test', accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ ...page, sessions: [] });
        if (request.path === '/v2/sessions/query') return Response.json(createSessionListSourceFixture({ ...page,
            sessions: listedRecords.map(record => ({ ...record, viewer: createSessionViewerFixture() })),
        }));
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const hook = await renderHook(({ enabled }) => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => {
            await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding });
        });
        await publishOrdinaryEncryptedSessionRows({ serverId, fixture: first,
            requiredHydrationSessionIds: [first.record.id, second.record.id] });
        const rows = storage.getState().sessionListRowsByServerId[serverId]!;
        expect(rows[first.record.id]?.metadata?.machineId).toBe('machine-a');
        expect(rows[second.record.id]?.metadata?.machineId).toBe('machine-a');
        expect(rows[unopened.record.id]).toBeUndefined();
        expect(storage.getState().sessions).toEqual({});
        const readsBeforeAppend = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        listedRecords = records;
        await publishOrdinaryEncryptedSessionRows({ serverId, fixture: first });
        const appendedReads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').slice(readsBeforeAppend);
        expect(appendedReads).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(appendedReads[0]!.body).sessionIds).toEqual([unopened.record.id]);
        const readsBeforeOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual(records.map(record => record.id).sort());
        const reads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').slice(readsBeforeOpen);
        expect(reads).toHaveLength(0);
    } finally { await hook.unmount(); }
});

it('DIAG190 batches cold encrypted metadata once and reuses it without duplicate acquisition', async () => {
    const accountId = 'diag190-inventory';
    const unavailable = await encryptedSessionFixture('diag190-unavailable', accountId, 0, false);
    const available = await encryptedSessionFixture('diag190-available', accountId);
    const hidden = await encryptedSessionFixture('diag190-hidden', accountId, 0, true, true);
    const archivedFixture = await encryptedSessionFixture('diag190-archived', accountId);
    const archived = SessionCurrentProjectionRecordV1Schema.parse({ ...archivedFixture.record, active: false, archivedAt: 42 });
    const records = [...Array.from({ length: 997 }, (_, index) => ({ ...unavailable.record, id: `diag190-${index}` })),
        available.record, hidden.record];
    const byId = new Map([...records, archived].map(record => [record.id, record]));
    const page = { sessions: records, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    let demanded = false;
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = byId.get(request.path.slice('/v2/sessions/'.length));
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials: unavailable.credentials, encryptionCurrentness: () => unavailable.currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json(demanded && !request.url.searchParams.has('includeAttention')
            ? page : { ...page, sessions: [] });
        if (request.path === '/v2/sessions/query') return Response.json({ ...page, sessions: [] });
        if (request.path === '/v2/sessions/active') return Response.json({ sessions: [] });
        if (request.path === '/v2/sessions/archived') return Response.json({ sessions: demanded ? [archived] : [], nextCursor: null, hasNext: false });
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await flushHookEffects();
        const before = homes.requests.length;
        const started = performance.now();
        demanded = true;
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding }); });
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([available.record.id]);
        expect(storage.getState().sessions).toEqual({});
        const acquisition = homes.requests.slice(before).filter(request => request.path.startsWith('/v2/sessions'));
        expect(new Set(acquisition.filter(request => ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(request.path))
            .map(request => request.path))).toEqual(new Set(['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived']));
        expect(acquisition.some(request => request.path === '/v2/sessions/query')).toBe(false);
        const rows = storage.getState().sessionListRowsByServerId[serverId]!;
        expect(Object.keys(rows)).toHaveLength(1000);
        const { readSessionListRenderableOwnerMetadataView } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
        for (const id of [available.record.id, hidden.record.id, archived.id]) {
            expect(readSessionListRenderableOwnerMetadataView(rows[id]!, { requireAdmitted: {
                credentials: unavailable.credentials, accountCurrentness: unavailable.currentness, isCurrent: () => binding.isCurrent(),
            } })).toBeTruthy();
        }
        const reads = acquisition.filter(request => request.path === '/v2/sessions/read-batch')
            .map(request => SessionReadBatchRequestV1Schema.parse(request.body));
        const bodies = reads.reduce((count, request) => count + request.sessionIds.length, 0);
        console.info('DIAG190 cost', { inventoryRows: Object.keys(rows).length, options: hook.getCurrent().existingSessions.length,
            batches: reads.length, bodies, elapsedMs: performance.now() - started,
            turns: reads.some(request => request.includeTurns !== false), messages: reads.some(request => request.includeMessages) });
        // Cold compact rows demand documents once; opening the chooser reuses them.
        expect(bodies).toBe(byId.size);
        expect(new Set(reads.flatMap(request => request.sessionIds)).size).toBe(byId.size);
        expect(reads.every(request => request.includeTurns === false && !request.includeMessages)).toBe(true);
    } finally { await hook.unmount(); }
});

it.skipIf(process.env.HAPPIER_DIAG181_BENCHMARK !== '1')('profiles 1000 encrypted snapshots at the admitted batch owner', async () => {
    // Match R101's order of magnitude (20 MB / ~1000 snapshots), with real
    // canonical encrypted owner cursors and separately sealed Session DEKs.
    const { record, credentials, currentness, encryption, key } = await encryptedSessionFixture('diag181-encrypted', 'diag181-benchmark', 14000);
    const { encodeBase64 } = await import('@/encryption/base64');
    const records = await Promise.all(Array.from({ length: 1000 }, async (_, index) => ({ ...record, id: `diag181-${index}`,
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64') })));
    let responseAt = 0;
    let responseBytes = 0;
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://diag181-benchmark.test',
        accountId: 'diag181-benchmark', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path !== '/v2/sessions/read-batch') return undefined;
        const demand = SessionReadBatchRequestV1Schema.parse(request.body);
        const byId = new Map(records.map(value => [value.id, value]));
        const serialized = JSON.stringify({ results: demand.sessionIds.map(sessionId => ({ sessionId,
            detail: { status: 200, body: { session: byId.get(sessionId) } } })) });
        responseBytes = new TextEncoder().encode(serialized).length;
        const response = new Response(serialized, { headers: { 'content-type': 'application/json' } });
        responseAt = performance.now();
        return response;
    } });
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { serverFetch } = await import('@/sync/http/client');
    const { Session } = await import('node:inspector');
    const { writeFile } = await import('node:fs/promises');
    const profiler = new Session();
    profiler.connect();
    const post = <T,>(method: string) => new Promise<T>((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result as T)));
    const started = performance.now();
    let firstAt = 0;
    let published = 0;
    await post('Profiler.enable');
    await post('Profiler.start');
    try {
        await runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId: homes.homes.a!.id, accountId: 'diag181-benchmark' }, activeRequest: serverFetch }, async authority => {
            const results = await readSessionSnapshotsForAuthority({ authority, sessionIds: records.map(value => value.id), includeTurns: false,
                onResult: (_id, result) => { expect(result.ok).toBe(true); firstAt ||= performance.now(); published += 1; } });
            expect(results.size).toBe(records.length);
            expect([...results.values()].every(result => result.ok)).toBe(true);
        });
        console.info('DIAG181 encrypted batch benchmark', { count: records.length, published, responseBytes,
            elapsedMs: performance.now() - started, responseToFirstMs: firstAt - responseAt,
            responseToCompleteMs: performance.now() - responseAt,
            currentnessRequests: homes.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness').length,
            requestsByPath: Object.fromEntries([...new Set(homes.requests.map(request => request.path))].map(path => [path, homes!.requests.filter(request => request.path === path).length])),
            batches: homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length });
    } finally {
        const { profile } = await post<{ profile: unknown }>('Profiler.stop');
        await writeFile(process.env.HAPPIER_DIAG181_PROFILE ?? '/tmp/diag181-benchmark.cpuprofile', JSON.stringify(profile));
        profiler.disconnect();
    }
});

it.each([false, true])('offers the first hydrated compact page while a later batch is held, retaining successes on failure=%s', async failLater => {
    const accountId = `picker-progress-${failLater}`;
    const fixture = await encryptedSessionFixture('progress-first', accountId);
    const { record: first, credentials, currentness } = fixture;
    const { record: later } = await encryptedSessionFixture('progress-later', accountId);
    const firstRead = createDeferred<void>();
    const laterRead = createDeferred<void>();
    let demanded = false;
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === `/v2/sessions/${first.id}`) {
            await firstRead.promise;
            return Response.json({ session: first });
        }
        if (request.path === `/v2/sessions/${later.id}`) {
            await laterRead.promise;
            return failLater ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ session: later });
        }
        return undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json(!demanded || request.url.searchParams.has('includeAttention')
            ? { sessions: [], nextCursor: null, hasNext: false }
            : request.url.searchParams.has('cursor')
                ? { sessions: [later], nextCursor: null, hasNext: false }
                : { sessions: [first], nextCursor: 'later', hasNext: true });
        if (request.path === '/v2/sessions/query') return Response.json(createSessionListSourceFixture({
            sessions: [],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }));
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { serverFetch } = await import('@/sync/http/client');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const hook = await renderHook(({ enabled }) => ({
        ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        binding: useServerCredentialAccountScopeBinding(serverId).binding,
    }), { initialProps: { enabled: false } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
    let incumbent: Promise<unknown> | undefined;
    const batchRequests = () => homes!.requests.filter(request => request.path === '/v2/sessions/read-batch');
    try {
        const started = performance.now();
        demanded = true;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(batchRequests()).toHaveLength(1));
        const joined = createDeferred<void>();
        // The inventory's physical document request is already held. The public
        // exact reader reserves synchronously before this callback signals, so
        // both real consumers overlap without relying on microtask timing.
        incumbent = runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId, accountId }, activeRequest: serverFetch },
            authority => {
                expect(authority.readTransport).toBeDefined();
                const pending = readSessionSnapshotsForAuthority({ authority, sessionIds: [first.id], includeTurns: false });
                joined.resolve();
                return pending;
            });
        await joined.promise;
        expect(batchRequests()).toHaveLength(1);
        expect(hook.getCurrent().existingSessions).toEqual([]);
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        await act(async () => { firstRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([first.id]));
        await waitForHomeGovernance(() => expect(batchRequests().some(request =>
            SessionReadBatchRequestV1Schema.parse(request.body).sessionIds.includes(later.id))).toBe(true));
        const initialDemand = SessionReadBatchRequestV1Schema.parse(batchRequests()[0]!.body);
        expect(batchRequests().map(request => SessionReadBatchRequestV1Schema.parse(request.body)))
            .toEqual([initialDemand, { ...initialDemand, sessionIds: [later.id] }]);
        const firstOfferedMs = performance.now() - started;
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        expect(storage.getState().sessions[first.id]).toBeUndefined();
        expect(batchRequests().every(request => SessionReadBatchRequestV1Schema.parse(request.body).includeTurns === false)).toBe(true);
        await act(async () => { laterRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe(failLater ? 'error' : 'ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual(failLater ? [first.id] : [first.id, later.id]);
        console.info('FIX185 controlled acquisition', { batches: batchRequests().length, firstOfferedMs,
            completeMs: performance.now() - started, failLater });
    } finally {
        firstRead.resolve(); laterRead.resolve();
        await incumbent;
        await hook.unmount();
    }
});

it('offers all 1090 cold compact candidates through one document batch without publishing full Sessions', async () => {
    // The observed fin2 candidate count is a workload, not a production limit.
    // Plain fixtures isolate acquisition/publication cost from native E2EE work.
    const records = Array.from({ length: 1090 }, (_, index) => {
        const id = `cold-${index}`;
        return createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata: {
            flavor: 'claude', claudeSessionId: `resume-${id}`, claudeTranscriptPath: `/tmp/${id}.jsonl`,
            machineId: 'machine-a', path: '/repo', host: 'host-a', name: id,
        } });
    });
    const byId = new Map(records.map(record => [record.id, record]));
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = byId.get(request.path.slice('/v2/sessions/'.length));
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://picker-cold-heavy.test', accountId: 'picker-cold-heavy' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({ sessions: records, nextCursor: null, hasNext: false });
            if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const started = performance.now();
    let firstOfferedMs: number | undefined;
    let completedMs: number | undefined;
    let renders = 0;
    const hook = await renderHook(() => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a' });
        renders += 1;
        if (firstOfferedMs === undefined && options.existingSessions.length > 0) firstOfferedMs = performance.now() - started;
        if (completedMs === undefined && options.sessionOptionsStatus === 'ready' && options.existingSessions.length === records.length) {
            completedMs = performance.now() - started;
        }
        return options;
    });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
        expect(Object.keys(storage.getState().sessions)).toEqual([]);
        const requests = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
        expect(requests).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(requests[0]!.body).sessionIds).toEqual(records.map(record => record.id));
        console.info('FIX185 cold heavy acquisition', { candidates: records.length, batches: requests.length,
            firstOfferedMs, completedMs, renders });
    } finally { await hook.unmount(); }
});

it('offers a layout-1 Session from its admitted owner view without publishing a full Session or requesting turns', async () => {
    const { record: c, credentials, currentness } = await encryptedSessionFixture('layout-1-c', 'picker-owner');
    const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${c.id}`
        ? Response.json({ session: c }) : undefined);
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-owner.test',
        accountId: 'picker-owner', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: [c], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const started = performance.now();
    let firstOfferedMs: number | undefined;
    const hook = await renderHook(() => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a' });
        if (firstOfferedMs === undefined && options.existingSessions.some(option => option.sessionId === c.id)) {
            firstOfferedMs = performance.now() - started;
        }
        return options;
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
    console.info('FIX185 cold acquisition', { candidates: 1, batches: homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length,
        firstOfferedMs, completeMs: performance.now() - started });
    // The demanded metadata inventory admits its compact identity projection,
    // without hydrating a full Session entity or replacing exact detail admission.
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[c.id]).toMatchObject({ metadata: { machineId: 'machine-a' }, metadataLayoutVersion: 1 });
    expect(hook.getCurrent().existingSessions).toEqual([{ sessionId: c.id, machineId: 'machine-a', label: c.id,
        agentId: 'claude', contextLabel: 'Claude · host-a' }]);
    expect(storage.getState().sessions[c.id]).toBeUndefined();
    // List display identity is not exact selected-Session authority: selection
    // still reads and admits the private owner/native continuation facts.
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { resolveDisplayMachineIdForSessionFromState } = await import('@/sync/domains/session/resolveMachineTargetForSessionFromState');
    const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
    const { serverFetch } = await import('@/sync/http/client');
    expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
    await runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId, accountId: 'picker-owner' }, activeRequest: serverFetch }, async authority => {
        const result = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [c.id], includeTurns: false })).get(c.id);
        if (!result?.ok) throw new Error('Expected the admitted layout-1 snapshot');
        const session = result.snapshot.session;
        const ownerMetadata = readSessionOwnerMetadataView(session);
        expect(ownerMetadata).toMatchObject({ machineId: 'machine-a', claudeSessionId: `resume-${c.id}`,
            claudeTranscriptPath: `/tmp/${c.id}.jsonl` });
        expect(session.metadata).not.toHaveProperty('claudeSessionId');
        const target = { state: storage.getState(), serverId, sessionId: c.id };
        // The current admitted scoped list row supplies display attribution
        // even when the supplied shared snapshot has no private native facts.
        expect(resolveDisplayMachineIdForSessionFromState({ ...target, metadata: session.metadata })).toBe('machine-a');
        expect(resolveDisplayMachineIdForSessionFromState({ ...target, metadata: ownerMetadata })).toBe('machine-a');
    });
    const requests = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
    expect(requests).toHaveLength(2);
    expect(requests.map(request => SessionReadBatchRequestV1Schema.parse(request.body).sessionIds)).toEqual([[c.id], [c.id]]);
    expect(requests.every(request => SessionReadBatchRequestV1Schema.parse(request.body).includeTurns === false)).toBe(true);
    await hook.unmount();
});

it('waits for paged inventory across bootstrap publications, then refreshes material changes and fences Account retirement', async () => {
    const { record: c, credentials, currentness } = await encryptedSessionFixture('bootstrap-c', 'picker-bootstrap');
    const { record: a } = await encryptedSessionFixture('bootstrap-a', 'picker-bootstrap');
    const inventoryPage = createDeferred<void>();
    let detailedRead = createDeferred<void>();
    let demanded = false;
    let failing = false;
    let holdDetail = false;
    const batches: AbortSignal[] = [];
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === '/v2/sessions/read-batch') {
            if (demanded) {
                batches.push(request.signal!);
            }
            return undefined;
        }
        if (request.path === `/v2/sessions/${c.id}` || request.path === `/v2/sessions/${a.id}`) {
            if (holdDetail) await detailedRead.promise;
            return failing ? Response.json({ error: 'not_found' }, { status: 404 })
                : Response.json({ session: request.path.endsWith(c.id) ? c : a });
        }
        return undefined;
    });
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-bootstrap.test',
        accountId: 'picker-bootstrap', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: async request => {
        if (request.path === '/v2/sessions') {
            if (!demanded || request.accountId !== 'picker-bootstrap') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (!request.url.searchParams.has('cursor')) return Response.json({ sessions: [a], nextCursor: 'next', hasNext: true });
            await inventoryPage.promise;
            return Response.json({ sessions: [c], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
    const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
    const auth = (await TokenStorage.getCredentialsForServerUrl(homes.homes.a!.serverUrl))!;
    const encryption = await createEncryptionFromAuthCredentials(auth);
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    await act(async () => { expect((await resolveServerCredentialAccountScope(serverId)).kind).toBe('bound'); });
    demanded = true;
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(homes!.requests.some(request => request.url.searchParams.get('cursor') === 'next')).toBe(true));
    // Normal bootstrap page producer and real scoped store; no internal row fabrication.
    const publishBootstrap = async (records: typeof c[]) => {
        await act(async () => { await fetchAndApplySessions({ serverId, credentials: auth, encryption,
            sessionDataKeys: new Map(), sessionListMaxPages: 1,
            request: createCompactSessionListFetchBoundary(async (path, init) => new URL(path, homes!.homes.a!.serverUrl).pathname === '/v2/sessions'
                ? Response.json({ sessions: records, nextCursor: null, hasNext: false })
                : homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init)),
            getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
            applySessions: () => {},
            applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
            log: { log: () => {} },
        }); });
    };
    try {
        await publishBootstrap([a]);
        await publishBootstrap([a, c]);
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        const readsBeforeInventoryCompletion = batches.length;
        await act(async () => { inventoryPage.resolve(); });
        // Ordinary publications after the paged inventory baseline remain newer.
        // Cold documents were admitted at each producer's compact HTTP boundary.
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        const initialBatch = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
        expect(initialBatch.length).toBeGreaterThanOrEqual(readsBeforeInventoryCompletion);
        expect(new Set(initialBatch.flatMap(request => SessionReadBatchRequestV1Schema.parse(request.body).sessionIds)))
            .toEqual(new Set([a.id, c.id]));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual([a.id, c.id]);
        expect(storage.getState().sessions[c.id]).toBeUndefined();
        failing = true;
        await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
            { sessionId: c.id, patch: { metadataVersion: c.metadataVersion + 1 } },
        ]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
        failing = false;
        await act(async () => { hook.getCurrent().retrySessionOptions(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toContain(c.id);
        await act(async () => { storage.getState().clearSessionListRowsForServerScope(serverId); });
        expect(hook.getCurrent().existingSessions).toEqual([]);
        await publishBootstrap([c]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([c.id]));
        detailedRead = createDeferred<void>();
        holdDetail = true;
        const beforeRetirement = batches.length;
        await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
            { sessionId: c.id, patch: { metadataVersion: c.metadataVersion + 2 } },
        ]); });
        await waitForHomeGovernance(() => expect(batches.length).toBeGreaterThan(beforeRetirement));
        const retiringRead = batches.at(-1)!;
        await act(async () => { await homes!.switchAccount('a', 'replacement-account'); });
        expect(retiringRead.aborted).toBe(true);
        await act(async () => { detailedRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        expect(storage.getState().sessions[c.id]).toBeUndefined();
    } finally {
        inventoryPage.resolve(); detailedRead.resolve();
        await hook.unmount();
    }
});

it('lists paged compact Sessions without offering hidden, archived, ineligible or other-Home Sessions', async () => {
    const metadata = { flavor: 'claude', claudeSessionId: 'resume-c', claudeTranscriptPath: '/tmp/c.jsonl',
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Session C' };
    const c = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened-c', active: true, metadata });
    const hidden = createPlainSessionCurrentProjectionRecordFixture({ id: 'hidden', active: true, metadata: {
        ...metadata, systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
    } });
    const otherMachine = createPlainSessionCurrentProjectionRecordFixture({ id: 'other-machine', active: true,
        metadata: { ...metadata, machineId: 'machine-b' } });
    const archived = Array.from({ length: 300 }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({
        id: `archived-${index}`, active: false, archivedAt: 42, metadata,
    }));
    const ineligible = createPlainSessionCurrentProjectionRecordFixture({ id: 'ineligible', active: true,
        metadata: { flavor: 'claude', machineId: 'machine-a', path: '/repo', host: 'host-a' } });
    let deleted = false;
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = [c, hidden, otherMachine, ineligible, ...archived].find(row => request.path === `/v2/sessions/${row.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveWorkflowHomes({ homes: [
        { key: 'a', serverUrl: 'https://workflow-picker-a.test', accountId: 'picker-account-a' },
        { key: 'b', serverUrl: 'https://workflow-picker-b.test', accountId: 'picker-account-b' },
    ], route: request => {
        if (request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: archived, nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions') {
            if (request.home === 'b') return Response.json({ sessions: [
                createPlainSessionCurrentProjectionRecordFixture({ id: 'other-home-only', active: true,
                    metadata: { ...metadata, name: 'Other Home' } }),
            ], nextCursor: null, hasNext: false });
            return Response.json(deleted ? { sessions: [], nextCursor: null, hasNext: false }
                : request.url.searchParams.get('cursor')
                    ? { sessions: [c, otherMachine, ineligible], nextCursor: null, hasNext: false }
                    : { sessions: [hidden], nextCursor: 'page-2', hasNext: true });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    expect(hook.getCurrent().existingSessions).toEqual([]);
    expect(homes.requests.some(request => request.home === 'a' && request.path === '/v2/sessions')).toBe(false);
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.some(option => option.sessionId === c.id)).toBe(true));
    // Cold compact rows need one document read to establish private eligibility.
    expect(batch.componentRequests.filter(request => request.path === `/v2/sessions/${hidden.id}`
        || archived.some(row => request.path === `/v2/sessions/${row.id}`))).toHaveLength(archived.length + 1);
    expect(hook.getCurrent().existingSessions).toEqual([
        { sessionId: c.id, machineId: 'machine-a', label: 'Session C', agentId: 'claude', contextLabel: 'Claude · host-a' },
    ]);
    expect(storage.getState().sessions[c.id]).toBeUndefined();
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId).sort()).toEqual(['other-machine', c.id]);
    expect(homes.requests.some(request => request.path === '/v2/sessions/read-batch' && request.home === 'a')).toBe(true);
    expect(homes.requests.some(request => request.path === '/v2/sessions' && request.url.searchParams.get('cursor') === 'page-2')).toBe(true);
    // Archival is a list lifecycle fact: an already displayed unopened Session
    // must disappear even though neither metadata nor its version changed.
    await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
        { sessionId: otherMachine.id, patch: { archivedAt: 42 } },
    ]); });
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId)).toEqual([c.id]);
    expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([c.id]);
    deleted = true;
    await act(async () => { storage.getState().clearSessionListRowsForServerScope(serverId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
    await hook.unmount();
});

it.each([false, true])('starts each demanded acquisition as loading and retries a failed one through the same owner; cancel waiting=%s', async cancelWaiting => {
    const metadata = { flavor: 'claude', claudeSessionId: 'resume-r', claudeTranscriptPath: '/tmp/r.jsonl',
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Recovered' };
    const recovered = createPlainSessionCurrentProjectionRecordFixture({ id: 'recovered', active: true, metadata });
    let failing = true;
    const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${recovered.id}`
        ? Response.json({ session: recovered }) : undefined);
    homes = await serveWorkflowHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-retry.test', accountId: 'picker-retry' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({ sessions: [recovered], nextCursor: null, hasNext: false });
            // The detailed inventory's own archived page fails; the Home and its sync stay healthy.
            if (request.path === '/v2/sessions/archived') {
                return failing ? new Response('unavailable', { status: 503 })
                    : Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (request.path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const statuses: string[] = [];
    const hook = await renderHook(({ enabled }) => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled });
        statuses.push(options.sessionOptionsStatus);
        return options;
    }, { initialProps: { enabled: false } });
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    await act(async () => { expect((await resolveServerCredentialAccountScope(serverId)).kind).toBe('bound'); });
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
    // A failed read is not an empty Account, and a new demand never starts from the last one's outcome.
    await hook.rerender({ enabled: false });
    expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    statuses.length = 0;
    await hook.rerender({ enabled: true });
    expect(statuses[0]).toBe('loading');
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
    failing = false;
    statuses.length = 0;
    setServerReachabilityNetworkAllowed(false);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: homes.homes.a!.serverUrl, generation: 0 });
    storage.getState().setEndpointConnectivity({ status: 'offline', reason: null, attempt: 0, nextRetryAt: null,
        lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    const requestsBeforeRetry = homes.requests.length;
    await act(async () => { hook.getCurrent().retrySessionOptions(); });
    await flushHookEffects();
    expect(statuses).toContain('loading');
    expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
    expect(homes.requests).toHaveLength(requestsBeforeRetry);
    if (cancelWaiting) {
        await hook.rerender({ enabled: false });
        expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    }
    storage.getState().resetEndpointConnectivity();
    setServerReachabilityNetworkAllowed(true);
    if (cancelWaiting) {
        await flushHookEffects();
        expect(homes.requests.filter(request => request.path === '/v2/sessions' || request.path === '/v2/sessions/read-batch'))
            .toHaveLength(homes.requests.slice(0, requestsBeforeRetry).filter(request => request.path === '/v2/sessions' || request.path === '/v2/sessions/read-batch').length);
        await hook.rerender({ enabled: true });
    }
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([recovered.id]));
    // Progressive options can already be usable while the retried inventory
    // continues. Completion is its own contract, not implied by the first option.
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
    expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([recovered.id]);
    await hook.unmount();
});
