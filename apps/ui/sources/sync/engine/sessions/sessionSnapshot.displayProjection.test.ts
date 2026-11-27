import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { SessionOwnerMetadataV1Schema, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionDisplayV1, SessionDisplayProjectionV1Schema, validateSessionDisplayProjectionV1 } from '@happier-dev/protocol/sessions';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { storage } from '@/sync/domains/state/storage';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { fetchAndApplySessions } from './sessionSnapshot';
import { createSessionDisplayCrypto } from '@/sync/encryption/sessionDisplayCrypto';
import { Encryption } from '@/sync/encryption/encryption';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { encodeBase64 } from '@/encryption/base64';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createUiSessionAwarenessInput, projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { buildSessionFromListRenderable, createSessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { SESSION_LIST_DOCUMENT_ADMISSION } from '@/sync/domains/session/sessionDocumentAdmission';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { retainVisibleSessionListSurfaces } from '@/sync/domains/session/sessionSurfaceVisibility';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';

const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

it.each([[2, 1], [32, 17], [200, 370]])('publishes a hydrated query page once for %i Sessions and %i Machines', async (sessionCount, machineCount) => {
    const deliverConcurrentPage = machineCount === 370;
    const serverId = `query-display-publication-${sessionCount}`;
    const secret = new Uint8Array(32).fill(63);
    const dataKey = new Uint8Array(32).fill(64);
    const credentials = { token: 'query-display-publication', secret: encodeBase64(secret) };
    const encryption = await Encryption.create(secret);
    const encoder = await Encryption.create(secret);
    encoder.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const sessionIds = Array.from({ length: sessionCount }, (_, index) => `session-${index}`);
    await encoder.initializeSessions(new Map([[sessionIds[0]!, dataKey]]), { serverId });
    const sessionEncryption = encoder.getSessionEncryption(sessionIds[0]!)!;
    const crypto = createSessionDisplayCrypto({ sessionMode: 'e2ee', accountMode: 'plain', credentials, sessionEncryption });
    const dataEncryptionKey = encodeBase64(await encoder.encryptEncryptionKey(dataKey));
    const viewer = createSessionOwnerViewerFixture(createSessionFixture({ id: 'viewer-template' }));
    const sessions = await Promise.all(sessionIds.map(async (id, index) => {
        const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: `Summary ${index}`, updatedAt: 2 } });
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
            workspace: { name: `Session ${index}`, path: '/workspace', host: `machine-${index % machineCount}` } });
        const plain = deliverConcurrentPage && index > 0;
        const displayCrypto = plain ? createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'plain', credentials }) : crypto;
        const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        return createCompactSessionListRowFixture({
            ...createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 2 }),
            viewer, encryptionMode: plain ? 'plain' : 'e2ee', dataEncryptionKey: plain ? null : dataEncryptionKey,
            metadata: plain ? JSON.stringify(sharedMetadata) : await sessionEncryption.encryptRaw(sharedMetadata),
            displayProjectionV1: SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 2, metadataLayoutVersion: 1,
                shared: await displayCrypto.encodeSharedDisplay(display.shared), owner: displayCrypto.encodeOwnerDisplay(display.owner!) }),
        });
    }));
    const keyReadStarted = createDeferred<void>();
    const releaseKeys = createDeferred<void>();
    const worker = createFakeCryptoWorker();
    let heldFirstKeyRead = false;
    encryption.configureNativeCryptoWorker({
        worker: { ...worker, decryptDataKeyEnvelopeV1: async request => {
            if (!heldFirstKeyRead) {
                heldFirstKeyRead = true;
                keyReadStarted.resolve();
                await releaseKeys.promise;
            }
            return worker.decryptDataKeyEnvelopeV1(request);
        } },
        routing: { mode: 'auto', minBatchSize: 1, minPayloadBytes: 0 },
        scope: { accountId: 'query-display-publication', serverId, generation: 1 },
    });
    const machines = Array.from({ length: machineCount }, (_, index) => createMachineFixture({ id: `machine-${index}` }));
    const readRows = () => storage.getState().sessionListRowsByServerId[serverId];
    const readMachines = () => storage.getState().machineListByServerId[serverId];
    const sessionDataKeys = new Map<string, Uint8Array>();
    const detailReads: string[] = [];
    const queryRows = deliverConcurrentPage
        ? sessions.map((row, index) => index === 0 ? row : { ...row, displayProjectionV1: undefined })
        : sessions;
    const refresh = () => fetchAndApplySessions({
        serverId, credentials, encryption,
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(),
        sessionDataKeys, contentDemand: 'list-projection',
        source: { kind: 'query', allowV1Fallback: false, body: { v: 1, storage: 'active', includeInactive: true,
            audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] } } },
        request: async path => {
            if (path === '/v2/sessions/query') {
                return Response.json(SessionListQueryResponseV1Schema.parse({
                    sessions: queryRows, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
            }
            detailReads.push(path);
            return Response.json({ error: 'unavailable' }, { status: 503 });
        },
        getCurrentSessionListRenderable: sessionId => readRows()?.[sessionId],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'query', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions() {}, log: { log() {} },
    });
    let commits = 0;
    const mounted = await renderHook(() => {
        const rows = React.useSyncExternalStore(storage.subscribe, readRows);
        const inventory = React.useSyncExternalStore(storage.subscribe, readMachines);
        React.useLayoutEffect(() => { commits++; });
        return { rows, inventory };
    });
    const publications: ReturnType<typeof readRows>[] = [];
    const stop = storage.subscribe((next, previous) => {
        const rows = next.sessionListRowsByServerId[serverId];
        if (rows !== previous.sessionListRowsByServerId[serverId]) publications.push(rows);
    });
    let hydration: ReturnType<typeof refresh> | undefined;
    try {
        const beforeHydration = commits;
        await act(async () => { storage.getState().applyMachines(machines, true, { sourceServerId: serverId }); });
        await act(async () => {
            hydration = refresh();
            await Promise.race([keyReadStarted.promise, hydration.then(() => {
                throw new Error('Expected the first query page to open the Session display keys');
            })]);
        });
        expect.soft(commits - beforeHydration).toBe(1);
        expect.soft(publications).toHaveLength(0);

        if (deliverConcurrentPage) {
            // A separate cold ordinary read can deliver current inline displays while the query key is in flight.
            await act(async () => {
                await fetchAndApplySessions({
                    serverId, credentials, encryption, sessionDataKeys, contentDemand: 'list-projection',
                    accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(),
                    request: async () => Response.json(V2SessionListResponseSchema.parse({
                        sessions: sessions.slice(1), nextCursor: null, hasNext: false,
                    })),
                    getCurrentSessionListRenderable: id => readRows()?.[id],
                    applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
                    applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
                    applySessions() {}, log: { log() {} },
                });
            });
            expect(sessions.slice(1).map(row => readRows()?.[row.id]?.metadata?.name))
                .toEqual(sessions.slice(1).map((_, index) => `Session ${index + 1}`));
            expect(readRows()?.[sessions[0]!.id]).toBeUndefined();
        }
        const beforeQueryPublication = commits;
        publications.length = 0;
        await act(async () => {
            releaseKeys.resolve();
            await hydration;
        });
        const hydrated = mounted.getCurrent();
        expect(hydrated.inventory?.map(machine => machine.id)).toEqual(machines.map(machine => machine.id));
        expect(sessions.map(({ id }) => [id, hydrated.rows?.[id]?.metadata?.name]))
            .toEqual(sessions.map((row, index) => [row.id, `Session ${index}`]));
        expect.soft(detailReads).toEqual([]);
        expect.soft(commits - beforeQueryPublication).toBe(1);
        expect.soft(publications).toHaveLength(1);
        expect.soft(publications.at(-1)).toBe(hydrated.rows);

        const beforeReplay = commits;
        publications.length = 0;
        await act(async () => { await refresh(); });
        expect.soft(commits - beforeReplay).toBe(0);
        expect.soft(publications).toHaveLength(0);
        expect(mounted.getCurrent().rows).toBe(hydrated.rows);
    } finally {
        releaseKeys.resolve();
        await hydration?.catch(() => {});
        stop();
        await mounted.unmount();
        encryption.retireAccountMaterial();
        encoder.retireAccountMaterial();
    }
});

it.each([1, 10, 50])('publishes %i background Session documents in one hydration and skips equal replay', async count => {
    const serverId = `background-hydration-${count}`;
    const records = Array.from({ length: count }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({
        id: `background-${index}`, metadata: { name: `Background ${index}`, path: '/workspace', host: 'machine' },
    }));
    const byId = new Map(records.map(record => [record.id, record]));
    const readRows = () => storage.getState().sessionListRowsByServerId[serverId];
    const readSessions = () => storage.getState().sessions;
    const refresh = () => fetchAndApplySessions({
        serverId, credentials: { token: 'background-hydration' }, encryption: null,
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), sessionDataKeys: new Map(),
        publishHydrationWhenComplete: true,
        sessionListBackgroundHydrationMaxRows: count,
        sessionListBackgroundHydrationConcurrencyLimit: 1,
        sessionListBackgroundHydrationYieldEveryRows: 4,
        sessionListBackgroundHydrationYieldDelayMs: 16,
        sessionListBackgroundHydrationApplyBatchSize: 4,
        sessionListBackgroundHydrationApplyFlushDelayMs: 64,
        request: async (path, init) => {
            if (path === '/v2/sessions/read-batch') {
                const ids = (JSON.parse(String(init.body)) as { sessionIds: string[] }).sessionIds;
                return Response.json({ results: ids.map(id => ({
                    sessionId: id, detail: { status: 200, body: { session: byId.get(id) } },
                })) });
            }
            return Response.json(V2SessionListResponseSchema.parse({
                sessions: records.map(createCompactSessionListRowFixture), nextCursor: null, hasNext: false,
            }));
        },
        getExistingSession: id => readSessions()[id],
        getCurrentSessionListRenderable: id => readRows()?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: storage.getState().applySessions,
        log: { log() {} },
    });
    let commits = 0;
    const mounted = await renderHook(() => {
        const sessions = React.useSyncExternalStore(storage.subscribe, readSessions);
        React.useLayoutEffect(() => { commits++; }, [sessions]);
        return records.filter(record => sessions[record.id]).map(record => sessions[record.id]);
    });
    const publications: string[][] = [];
    const stop = storage.subscribe((next, previous) => {
        if (next.sessions === previous.sessions) return;
        const changed = records.filter(record => next.sessions[record.id] !== previous.sessions[record.id]);
        if (changed.length) publications.push(changed.map(record => record.id));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
        const initialCommit = commits;
        await act(async () => { await refresh(); });
        expect(mounted.getCurrent()).toEqual([]);
        for (let index = 0; index < Math.ceil(count / 4) + 5; index++) {
            // Let each real scheduler yield and apply deadline pass in its own React turn.
            await act(async () => { await vi.advanceTimersByTimeAsync(16); });
        }
        const ids = records.map(record => record.id);
        expect(mounted.getCurrent().map(session => session.id)).toEqual(ids);
        expect(ids.map(id => readRows()[id]?.metadata?.name))
            .toEqual(records.map((_, index) => `Background ${index}`));
        expect.soft(publications.map(batch => batch.length), `store publications while applying ${count} background rows`)
            .toEqual([count]);
        expect(publications.flat()).toEqual(ids);
        expect.soft(commits - initialCommit, `mounted commits while applying ${count} background rows`).toBe(1);

        const settledRows = readRows();
        const settledSessions = readSessions();
        const beforeReplay = commits;
        publications.length = 0;
        await act(async () => { await refresh(); });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(publications).toHaveLength(0);
        expect(commits).toBe(beforeReplay);
        expect(readRows()).toBe(settledRows);
        expect(readSessions()).toBe(settledSessions);
    } finally {
        vi.useRealTimers();
        stop();
        await mounted.unmount();
    }
});

it('keeps the transcript title used by @ mentions when demanded metadata hydration advances', async () => {
    const id = 'docs-title-reviewer';
    const serverId = 'docs-title-home';
    let record = createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 1,
        metadata: { path: '/tmp/mr-live-1103-1m6a68c6', host: 'review-machine' } });
    const readRow = () => storage.getState().sessionListRowsByServerId[serverId]?.[id];
    const refresh = () => fetchAndApplySessions({ serverId, credentials: { token: 'docs-title' }, encryption: null,
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), sessionDataKeys: new Map(),
        contentDemand: 'list-projection', requiredHydrationSessionIds: 'all', awaitSessionListHydration: true,
        sessionListBackgroundHydrationMaxRows: 0,
        request: async path => path === '/v2/sessions/read-batch'
            ? Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: record } } }] })
            : Response.json({ sessions: [createCompactSessionListRowFixture(record)] }),
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'append' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions() {}, log: { log() {} },
    });
    await refresh();
    const row = readRow()!;
    const title = 'DOCS-JOURNEY3D smoke: review the bakery plan';
    const titled = buildSessionListRenderableFromSession(buildSessionFromListRenderable(row, { serverId }), row, [{
        kind: 'user-text', id: 'first-prompt', seq: 1, localId: null, createdAt: 1, text: title,
    }]);
    storage.getState().applyServerScopedSessionListRows(serverId, [titled], { source: 'rowOnly', mode: 'append' });
    expect(readComposerSessionSuggestionDisplay({ sessionId: id, serverId })?.title).toBe(title);
    record = { ...record, metadataVersion: record.metadataVersion + 1 };
    await refresh();
    expect(readComposerSessionSuggestionDisplay({ sessionId: id, serverId })?.title).toBe(title);
});

it.each(['display', 'full'] as const)('refuses old Account material under a fresh different fingerprint through the %s reader', async source => {
    const id = `rotated-account-${source}`;
    const serverId = 'rotated-account-display-home';
    const oldSecret = new Uint8Array(32).fill(71);
    const newSecret = new Uint8Array(32).fill(72);
    const credentials = { token: 'rotated-account-token', secret: encodeBase64(oldSecret) };
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: newSecret } }).contentPublicKeyFingerprint);
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { name: 'Old private owner', path: '/old-private-owner', host: 'old-host' } });
    const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Current shared title', updatedAt: 3 } });
    const record = { ...createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3 }),
        metadata: JSON.stringify(sharedMetadata), ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret: oldSecret }, ownerMetadata, randomBytes: size => new Uint8Array(size).fill(73) }) };
    const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
    const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'e2ee', credentials });
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 3, metadataLayoutVersion: 1,
        shared: await crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner!) });
    let fullReads = 0;
    const readRow = () => storage.getState().sessionListRowsByServerId[serverId]?.[id];
    await fetchAndApplySessions({ serverId, credentials, encryption: null,
        accountCurrentness: { mode: 'e2ee', version: 2, signingKeyFingerprint: 'current-signing', contentKeyFingerprint: fingerprint,
            updatedAt: 2, recipientEnvelopeReadiness: { status: 'available' } },
        sessionDataKeys: new Map(), contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0,
        request: async path => {
            if (path === '/v2/sessions/read-batch') {
                fullReads++;
                return Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: record } } }] });
            }
            return Response.json({ sessions: [{ ...createCompactSessionListRowFixture(record),
                ...(source === 'display' ? { displayProjectionV1: projection } : {}) }] });
        },
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect.soft(fullReads).toBe(1);
    expect.soft(readRow()?.metadata?.name).not.toBe('Old private owner');
    expect.soft(readRow()?.metadata?.path).not.toBe('/old-private-owner');
    expect.soft(readRow()?.metadataUnavailable).toBe(true);
    expect(readRow()?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion).toBeUndefined();
});

it('proves Account material once per list read, however many E2EE owner displays it opens', async () => {
    const serverId = 'owner-material-once-home';
    const secret = new Uint8Array(32).fill(74);
    const credentials = { token: 'owner-material-once-token', secret: encodeBase64(secret) };
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'e2ee', credentials });
    const rows = await Promise.all(['a', 'b', 'c', 'd'].map(async suffix => {
        const id = `owner-material-${suffix}`;
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: `Private ${suffix}`, path: `/private/${suffix}`, host: 'host' },
            runtime: { agentRuntimeCapabilitiesV1: { backend: { session: { media: { acceptsImageInput: { supported: false } } } } } },
        });
        const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Shared', updatedAt: 3 } });
        const record = { ...createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3 }), metadata: JSON.stringify(sharedMetadata),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata, randomBytes: size => new Uint8Array(size).fill(75) }) };
        const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        return { id, row: { ...createCompactSessionListRowFixture(record), displayProjectionV1: SessionDisplayProjectionV1Schema.parse({ v: 1,
            sourceMetadataVersion: 3, metadataLayoutVersion: 1, shared: await crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner!) }) } };
    }));
    const readRow = (id: string) => storage.getState().sessionListRowsByServerId[serverId]?.[id];
    const derivations = vi.spyOn(tweetnacl.box.keyPair, 'fromSecretKey');
    await fetchAndApplySessions({ serverId, credentials, encryption: null,
        accountCurrentness: { mode: 'e2ee', version: 2, signingKeyFingerprint: 'current-signing', contentKeyFingerprint: fingerprint,
            updatedAt: 2, recipientEnvelopeReadiness: { status: 'available' } },
        sessionDataKeys: new Map(), contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0,
        request: async path => {
            if (path === '/v2/sessions/read-batch') throw new Error('Owner displays need no full read');
            return Response.json({ sessions: rows.map(({ row }) => row) });
        },
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: list => storage.getState().applyServerScopedSessionListRows(serverId, list, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: list => storage.getState().applySessions(list), log: { log() {} },
    });
    const opened = rows.map(({ id }) => readRow(id)?.metadata?.name);
    const proofs = derivations.mock.calls.length;
    derivations.mockRestore();
    expect(opened).toEqual(['Private a', 'Private b', 'Private c', 'Private d']);
    expect(rows.map(({ id }) => readRow(id)?.imageInputAvailability)).toEqual(rows.map(() => ({
        available: false, reason: 'image_input_unsupported',
    })));
    expect(proofs).toBe(1);
});

it('renders a cold current owner display without reading or publishing full Session documents', async () => {
    const serverId = 'cold-display-home';
    const id = 'cold-display';
    const recovery = SessionUsageLimitRecoveryV1Schema.parse({ v: 1, status: 'waiting',
        issueFingerprint: 'usage-limit:unknown-agent:unknown-turn:1000:no-reset', armedAtMs: 1_000,
        resetAtMs: null, nextCheckAtMs: null, attemptCount: 1, maxAttempts: 3, lastProbeError: null,
        selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'private-group', profileId: null } });
    const record = { ...createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3, active: true, activeAt: 1_000,
        metadata: { name: 'Private title', path: '/private/repo', host: 'private-host', projectId: 'project', workspaceId: 'workspace' } }),
        metadataLayoutVersion: 1,
        latestTurnStatus: 'failed' as const,
        lastRuntimeIssue: { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
            source: 'usage_limit' as const, code: 'usage_limit', occurredAt: 1_000 } };
    const display = projectSessionDisplayV1({
        sharedMetadata: SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Shared title', updatedAt: 3 },
            agentPresentation: { agentId: 'codex' } }),
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1,
            workspace: { name: 'Private title', path: '/private/repo', host: 'private-host', projectId: 'project', workspaceId: 'workspace' },
            work: { sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 3, primaryItemId: 'task',
                items: [{ id: 'task', kind: 'task', origin: 'happier', title: 'Current task', status: 'active', updatedAt: 3 }] } },
            runtime: { sessionUsageLimitRecoveryV1: recovery },
        }),
    });
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 3, metadataLayoutVersion: 1,
        shared: { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: display.shared } },
        owner: { t: 'plain', v: { v: 1, audience: 'owner', purpose: 'session_owner_display', display: display.owner } },
    });
    expect(validateSessionDisplayProjectionV1({ projection, metadataVersion: 3,
        metadataLayoutVersion: record.metadataLayoutVersion, sessionMode: 'plain', accountMode: 'plain' }).ok).toBe(true);
    const wire = { sessions: [{ ...createCompactSessionListRowFixture(record), displayProjectionV1: projection }] };
    expect(V2SessionListResponseSchema.parse(wire).sessions[0]?.displayProjectionV1).toEqual(projection);
    let fullReads = 0;
    const readRow = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    await fetchAndApplySessions({ serverId,
        credentials: { token: 'cold-display-account', secret: '' }, accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(),
        encryption: null, sessionDataKeys: new Map(), contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0,
        request: async path => {
            if (path === '/v2/sessions/read-batch') {
                fullReads++;
                return Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: record } } }] });
            }
            return Response.json(wire);
        },
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect(fullReads).toBe(0);
    expect(readRow(id)).toMatchObject({ metadataVersion: 3, metadata: { name: 'Private title', path: '/private/repo', host: 'private-host',
        projectId: 'project', workspaceId: 'workspace', flavor: 'codex' },
        workDisplay: { v: 1, primaryItem: { id: 'task', title: 'Current task', status: 'active' } } });
    expect(storage.getState().sessions[id]).toBeUndefined();
    const row = readRow(id)!;
    expect(row.metadata?.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'waiting', authSelectionKind: 'group' });
    expect(row.metadata?.sessionUsageLimitRecoveryV1).not.toHaveProperty('selectedAuth');
    const presentationSource = createSessionListPresentationSource(row);
    for (const input of [row, buildSessionFromListRenderable(row)]) {
        expect.soft(createUiSessionAwarenessInput(input, 1_001, { presentationSource }).usageLimitRecovery)
            .toMatchObject({ status: 'waiting', issueFingerprint: recovery.issueFingerprint });
        expect(projectUiSessionAwareness(input, 1_001, { presentationSource }).operational.primary).toBe('usage_limited');
    }
});

it.each([
    { sessionMode: 'plain' as const, accountMode: 'plain' as const },
    { sessionMode: 'plain' as const, accountMode: 'e2ee' as const },
    { sessionMode: 'e2ee' as const, accountMode: 'plain' as const },
    { sessionMode: 'e2ee' as const, accountMode: 'e2ee' as const },
])('opens cold display with independent Session=$sessionMode and Account=$accountMode modes', async ({ sessionMode, accountMode }) => {
    const serverId = 'independent-display-home';
    const id = 'independent-display';
    const secret = new Uint8Array(32).fill(41);
    const key = new Uint8Array(32).fill(42);
    const credentials = sessionMode === 'plain' && accountMode === 'plain'
        ? { token: 'independent-display-account' }
        : { token: 'independent-display-account', secret: encodeBase64(secret) };
    const encoder = await Encryption.create(secret);
    encoder.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    await encoder.initializeSessions(new Map([[id, key]]), { serverId });
    const cipher = encoder.getSessionEncryption(id)!;
    const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, summary: { text: 'Shared encrypted title', updatedAt: 3 } });
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: 'Independent private title', path: '/independent', host: 'host' } });
    const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
    const crypto = createSessionDisplayCrypto({ sessionMode, accountMode, credentials, sessionEncryption: cipher });
    const accountCurrentness = accountMode === 'e2ee' ? createLegacyAccountEncryptionCurrentnessFixture({ secret }) : createPlainAccountEncryptionCurrentnessFixture();
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 3, metadataLayoutVersion: 1,
        shared: await crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner!) });
    expect(validateSessionDisplayProjectionV1({ projection, metadataVersion: 3,
        metadataLayoutVersion: 1, sessionMode, accountMode }).ok).toBe(true);
    expect((await crypto.openSharedDisplay(projection.shared)).ok).toBe(true);
    expect(crypto.openOwnerDisplay(projection.owner, accountCurrentness).ok).toBe(true);
    const sharedPayload = projection.shared.t === 'plain' ? projection.shared.v : await cipher.decryptRaw(projection.shared.c);
    const ownerPayload = projection.owner?.t === 'plain' ? projection.owner.v : projection.owner?.t === 'encrypted'
        ? openAccountScopedBlobCiphertext({ kind: 'session_owner_display', ciphertext: projection.owner.c,
            material: { type: 'legacy', secret } })?.value : undefined;
    expect.soft(sharedPayload).not.toHaveProperty('sessionId');
    expect.soft(ownerPayload).not.toHaveProperty('sessionId');
    const base = createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3,
        metadata: { name: 'Independent private title', path: '/independent', host: 'host' } });
    const record = { ...base, encryptionMode: sessionMode,
        metadata: sessionMode === 'plain' ? JSON.stringify(sharedMetadata) : await cipher.encryptRaw(sharedMetadata),
        ownerMetadata: accountMode === 'plain' ? base.ownerMetadata : sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret }, ownerMetadata, randomBytes: size => new Uint8Array(size).fill(43) }),
        dataEncryptionKey: sessionMode === 'plain' ? null : encodeBase64(await encoder.encryptEncryptionKey(key)),
    };
    const encryption = sessionMode === 'plain' ? null : await Encryption.create(secret);
    encryption?.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    let fullReads = 0;
    let scalarRevision = 1;
    let offeredRecord = record;
    let offeredProjection = projection;
    const inventorySize = sessionMode === 'e2ee' && accountMode === 'e2ee' ? 1_000 : 1;
    const sessionDataKeys = new Map<string, Uint8Array>();
    const readRow = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    const acquire = (explicitDisplayRead = true) => fetchAndApplySessions({ serverId, credentials, encryption,
        accountCurrentness,
        sessionDataKeys, contentDemand: explicitDisplayRead ? 'list-projection' : undefined, sessionListBackgroundHydrationMaxRows: 0,
        request: async path => {
            if (path === '/v2/sessions/read-batch') {
                fullReads++;
                return Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: offeredRecord } } }] });
            }
            return Response.json({ sessions: Array.from({ length: inventorySize }, (_, index) => ({
                ...createCompactSessionListRowFixture({ ...offeredRecord, id: index === 0 ? id : `${id}-${index}` }),
                seq: scalarRevision, updatedAt: scalarRevision, displayProjectionV1: offeredProjection,
            })) });
        },
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    const coldKeyOpens = vi.spyOn(Encryption.prototype, 'decryptEncryptionKeys');
    try {
        await acquire(false);
        expect(coldKeyOpens.mock.calls.flatMap(([values]) => values).length).toBe(0);
        expect(fullReads).toBe(0);
        if (sessionMode === 'e2ee') {
            expect(readRow(id)?.metadata?.name).toBe('Independent private title');
            expect(readRow(id)?.metadata?.path ?? '').toBe('');
            expect(readRow(id)?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion).toBeUndefined();
            const coldRow = readRow(id);
            const releaseOtherHome = retainVisibleSessionListSurfaces([{ serverId: 'other-display-home', sessionId: id }]);
            try { await acquire(false); } finally { releaseOtherHome(); }
            expect(readRow(id)).toBe(coldRow);
            expect(coldKeyOpens.mock.calls.flatMap(([values]) => values).length).toBe(0);
        }
        const releaseVisible = retainVisibleSessionListSurfaces([{ serverId, sessionId: id }]);
        try { await acquire(false); } finally { releaseVisible(); }
        expect(coldKeyOpens.mock.calls.flatMap(([values]) => values).length).toBe(sessionMode === 'e2ee' ? 1 : 0);
    } finally { coldKeyOpens.mockRestore(); }
    expect(fullReads).toBe(0);
    expect(readRow(id)).toMatchObject({ metadataVersion: 3, metadata: { name: 'Independent private title', path: '/independent' } });
    expect(storage.getState().sessions[id]).toBeUndefined();
    const current = readRow(id);
    const cipherReader = encryption?.getSessionEncryption(id);
    const sharedOpens = cipherReader ? vi.spyOn(cipherReader, 'decryptRaw') : null;
    const keyOpens = encryption ? vi.spyOn(encryption, 'decryptEncryptionKeys') : null;
    try {
        await acquire(false);
        expect(readRow(id)).toBe(current);
        scalarRevision = 2;
        await acquire(false);
        expect(readRow(id)).toMatchObject({ seq: 2, updatedAt: 2,
            metadataVersion: 3, metadata: { name: 'Independent private title', path: '/independent' } });
        expect(fullReads).toBe(0);
        expect(sharedOpens?.mock.calls.length ?? 0).toBe(0);
        expect(keyOpens?.mock.calls.flatMap(([values]) => values).length ?? 0).toBe(0);
        expect(storage.getState().sessions[id]).toBeUndefined();
        // An explicit inventory is a real display consumer for every returned row.
        await acquire();
        expect(keyOpens?.mock.calls.flatMap(([values]) => values).length ?? 0)
            .toBe(sessionMode === 'e2ee' ? inventorySize - 1 : 0);
    } finally { sharedOpens?.mockRestore(); keyOpens?.mockRestore(); }

    if (sessionMode === 'e2ee') {
        // Retaining the row/cipher after leaving is not demand for a replacement key.
        const nextKey = new Uint8Array(32).fill(44);
        await encoder.initializeSessions(new Map([[id, nextKey]]), { serverId });
        const nextCipher = encoder.getSessionEncryption(id)!;
        const nextCrypto = createSessionDisplayCrypto({ sessionMode, accountMode, credentials, sessionEncryption: nextCipher });
        offeredRecord = { ...record, metadataVersion: 4,
            metadata: await nextCipher.encryptRaw(SessionSharedMetadataV1Schema.parse({ ...sharedMetadata,
                summary: { text: 'Changed shared display', updatedAt: 4 } })),
            dataEncryptionKey: encodeBase64(await encoder.encryptEncryptionKey(nextKey)) };
        offeredProjection = { ...projection, sourceMetadataVersion: 4,
            shared: await nextCrypto.encodeSharedDisplay({ ...display.shared, summaryText: 'Changed shared display' }) };
        const rotatedKeyOpens = vi.spyOn(encryption!, 'decryptEncryptionKeys');
        try {
            await acquire(false);
            expect(rotatedKeyOpens.mock.calls.flatMap(([values]) => values).length).toBe(0);
            expect(readRow(id)?.metadata?.name).toBe('Independent private title');
            expect(readRow(id)?.metadata?.path ?? '').toBe('');
            expect(readRow(id)?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion).toBeUndefined();
            const releaseVisible = retainVisibleSessionListSurfaces([{ serverId, sessionId: id }]);
            try { await acquire(false); } finally { releaseVisible(); }
            expect(rotatedKeyOpens.mock.calls.flatMap(([values]) => values).length).toBe(1);
            expect(readRow(id)?.metadata?.summaryText).toBe('Changed shared display');
            expect(readRow(id)?.metadata?.path).toBe('/independent');
            expect(fullReads).toBe(0);
        } finally { rotatedKeyOpens.mockRestore(); }
    }
});

it.each(['missing', 'unreadable'] as const)('falls back to full owner documents when the required owner display is %s', async kind => {
    const id = `owner-display-${kind}`;
    const serverId = 'owner-display-fallback-home';
    const secret = new Uint8Array(32).fill(51);
    const credentials = { token: 'owner-display-account', secret: encodeBase64(secret) };
    const accountMode = kind === 'unreadable' ? 'e2ee' as const : 'plain' as const;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { name: 'Full owner title', path: '/full-owner', host: 'host' } });
    const record = { ...createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3,
        metadata: { name: 'Full owner title', path: '/full-owner', host: 'host' } }),
        ...(accountMode === 'e2ee' ? { ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy' as const, secret }, ownerMetadata, randomBytes: size => new Uint8Array(size).fill(53) }) } : {}) };
    const display = projectSessionDisplayV1({ sharedMetadata: SessionSharedMetadataV1Schema.parse({ v: 1,
        summary: { text: 'Shared-only title', updatedAt: 3 } }), ownerMetadata });
    const encoder = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode,
        credentials: kind === 'unreadable' ? { ...credentials, secret: encodeBase64(new Uint8Array(32).fill(52)) } : credentials });
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 3, metadataLayoutVersion: 1,
        shared: await encoder.encodeSharedDisplay(display.shared),
        ...(kind === 'unreadable' ? { owner: encoder.encodeOwnerDisplay(display.owner!) } : {}) });
    const wire = { sessions: [{ ...createCompactSessionListRowFixture(record), displayProjectionV1: projection }] };
    expect(V2SessionListResponseSchema.safeParse(wire).success).toBe(true);
    let fullReads = 0;
    const readRow = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    await fetchAndApplySessions({ serverId, credentials, encryption: null,
        accountCurrentness: accountMode === 'e2ee' ? createLegacyAccountEncryptionCurrentnessFixture({ secret }) : createPlainAccountEncryptionCurrentnessFixture(),
        sessionDataKeys: new Map(), contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0,
        request: async path => path === '/v2/sessions/read-batch'
            ? (fullReads++, Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: record } } }] }))
            : Response.json(wire),
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect(fullReads).toBe(1);
    expect(readRow(id)?.metadata).toMatchObject({ name: 'Full owner title', path: '/full-owner' });
    expect(storage.getState().sessions[id]).toBeUndefined();
});

it('opens a shared audience display without requiring or carrying an owner leaf', async () => {
    const id = 'shared-display';
    const serverId = 'shared-display-home';
    const { ownerMetadata: _ownerMetadata, ...base } = createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 3 });
    const record = { ...base, agentState: null,
        share: { accessLevel: 'view' as const, canApprovePermissions: false },
        effectiveAccess: { v: 1 as const, level: 'view' as const, sources: [], capabilities: createSessionAccessFixture('view').capabilities } };
    const display = projectSessionDisplayV1({ sharedMetadata: SessionSharedMetadataV1Schema.parse({ v: 1,
        summary: { text: 'Shared recipient title', updatedAt: 3 } }) });
    const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', credentials: { token: 'shared-display', secret: '' } });
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 3, metadataLayoutVersion: 1,
        shared: await crypto.encodeSharedDisplay(display.shared) });
    const wire = { sessions: [{ ...createCompactSessionListRowFixture(record), displayProjectionV1: projection }] };
    expect(V2SessionListResponseSchema.safeParse(wire).success).toBe(true);
    let fullReads = 0;
    const readRow = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    await fetchAndApplySessions({ serverId, credentials: { token: 'shared-display', secret: '' }, encryption: null,
        sessionDataKeys: new Map(), contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0,
        request: async path => path === '/v2/sessions/read-batch'
            ? (fullReads++, Response.json({ results: [] })) : Response.json(wire),
        getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect(fullReads).toBe(0);
    expect(readRow(id)?.metadata).toMatchObject({ summaryText: 'Shared recipient title' });
    expect(readRow(id)?.metadata?.name).toBeUndefined();
    expect(readRow(id)?.metadata?.path).toBe('');
    expect(storage.getState().sessions[id]).toBeUndefined();
});

it('reads a new shared Action caption after display metadata advances while Agent state stays current', async () => {
    const id = 'display-action-caption';
    const serverId = 'display-action-home';
    const credentials = { token: 'display-action-account', secret: '' };
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { name: 'Action owner', path: '/action', host: 'host' } });
    const initial = createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadataVersion: 1, agentStateVersion: 1,
        metadata: { name: 'Action owner', path: '/action', host: 'host' } });
    const requestId = 'action:display';
    const sharedMetadata = SessionSharedMetadataV1Schema.parse({ v: 1, actionConfirmationsV1: { v: 1,
        requests: { [requestId]: { tool: 'Happier Action confirmation', kind: 'user_action', source: 'happier_action',
            arguments: { actionId: 'session.activity.get', preview: { sessionId: id }, sessionId: id, turnId: 'turn-1' },
            createdAt: 2, turnId: 'turn-1', responseTarget: { kind: 'happier_action_confirmation_v1', requestId,
                actionId: 'session.activity.get', inputDigestV1: `sha256:${'0'.repeat(64)}`,
                runtimeAccountId: 'runtime-account', sessionId: id, turnId: 'turn-1' } } }, completedRequests: {} } });
    const changed = { ...initial, metadataVersion: 2, metadata: JSON.stringify(sharedMetadata),
        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1 };
    const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
    const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'plain', credentials });
    const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: 2, metadataLayoutVersion: 1,
        shared: await crypto.encodeSharedDisplay(semantic.shared), owner: crypto.encodeOwnerDisplay(semantic.owner!) });
    let advanced = false;
    let fullReads = 0;
    const readRow = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    const acquire = (fullDemand: boolean) => fetchAndApplySessions({ serverId, credentials, encryption: null,
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), sessionDataKeys: new Map(),
        contentDemand: fullDemand ? 'session' : 'list-projection', requiredHydrationSessionIds: fullDemand ? [id] : [],
        awaitSessionListHydration: true, sessionListBackgroundHydrationMaxRows: 0,
        request: async path => {
            const record = advanced ? changed : initial;
            if (path === '/v2/sessions/read-batch') {
                fullReads++;
                return Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: record } } }] });
            }
            return Response.json({ sessions: [{ ...createCompactSessionListRowFixture(record),
                ...(advanced ? { displayProjectionV1: projection } : {}) }] });
        },
        getExistingSession: sessionId => storage.getState().sessions[sessionId], getCurrentSessionListRenderable: readRow,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    await acquire(true);
    expect(readRow(id)?.currentRequestRef).toBeNull();
    expect(readRow(id)?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedAgentStateVersion).toBe(1);
    advanced = true;
    fullReads = 0;
    await acquire(false);
    expect(fullReads).toBe(1);
    expect(readRow(id)?.currentRequestRef).toMatchObject({ requestId });
    expect(storage.getState().sessions[id]?.metadataVersion).toBe(1);
});
