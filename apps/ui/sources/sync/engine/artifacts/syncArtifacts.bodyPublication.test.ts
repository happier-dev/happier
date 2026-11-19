import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchHttpInputV1Schema, ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import * as approvalAdmission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import React from 'react';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useOpenApprovalArtifactsForSession } from '@/sync/domains/state/storage';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { isInboxArtifactBodyAdmissionComplete, listInboxArtifactBodyHydrationRequests } from '@/sync/domains/artifacts/inboxArtifacts';
import { collectOpenApprovalSessionReferences, isOpenApprovalInboxArtifact, listDiscussionRequesterApprovals,
    listOpenApprovalArtifactsForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/dev/testkit/fixtures/discussionRequesterApprovalArtifact';
import { createArtifactReadBatchHttpResponse, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { readApprovalArtifactDisplayStatus } from '@/components/approvals/approvalStatusLabel';
import { decryptArtifactWithBody, fetchAndApplyArtifactBodies, fetchAndApplyArtifactChanges, fetchAndApplyArtifactsList, handleNewArtifactSocketUpdate, type ArtifactDataKeyCache } from './syncArtifacts';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

afterEach(() => { standardCleanup(); vi.useRealTimers(); });

function createHarness() {
    const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    const artifacts: Artifact[] = Array.from({ length: 6 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent({ title: `Receipt ${index}`, kind: 'approval_request.v1' }),
        body: encodePlainArtifactStoredContent({ body: `Receipt body ${index}` }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    // HTTP is the only substituted boundary; selection, decoding and the store stay real.
    const request = async (_path: string, init?: RequestInit) => {
        const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(JSON.parse(String(init?.body)));
        return Response.json({ items: artifactIds.map(artifactId => ({ artifactId, ok: true,
            artifact: artifacts.find(row => row.id === artifactId), recipientCensus: null })) });
    };
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const params = { credentials: { token: 'body-publication-fixture' }, encryption: null,
        artifactDataKeys, request,
        getCurrentArtifacts: () => store.getState().artifacts,
        applyArtifacts: store.getState().applyArtifacts };
    return { store, artifacts, params };
}

describe('Artifact body hydration publications', () => {
    it('applies and deletes exact Account-change rows through one batched read', async () => {
        const { store, artifacts, params } = createHarness();
        const prior = await decryptArtifactWithBody({ artifact: artifacts[1]!, encryption: null, artifactDataKeys: new Map() });
        if (!prior) throw new Error('Expected readable prior Artifact');
        store.getState().applyArtifacts([prior]);
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const input = ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)));
            if (!('projection' in input)) return createArtifactReadBatchHttpResponse(input, artifactId => ({
                artifactId, ok: true, artifact: artifacts[0]!, recipientCensus: null,
            }));
            expect(input).toEqual({ artifactIds: [artifacts[0]!.id, artifacts[1]!.id], projection: 'headers' });
            const { artifactIds } = input;
            return Response.json({ projection: 'headers', items: [
                { artifactId: artifactIds[0], ok: true, artifact: { ...artifacts[0], body: undefined } },
                { artifactId: artifactIds[1], ok: false, error: 'artifact_not_found', retryable: false, status: 404 },
            ] });
        });

        await fetchAndApplyArtifactChanges({ ...params, request,
            artifactIds: [artifacts[0]!.id, artifacts[1]!.id],
            deleteArtifact: store.getState().deleteArtifact });

        expect(request).toHaveBeenCalledTimes(2);
        expect(store.getState().artifacts[artifacts[0]!.id]).toMatchObject({ title: 'Receipt 0', body: 'Receipt body 0' });
        expect(store.getState().artifacts[artifacts[1]!.id]).toBeUndefined();
    });

    it.each(['failed', 'executed'] as const)('keeps the authoritative %s approval receipt through a header-first Account change', async status => {
        const { store, artifacts, params } = createHarness();
        const open = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'approval-session' }, requestedSurface: 'agent',
            actionId: 'artifact.update', actionArgs: { artifactId: 'document', body: 'updated' }, summary: 'Update document',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'approval-home', sessionId: 'approval-session', actionId: 'artifact.update', requestId: 'request-1' } });
        const terminal = ApprovalRequestV2Schema.parse({ ...open, status, updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: status === 'executed'
                ? { executedAtMs: 2, ok: true, effectAttempted: true, result: { revision: 2 } }
                : { executedAtMs: 2, ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale' } });
        const artifact = { ...artifacts[0]!, kind: 'other' as const,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(open)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(open) }) };
        const opened = await decryptArtifactWithBody({ artifact, encryption: null, artifactDataKeys: new Map() });
        if (!opened) throw new Error('Expected readable open approval');
        store.getState().applyArtifacts([opened]);
        const changed = { ...artifact, headerVersion: 2, bodyVersion: 2, seq: 2, updatedAt: 2,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(terminal)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(terminal) }) };
        const requests: unknown[] = [];
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const input = ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)));
            requests.push(input);
            return 'projection' in input
                ? Response.json({ projection: 'headers', items: [{ artifactId: changed.id, ok: true,
                    artifact: { ...changed, body: undefined } }] })
                : Response.json({ items: [{ artifactId: changed.id, ok: true, artifact: changed, recipientCensus: null }] });
        });

        await fetchAndApplyArtifactChanges({ ...params, request, artifactIds: [changed.id],
            getCurrentArtifacts: () => store.getState().artifacts, deleteArtifact: store.getState().deleteArtifact });

        expect(requests).toEqual([{ artifactIds: [changed.id], projection: 'headers' }, { artifactIds: [changed.id] }]);
        expect(store.getState().artifacts[changed.id]).toMatchObject({
            header: { approvalStatus: status }, body: JSON.stringify(terminal), headerVersion: 2, bodyVersion: 2,
        });
    });

    it('composes terminal approval projections after header-first catch-up and never treats an unavailable row as open', async () => {
        const store = getStorage();
        const previous = store.getState();
        const target = { serverId: 'approval-home', sessionId: 'approval-session' };
        const terminal = (status: 'failed' | 'executed', id: string) => buildDiscussionRequesterApprovalArtifact({
            id, serverId: target.serverId, serverIdentityId: target.serverId, botSessionId: target.sessionId,
            requesterAccountId: 'requester', executionAccountId: 'owner', settle: request => ({ ...request,
                status, updatedAtMs: 20, decision: { kind: 'approve', decidedAtMs: 20,
                    authority: 'present_user', decidingAccountId: 'requester' },
                execution: status === 'executed'
                    ? { executedAtMs: 20, ok: true, effectAttempted: true, result: { revision: 2 } }
                    : { executedAtMs: 20, ok: false, effectAttempted: false,
                        errorCode: 'approval_stale', error: 'approval_stale' },
            }) });
        const ids = {
            failed: '11111111-1111-4111-8111-111111111191',
            executed: '11111111-1111-4111-8111-111111111192',
            unavailable: '11111111-1111-4111-8111-111111111193',
        } as const;
        const open = Object.values(ids).map(id => buildDiscussionRequesterApprovalArtifact({
            id, serverId: target.serverId, serverIdentityId: target.serverId, botSessionId: target.sessionId,
            requesterAccountId: 'requester', executionAccountId: 'owner',
        }));
        const settled = [terminal('failed', ids.failed), terminal('executed', ids.executed)].map(row => ({
            ...row, headerVersion: 2, bodyVersion: 2, seq: 2, updatedAt: 20,
        }));
        const unavailable = { ...open[2]!, headerVersion: 2, bodyVersion: 2, seq: 2, updatedAt: 20 };
        const current = new Map([...settled, unavailable].map(row => [row.id, createPlainArtifactHttpFixture(row, 'owner')]));
        const initial = await Promise.all(open.map(row => decryptArtifactWithBody({
            artifact: createPlainArtifactHttpFixture(row, 'owner'), encryption: null, artifactDataKeys: new Map(),
        })));
        store.setState({ isDataReady: true, artifacts: {} });
        store.getState().applyArtifacts(initial.filter((row): row is NonNullable<typeof row> => row !== null));
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const input = ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)));
            return createArtifactReadBatchHttpResponse(input, artifactId => artifactId === ids.unavailable && !('projection' in input)
                ? { artifactId, ok: false, error: 'artifact_content_unavailable', retryable: false, status: 409 }
                : { artifactId, ok: true, artifact: current.get(artifactId)!, recipientCensus: null });
        });
        try {
            await fetchAndApplyArtifactChanges({ credentials: { token: 'terminal-projection-fixture' },
                artifactIds: Object.values(ids), request, encryption: null, artifactDataKeys: new Map(),
                getCurrentArtifacts: () => store.getState().artifacts, applyArtifacts: store.getState().applyArtifacts,
                deleteArtifact: store.getState().deleteArtifact });
            const artifacts = Object.values(store.getState().artifacts);
            expect(artifacts.filter(isOpenApprovalInboxArtifact)).toEqual([]);
            expect(listOpenApprovalArtifactsForSession(artifacts, target)).toEqual([]);
            expect(collectOpenApprovalSessionReferences(artifacts)).toEqual([]);
            const discussion = listDiscussionRequesterApprovals(artifacts, { serverId: target.serverId, discussionId: 'discussion-1' });
            expect(discussion.map(entry => entry.parsed.request.status)).toEqual(['failed', 'executed']);
            expect([ids.failed, ids.executed].map(id => readApprovalArtifactDisplayStatus(store.getState().artifacts[id]!)))
                .toEqual(['failed', 'executed']);
            const { ApprovalRequesterThreadCard } = await import('@/components/approvals/ApprovalRequesterThreadCard');
            const failed = await renderScreen(React.createElement(ApprovalRequesterThreadCard,
                { approval: discussion[0]!, serverId: target.serverId }));
            const executed = await renderScreen(React.createElement(ApprovalRequesterThreadCard,
                { approval: discussion[1]!, serverId: target.serverId }));
            expect(failed.findByTestId('approval-requester-thread-receipt-stale')).not.toBeNull();
            expect(executed.findByTestId('approval-requester-thread-receipt-done')).not.toBeNull();
            for (const screen of [failed, executed]) {
                expect(screen.findByTestId('approval-requester-thread-approve')).toBeNull();
                expect(screen.findByTestId('approval-requester-thread-decline')).toBeNull();
            }
            expect(request.mock.calls.map(([, init]) => ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)))))
                .toEqual([{ artifactIds: Object.values(ids), projection: 'headers' }, { artifactIds: Object.values(ids) }]);
        } finally { store.setState(previous, true); }
    });

    it('settles one unavailable Inbox Artifact while applying readable change headers', async () => {
        const { store, artifacts, params } = createHarness();
        const priorRows = await Promise.all(artifacts.slice(0, 2).map(artifact => decryptArtifactWithBody({
            artifact,
            encryption: null,
            artifactDataKeys: new Map(),
        })));
        if (!priorRows[0] || !priorRows[1]) throw new Error('Expected readable prior Artifacts');
        store.getState().applyArtifacts([priorRows[0], priorRows[1]]);
        const changed = { ...artifacts[0]!,
            header: encodePlainArtifactStoredContent({ title: 'Changed receipt', kind: 'approval_request.v1' }),
            headerVersion: 2, bodyVersion: 2, seq: 2, updatedAt: 2 };
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const input = ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)));
            if (!('projection' in input)) return createArtifactReadBatchHttpResponse(input, artifactId => ({
                artifactId, ok: true, artifact: changed, recipientCensus: null,
            }));
            expect(input).toMatchObject({ artifactIds: [artifacts[0]!.id, artifacts[1]!.id], projection: 'headers' });
            return Response.json({ projection: 'headers', items: [
                { artifactId: artifacts[0]!.id, ok: true, artifact: { ...changed, body: undefined } },
                { artifactId: artifacts[1]!.id, ok: false, error: 'artifact_content_unavailable', retryable: false, status: 409 },
            ] });
        });

        await fetchAndApplyArtifactChanges({ ...params, request,
            artifactIds: [artifacts[0]!.id, artifacts[1]!.id],
            getCurrentArtifacts: () => store.getState().artifacts,
            deleteArtifact: store.getState().deleteArtifact });

        expect(request).toHaveBeenCalledTimes(2);
        expect(store.getState().artifacts[artifacts[0]!.id]).toMatchObject({
            title: 'Changed receipt', headerVersion: 2, bodyVersion: 2, body: 'Receipt body 0', isDecrypted: true,
        });
        expect(store.getState().artifacts[artifacts[1]!.id]).toMatchObject({
            id: artifacts[1]!.id, body: undefined, isDecrypted: false,
            availability: { kind: 'locked', reason: 'invalid_stored_content' },
        });
        const settledRows = Object.values(store.getState().artifacts);
        expect(listInboxArtifactBodyHydrationRequests(settledRows, 'server', 'owner')).toEqual([]);
        expect(isInboxArtifactBodyAdmissionComplete(settledRows, 'owner')).toBe(false);
    });

    it.each(['plain', 'e2ee'] as const)('admits a socket approval once through unchanged list/body revalidation (%s)', async mode => {
        await loadSyncSingletonForTests();
        const store = getStorage();
        const previous = store.getState();
        const target = { serverId: 'socket-refresh-home', sessionId: `socket-refresh-${mode}` };
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: target.sessionId }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
            origin: { kind: 'transcript_tool_call', sessionId: target.sessionId, toolCallId: 'native' } });
        const header = buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: target.serverId });
        const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(17)) : null;
        const dataKey = new Uint8Array(32).fill(18);
        const codec = new ArtifactEncryption(dataKey);
        const sealHeader = async (value: typeof header) => mode === 'plain'
            ? encodePlainArtifactStoredContent(value) : codec.encryptHeader(value);
        let artifact: Artifact = {
            id: mode === 'plain' ? '11111111-1111-4111-8111-111111111181' : '11111111-1111-4111-8111-111111111182',
            ownerAccountId: 'owner', access: 'owner', encryptionMode: mode, publicAudience: 'none', kind: 'other',
            header: await sealHeader(header), body: mode === 'plain'
                ? encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) : await codec.encryptBody({ body: JSON.stringify(approval) }),
            dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(dataKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        };
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const params = { credentials: { token: 'socket-refresh-fixture' }, encryption, artifactDataKeys,
            applyArtifacts: store.getState().applyArtifacts };
        let bodyReads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/artifacts?')) return Response.json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            expect(ArtifactReadBatchInputV1Schema.parse(JSON.parse(String(init?.body))).artifactIds).toEqual([artifact.id]);
            bodyReads++;
            return Response.json({ items: [{ artifactId: artifact.id, ok: true, artifact,
                recipientCensus: mode === 'plain' ? null : { artifactId: artifact.id, ownerAccountId: artifact.ownerAccountId,
                    access: artifact.access, encryptionMode: mode, dataEncryptionKey: artifact.dataEncryptionKey,
                    callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] } }] });
        };
        const refresh = () => {
            const startedWith = store.getState().artifacts;
            return fetchAndApplyArtifactsList({ ...params, request, inventoryReadStartedWith: startedWith,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, source === 'inventory' ? startedWith : undefined) });
        };
        store.setState({ isDataReady: true, artifacts: {}, artifactsLoaded: true });
        const admit = vi.spyOn(approvalAdmission, 'approvalArtifactBodyMatchesHeaderV1');
        let publications = 0;
        const hook = await renderHook(() => {
            const selected = useOpenApprovalArtifactsForSession(target);
            publications++;
            return selected;
        });
        try {
            publications = 0;
            await act(async () => handleNewArtifactSocketUpdate({ ...params, ...artifact, artifactId: artifact.id,
                addArtifact: store.getState().addArtifact, invalidateArtifactsSync: () => {}, log: { log: () => {} } }));
            expect(hook.getCurrent()).toHaveLength(1);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(publications).toBe(1);
            const arrived = hook.getCurrent();
            publications = 0;
            await act(async () => { await refresh(); });
            await act(async () => { await fetchAndApplyArtifactBodies({ ...params, request, artifactIds: [artifact.id] }); });
            expect(admit).toHaveBeenCalledTimes(1);
            expect(publications).toBe(0);
            expect(hook.getCurrent()).toBe(arrived);
            expect(bodyReads).toBe(1); // Only the explicit unchanged-body positive control, not the list.
            expect(store.getState().artifacts[artifact.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner' });

            // A new header revision cannot borrow the old admission, even with the same stored body.
            artifact = { ...artifact, headerVersion: 2, seq: 2, updatedAt: 2,
                header: await sealHeader({ ...header, title: 'Invalid duplicated approval title' }) };
            await act(async () => { await refresh(); });
            expect(hook.getCurrent()).toHaveLength(0);
            expect(admit.mock.calls.length).toBeGreaterThan(1);
            expect(bodyReads).toBe(1);
            expect(store.getState().artifacts[artifact.id]?.body).toBeUndefined();
        } finally {
            await hook.unmount();
            admit.mockRestore();
            store.setState(previous);
        }
    });

    it('retains an explicitly admitted body on unchanged inventory and revokes it without acquiring a changed revision', async () => {
        const { store, artifacts, params } = createHarness();
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        let artifact = { ...artifacts[0]!, kind: 'other' as const,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
        let reads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/artifacts?')) return Response.json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            expect(JSON.parse(String(init?.body)).artifactIds).toEqual([artifact.id]);
            reads += 1;
            return Response.json({ items: [{ artifactId: artifact.id, ok: true, artifact, recipientCensus: null }] });
        };
        const refresh = () => {
            const startedWith = store.getState().artifacts;
            return fetchAndApplyArtifactsList({ ...params, request, inventoryReadStartedWith: startedWith,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, source === 'inventory' ? startedWith : undefined) });
        };
        await refresh();
        expect(store.getState().artifacts[artifact.id]?.body).toBeUndefined();
        expect(reads).toBe(0);
        await fetchAndApplyArtifactBodies({ ...params, request, artifactIds: [artifact.id] });
        const opened = store.getState().artifacts[artifact.id];
        expect(opened?.body).toBe(JSON.stringify(approval));
        await refresh();
        expect(reads).toBe(1);
        expect(store.getState().artifacts[artifact.id]).toBe(opened);
        artifact = { ...artifact, bodyVersion: 2, seq: 2, updatedAt: 2,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...approval, updatedAtMs: 2 }) }) };
        await refresh();
        expect(reads).toBe(1);
        expect(store.getState().artifacts[artifact.id]?.body).toBeUndefined();
    });

    it('publishes one completed body batch once and suppresses an equal replay', async () => {
        const { store, artifacts, params } = createHarness();
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const read = () => fetchAndApplyArtifactBodies({ ...params, artifactIds: artifacts.map(row => row.id) });
        try {
            await read();
            expect(Object.values(store.getState().artifacts).map(row => row.body)).toEqual(artifacts.map((_, index) => `Receipt body ${index}`));
            expect(publications).toBe(1);
            const before = store.getState();
            await read();
            expect(store.getState()).toBe(before);
            expect(publications).toBe(1);
        } finally { off(); }
    });

    it('makes a ready body batch usable without advancing a publication timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { store, artifacts, params } = createHarness();
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const pending = fetchAndApplyArtifactBodies({ ...params, artifactIds: artifacts.map(row => row.id) });
        try {
            // HTTP/body decoding drains its microtasks, while publication timers stay frozen.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(Object.keys(store.getState().artifacts)).toHaveLength(6);
            expect(publications).toBe(1);
        } finally {
            await vi.runAllTimersAsync();
            await pending;
            off();
        }
    });

    it('does not hold ready bodies behind an unrelated unfinished read', async () => {
        const { store, artifacts, params } = createHarness();
        const held = createDeferred<Response>();
        const pending = fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => held.promise });
        try {
            await Promise.all(artifacts.slice(1).map(row => fetchAndApplyArtifactBodies({ ...params, artifactIds: [row.id] })));
            expect(Object.keys(store.getState().artifacts)).toHaveLength(5);
            expect(store.getState().artifacts[artifacts[0]!.id]).toBeUndefined();
        } finally {
            held.resolve(await params.request('/v1/artifacts/read', { body: JSON.stringify({ artifactIds: [artifacts[0]!.id] }) }));
            await pending;
        }
        expect(Object.keys(store.getState().artifacts)).toHaveLength(6);
    });

    it('rejects cancellation and Account retirement before body publication', async () => {
        const { store, artifacts, params } = createHarness();
        const response = createDeferred<Response>();
        const controller = new AbortController();
        let current = true;
        const pending = Promise.allSettled([
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => response.promise, signal: controller.signal }),
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => response.promise, shouldContinue: () => current }),
        ]);
        controller.abort();
        current = false;
        response.resolve(await params.request('/v1/artifacts/read', { body: JSON.stringify({ artifactIds: [artifacts[0]!.id] }) }));
        await pending;
        expect(store.getState().artifacts).toEqual({});
    });
});
