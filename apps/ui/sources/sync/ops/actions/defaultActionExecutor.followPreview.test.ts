import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createPlainSessionByIdResponseFixture, createSessionOwnerViewerFixture, createSessionAccessFixture, createSessionViewerFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SESSION_LIST_PAGE_MAX_LIMIT, SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { FollowReceiverRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { Encryption } from '@/sync/encryption/encryption';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { act, flushHookEffects, renderHook } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { useFollowRuleMatchCounts } = await import('@/components/sessions/follow/followRuleMatchCounts');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const initial = getStorage().getState();
let restoredAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
function queryRow(session: ReturnType<typeof createSessionFixture>) {
    return { ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) };
}
async function addAppliedHome(name: string, serverUrl: string) {
    const serverId = await homes.addHome({ name, serverUrl, accountId: 'alice', currentAccount: true });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    expect(restoredAccount.serverId).toBe(serverId);
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    return serverId;
}
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await restoredAccount?.dispose(); restoredAccount = undefined;
    getStorage().setState(initial, true); standardCleanup(); });

it('keeps mounted rule counts current after source changes without restarting useful reads for unrelated traffic', async () => {
    const serverId = await addAppliedHome('Rule counts', 'https://rule-counts.test');
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const member = (id: string) => queryRow(createSessionFixture({ id, serverId, projectKey: 'payments',
        metadata: { path: '/payments', host: 'test', projectId: 'payments' } }));
    const page = (ids: string[]) => createSessionListSourceFixture({ sessions: ids.map(member),
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null });
    homes.answer(serverId, '/v2/sessions/query', { body: page(['first']) });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const rules = [{ key: 'payments', filter }];
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useFollowRuleMatchCounts(enabled ? serverId : null, 'receiver', rules),
        { initialProps: { enabled: true } });
    const counts = (count: number) => expect(hook.getCurrent().payments).toMatchObject({ status: 'ready',
        preview: { coverage: 'complete', matchCount: count } });
    await vi.waitFor(() => counts(1));
    const reads = () => homes.requests.filter(request => request.path === '/v2/sessions/query').length;
    const before = reads();
    await act(async () => {
        publishHomeAccountChange(serverId, ['unrelated-artifact'], { changeKinds: ['artifact'] });
        publishHomeAccountChange('another-home', ['new-member'], { changeKinds: ['session'] });
    });
    await flushHookEffects();
    expect(reads()).toBe(before);

    // A thousand Sessions can stream without changing any filter fact. The
    // focused change planner proves that these arrivals need no corpus read.
    await act(async () => {
        for (let index = 0; index < 1_000; index++) {
            publishHomeAccountChange(serverId, [`streaming-${index}`], {
                changeKinds: ['session'], sessionListQueryAffects: false,
            });
        }
    });
    await flushHookEffects();
    expect(reads() - before).toBe(0);
    counts(1);

    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    homes.answer(serverId, '/v2/sessions/query', { body: page(['first', 'second']), respondAfter: held });
    try {
        await act(async () => publishHomeAccountChange(serverId, ['second'], { changeKinds: ['session'] }));
        await vi.waitFor(() => expect(reads()).toBe(before + 1));
        counts(1); // Useful last-known data survives refresh.
        await act(async () => {
            for (let index = 0; index < 8; index++) publishHomeAccountChange(serverId, ['third'], { changeKinds: ['session'] });
        });
        await flushHookEffects();
        expect(reads()).toBe(before + 1);
        homes.answer(serverId, '/v2/sessions/query', { body: page(['first', 'second', 'third']) });
    } finally { await act(async () => release?.()); }
    await vi.waitFor(() => counts(3));
    expect(reads()).toBe(before + 2);
    await hook.rerender({ enabled: false });
    expect(hook.getCurrent()).toEqual({});
    await act(async () => publishHomeAccountChange(serverId, ['fourth'], { changeKinds: ['session'] }));
    await flushHookEffects();
    expect(reads()).toBe(before + 2);
    await hook.unmount();
});

it.each(['cold', 'newer-row', 'provenance-filter'] as const)('settles Matching from %s encrypted compact query rows through batched display hydration', async state => {
    const serverUrl = 'https://cold-encrypted-preview.test';
    const secret = new Uint8Array(32).fill(4);
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }), secret: encodeBase64(secret, 'base64') };
    const serverId = await homes.addHome({ name: 'Cold encrypted', serverUrl, accountId: 'alice', currentAccount: true,
        accountEncryptionMode: 'e2ee', credentials });
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } });
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [] } });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const encryption = await Encryption.create(secret);
    const key = new Uint8Array(32).fill(7);
    const cipher = await encryption.openEncryption(key);
    const base = queryRow(createSessionFixture({ id: 'cold-member', active: false, projectKey: 'payments',
        metadata: { path: '/payments', host: 'test', projectId: 'payments' } }));
    if (base.ownerMetadata?.t !== 'plain') throw new Error('Expected the canonical plaintext fixture owner envelope');
    const [metadata] = await cipher.encrypt([JSON.parse(base.metadata)]);
    const row = { ...base, ownerAccountId: 'alice', origin: { kind: 'none' as const }, encryptionMode: 'e2ee' as const, metadata: encodeBase64(metadata!, 'base64'),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: base.ownerMetadata.v,
            material: material.material, randomBytes: length => new Uint8Array(length).fill(3) }),
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64') };
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const foreignBase = queryRow(createSessionFixture({ id: 'other-account', accessLevel: 'view', viewer: createSessionViewerFixture(),
        metadata: { path: '/payments', host: 'test', projectId: 'payments' } }));
    const { ownerMetadata: _ownerMetadata, ...sharedRow } = row;
    const rows = createSessionListSourceFixture({ sessions: state === 'provenance-filter' ? [
        ...Array.from({ length: 1_000 }, (_, index) => ({ ...row, id: `automation-${index}`,
            origin: { kind: 'run_step' as const, runId: 'workflow' } })),
        { ...sharedRow, ...foreignBase, ownerAccountId: 'other', origin: { kind: 'none' as const },
            encryptionMode: 'e2ee', metadata: row.metadata, dataEncryptionKey: row.dataEncryptionKey },
        row,
    ] : [row], nextCursor: null, hasNext: false, attentionHasNext: false, attentionNextCursor: null }).sessions;
    const pageOffsets = new Map<string, number>();
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        const offset = query.cursor ? pageOffsets.get(query.cursor)! : 0;
        const end = offset + SESSION_LIST_PAGE_MAX_LIMIT;
        const nextCursor = end < rows.length ? encodeV2SessionListCursorV1(`offset-${end}`) : null;
        if (nextCursor) pageOffsets.set(nextCursor, end);
        return { body: createSessionListSourceFixture({ sessions: rows.slice(offset, end),
            hasNext: nextCursor !== null, nextCursor, attentionHasNext: false, attentionNextCursor: null }) };
    } });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: state === 'provenance-filter' ? ['you'] : ['you', 'agents', 'triggers'], projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    if (state === 'newer-row') {
        // Establish the newer row through its real admission and hydration owner.
        homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
            sessions: [{ ...row, seq: row.seq + 1, updatedAt: row.updatedAt + 1 }],
            hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
        }) });
        expect(await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
            { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ ok: true });
        homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
            sessions: rows, hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
        }) });
    }
    const decrypts = vi.spyOn(SessionEncryption.prototype, 'decryptMetadataPayload');
    const preview = await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(homes.requests.filter(request => request.path === '/v2/sessions/query'), JSON.stringify(preview))
        .toHaveLength(Math.ceil(rows.length / SESSION_LIST_PAGE_MAX_LIMIT) + (state === 'newer-row' ? 1 : 0));
    const applied = getStorage().getState().sessionListRowsByServerId[serverId]?.['cold-member'];
    expect(applied, JSON.stringify({ applied, preview })).toMatchObject({ encryptedContentAvailability: 'ready',
        metadata: { projectId: 'payments' }, seq: state === 'newer-row' ? row.seq + 1 : row.seq });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
        matches: [{ source: { kind: 'session', sessionId: 'cold-member' } }] } });
    const initialDocumentReads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
    expect(initialDocumentReads).toHaveLength(1);
    expect(SessionReadBatchRequestV1Schema.parse(initialDocumentReads[0]!.input)).toMatchObject({
        sessionIds: ['cold-member'], includeTurns: false, includeMessages: false,
    });
    if (state === 'provenance-filter') expect(decrypts.mock.calls).toHaveLength(1);
    decrypts.mockRestore();
    expect(await createDefaultActionExecutor().previewSessionTargets({ selector: 'matching', filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ coverage: 'complete',
        addresses: [{ serverId, sessionId: 'cold-member' }] });
    if (state === 'provenance-filter') {
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'alice' };
        const [narrow, broad, empty] = await Promise.all([
            executor.previewSessionTargets({ selector: 'matching', filter }, context),
            executor.previewSessionTargets({ selector: 'matching', filter: { ...filter, startedBy: ['you', 'agents', 'triggers'], projects: undefined } }, context),
            executor.previewSessionTargets({ selector: 'matching', filter: { ...filter, startedBy: [] } }, context),
        ]);
        // Same HTTP corpus, distinct demanded summaries: sharing a narrowed page would lose valid targets.
        expect(narrow).toMatchObject({ coverage: 'complete', addresses: [{ serverId, sessionId: 'cold-member' }] });
        expect(broad).toMatchObject({ coverage: 'complete' });
        expect(broad.addresses).toHaveLength(rows.length);
        expect(empty).toMatchObject({ coverage: 'complete', addresses: [] });
    }
    const documentReads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
    expect(documentReads.length).toBeGreaterThan(0);
    expect(documentReads.every(request => {
        const input = SessionReadBatchRequestV1Schema.parse(request.input);
        return input.includeTurns === false && input.includeMessages === false;
    })).toBe(true);
    expect(homes.requests.filter(request => /^\/v[12]\/sessions\/cold-member\/messages(?:\?|$)/.test(request.path))).toEqual([]);
});

it('resolves matching through the complete corpus at the transport page bound without attention duplication or mounted membership changes', async () => {
    const serverId = await addAppliedHome('Complete', 'https://complete-preview.test');
    const before = getStorage().getState().ordinarySessionListMembershipByServerId;
    const pages: unknown[] = [];
    const ordinaryCursor = encodeV2SessionListCursorV1('ordinary-next');
    const attentionCursor = encodeV2SessionListCursorV1('attention-next');
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        pages.push(query);
        const id = query.attentionCursor ? 'attention-match' : query.cursor ? 'older-match' : 'first-match';
        return { body: createSessionListSourceFixture({ sessions: [queryRow(createSessionFixture({ id, projectKey: 'payments',
            metadata: { path: '/repo', host: 'test', projectId: 'payments' } }))],
            nextCursor: query.cursor || query.attentionCursor ? null : ordinaryCursor, hasNext: !query.cursor && !query.attentionCursor,
            attentionNextCursor: query.includeAttention && !query.attentionCursor ? attentionCursor : null,
            attentionHasNext: query.includeAttention === true && !query.attentionCursor }) };
    } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    const preview = await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter: { ...filter, show: 'sessions' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(pages[0]).toMatchObject({ limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 2 } });
    expect(await executor.previewSessionTargets({ selector: 'matching', filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ coverage: 'complete', addresses: [
        { serverId, sessionId: 'first-match' }, { serverId, sessionId: 'older-match' },
    ] });
    pages.length = 0;
    const result = await executor.execute('session.status.get', { sessionId: { selector: 'matching', filter } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    // Status effects may fail without a Machine; resolution must nevertheless retain the complete concrete list.
    expect(result, JSON.stringify({ result, pages })).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId, sessionId: 'first-match' } }, { target: { serverId, sessionId: 'older-match' } },
    ] } });
    expect(pages).toHaveLength(2);
    expect(getStorage().getState().ordinarySessionListMembershipByServerId).toEqual(before);
});

it('previews portable-Home rules and Matching against the same captured local Home', async () => {
    const portable = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const serverUrl = 'https://portable-preview.test';
    const serverId = await homes.addHome({ name: 'Portable', serverUrl, serverIdentityId: portable, accountId: 'alice', currentAccount: true });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const candidate = createSessionFixture({ id: 'portable-project-member', serverId, projectKey: 'payments',
        metadata: { path: '/payments', host: 'test', projectId: 'payments' } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({ sessions: [queryRow(candidate)],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null }) });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [portable], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId: portable, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, expectedAccountId: 'alice' };
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, context))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
            matches: [{ source: { kind: 'session', sessionId: candidate.id } }] } });
    expect(await executor.previewSessionTargets({ selector: 'matching', filter }, context))
        .toMatchObject({ coverage: 'complete', addresses: [{ sessionId: candidate.id }] });
});

it.each(['network', 'repeated_cursor', 'metadata_unavailable'] as const)('refuses matching for %s incompleteness', async reason => {
    const serverId = await addAppliedHome('Incomplete', 'https://incomplete-preview.test');
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'] });
    const executor = createDefaultActionExecutor();
    const cursor = encodeV2SessionListCursorV1('next');
    const requestedCursors: (string | undefined)[] = [];
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        requestedCursors.push(query.cursor);
        if (reason === 'network' && query.cursor) return { status: 503, body: { error: 'unavailable' } };
        return { body: createSessionListSourceFixture({
            sessions: [queryRow(createSessionFixture({ id: 'known-candidate' }))],
            hasNext: reason !== 'metadata_unavailable', nextCursor: reason === 'metadata_unavailable' ? null : cursor,
            attentionHasNext: false, attentionNextCursor: null,
            ...(reason === 'metadata_unavailable' ? { metadataUpgradeRequiredCount: 1 } : {}),
        }) };
    } });
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'matching', filter } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' }), reason)
        .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    if (reason !== 'metadata_unavailable') expect(requestedCursors, reason).toContain(cursor);
});

it('previews rules from current authorized query rows without admitting unrelated retained rows', async () => {
    const serverId = await addAppliedHome('Rules', 'https://rules.test');
    const session = createSessionFixture({ id: 'payments', serverId, projectKey: 'payments',
        metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    const retained = createSessionFixture({ ...session, id: 'retained-only' });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session, [retained.id]: retained },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session),
            [retained.id]: buildSessionListRenderableFromSession(retained) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id, retained.id] },
    });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [queryRow(session)], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null,
    }) });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const result = await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
        matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] } });
    expect(homes.requests.filter(request => /^\/v[12]\/sessions(?:\?|$)/.test(request.path))).toEqual([]);
});

it('reports unreadable Project candidates as unavailable and withholds stale Account rows', async () => {
    const serverId = await addAppliedHome('Locked', 'https://locked-preview.test');
    const session = createSessionFixture({ id: 'locked', serverId, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
        metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const shared = queryRow(createSessionFixture({ id: session.id, access: createSessionAccessFixture('edit'),
        viewer: createSessionViewerFixture(), metadata: { path: '/repo', host: 'test', projectId: 'payments' } }));
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [{ ...shared, encryptionMode: 'e2ee', metadata: 'unavailable-encrypted-content' }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId, expectedAccountId: 'alice' }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 0,
            unavailable: [{ serverId, source: { kind: 'session', sessionId: session.id } }] } });
    getStorage().setState({ profileScope: { serverId, accountId: 'old-account' } });
    const stale = await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(stale).toMatchObject({ ok: false });
    expect(stale).not.toHaveProperty('result');
});

it('offers overlaps only with other Session receivers, not personal rules or the current receiver', async () => {
    const serverId = await addAppliedHome('Overlaps', 'https://overlaps-preview.test');
    const session = createSessionFixture({ id: 'payments', serverId, projectKey: 'payments', metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const receiver = { kind: 'session' as const, sessionId: 'current' };
    const rule = (ruleId: string, target: FollowReceiverRefV1) => ({ ruleId, receiver: target, version: 0,
        content: { t: 'plain', v: { v: 1, enabled: true, filter, policy: { preset: 'important' } } } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [
        rule('personal', { kind: 'account' }), rule('current', receiver),
        rule('other', { kind: 'session', sessionId: 'other-coordinator' }),
    ] } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [queryRow(session)], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null,
    }) });
    expect(await createDefaultActionExecutor().execute('follow.preview', { receiver, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
            overlaps: [{ ruleId: 'other', matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] }] } });
});

it('keeps unavailable reads distinct from an empty loaded preview', async () => {
    const serverId = await addAppliedHome('Pending', 'https://pending-preview.test');
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible' });
    const executor = createDefaultActionExecutor();
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    getStorage().setState({ isDataReady: false });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'unavailable', matchCount: 0 } });
    getStorage().setState({ isDataReady: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { status: 503, body: { error: 'unavailable' } });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'unavailable', matchCount: 0 } });
});

it('previews native loaded Runs only in their captured Home and Account', async () => {
    const serverId = await addAppliedHome('Runs', 'https://runs-preview.test');
    getStorage().setState({ isDataReady: true });
    const run = createWorkflowRunSummaryFixture({ id: 'run', ownerAccountId: 'alice', startedBy: 'user' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)], { serverId, accountId: 'alice' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
        id: 'readable-team-run', ownerAccountId: 'bob', visibleTeamId: 'team', startedBy: 'user',
    }))], { serverId, accountId: 'alice' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'foreign', ownerAccountId: 'bob' }))], { serverId, accountId: 'bob' });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'runs', scope: 'all_accessible', startedBy: ['you'] });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 1,
            matches: [{ serverId, source: { kind: 'workflow_run', runId: run.id } }] } });
    homes.answer(serverId, '/v3/automations/runs/workflow-storage', { body: {
        runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {},
    } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [], hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter: { ...filter, underSessionId: 'manager' } }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 0, unavailable: [] } });
    expect(homes.requestsFor('/v3/automations/runs/workflow-storage').at(-1)?.input)
        .toMatchObject({ request: { underSessionId: 'manager' } });
});

it('previews an Under Run only from server-proved descendant membership', async () => {
    const serverId = await addAppliedHome('Under Runs', 'https://under-runs-preview.test');
    getStorage().setState({ isDataReady: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        expect(query.underSessionId).toBe('manager');
        const id = query.cursor ? 'leaf' : 'manager';
        return { body: createSessionListSourceFixture({ sessions: [queryRow(createSessionFixture({ id, serverId }))],
            nextCursor: query.cursor ? null : encodeV2SessionListCursorV1('next-subtree-page'), hasNext: !query.cursor,
            attentionNextCursor: null, attentionHasNext: false }) };
    } });
    const run = createWorkflowRunSummaryFixture({ id: 'descendant-run', ownerAccountId: 'alice', startedBy: 'user',
        origin: { kind: 'direct', originSessionId: 'leaf' } });
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: createWorkflowDefinitionFixture({
        blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }],
    }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
            origin: { kind: 'direct', originSessionId: 'leaf' }, authorization: { principal: { kind: 'host' } },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } } } });
    if (!materialized.ok) throw new Error(`Invalid accepted fixture: ${materialized.error.code}`);
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'alice', runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: 'alice',
        access: 'owner', encryptionMode: 'plain', visibleTeamId: null, dataEncryptionKey: null,
        callerDataEncryptionKey: null, recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    homes.answer(serverId, '/v3/automations/runs/workflow-storage', { select: body => {
        const operation = body as { request: { underSessionId?: string; cursor?: string } };
        expect(operation.request.underSessionId).toBe('manager');
        return { body: operation.request.cursor ? { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope },
            keyCensusByRunId: { [run.id]: census } } : { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, nextCursor: 'next-run-page' } };
    } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'runs', underSessionId: 'manager',
        scope: 'all_accessible', startedBy: ['you'] });
    expect(await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
            matches: [{ serverId, source: { kind: 'workflow_run', runId: run.id } }] } });
});
