import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, projectArtifactBoundaryReadRow } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { fetchArtifactReadBatch, updateArtifact } from '@/sync/api/artifacts/apiArtifacts';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { encodeBase64 } from '@/encryption/base64';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { deriveApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

// Load the real Sync graph before timed test setup; only HTTP and device storage are replaced.
installDisconnectedServerSocketBoundary();
await import('@/sync/syncEngine');

afterEach(() => standardCleanup());

describe('transcript approval hydration', () => {
    it('batches cold settled Discussion requester receipts and keeps unrelated arrivals quiet at Account scale', async () => {
        const { buildDiscussionRequesterApprovalArtifact } = await import('@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit');
        const { createPlainArtifactHttpFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        let inventory: Artifact[] = [];
        const queries: string[] = [], bodyReads: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://discussion-receipt.test',
            accountId: 'session-account', serverIdentityId: 'srv_discussion_receipt', currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                queries.push(request.url.search);
                return createArtifactListHttpResponse(request.url, inventory);
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(request.body);
            bodyReads.push(artifactIds);
            return Response.json({ items: artifactIds.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                artifact: projectArtifactBoundaryReadRow(inventory.find(row => row.id === id)!) })) });
        } });
        const ownRedo = buildDiscussionRequesterApprovalArtifact({
            id: '11111111-1111-4111-8111-111111111902', botSessionId: 's1', actionId: 'doc.edit.propose',
            requesterAccountId: 'session-account', executionAccountId: 'session-account',
            serverId: home.serverId, serverIdentityId: 'srv_discussion_receipt',
        });
        const receipts = [ownRedo, ...['s1', 's2'].map((botSessionId, index) => buildDiscussionRequesterApprovalArtifact({
            id: `11111111-1111-4111-8111-11111111190${index + 3}`, botSessionId,
            serverId: home.serverId, serverIdentityId: 'srv_discussion_receipt', executionAccountId: 'session-account', settle: request => ({ ...request,
                status: 'rejected', updatedAtMs: 20, decision: { kind: 'reject', decidedAtMs: 20,
                    authority: 'present_user', decidingAccountId: 'bob' } }) }))];
        const unrelated = Array.from({ length: 512 }, (_, index) => buildDiscussionRequesterApprovalArtifact({
            id: `11111111-1111-4111-8111-${String(index + 2000).padStart(12, '0')}`,
            botSessionId: `closed-session-${index}`, serverId: home.serverId,
            serverIdentityId: 'srv_discussion_receipt', executionAccountId: 'session-account',
        }));
        inventory = [...receipts, ...unrelated].map(receipt => createPlainArtifactHttpFixture(receipt, 'session-account'));
        const disconnect = await home.restoreActiveConnection();
        try {
            const { storage, useDiscussionRequesterApprovals } = await import('@/sync/domains/state/storage');
            const { decryptArtifactListItems, handleNewArtifactSocketUpdate } = await import('@/sync/engine/artifacts/syncArtifacts');
            // Retained headers model a busy Account; only the two visible Sessions demand bodies.
            const headers = await decryptArtifactListItems({ artifacts: inventory, encryption: null, artifactDataKeys: new Map() });
            let retainedHeaderReads = 0;
            const retainedIds = new Set(unrelated.map(row => row.id));
            for (const row of headers) {
                if (!row || !retainedIds.has(row.id)) continue;
                const header = row.header;
                Object.defineProperty(row, 'header', { enumerable: true, get: () => {
                    retainedHeaderReads += 1;
                    return header;
                } });
            }
            await act(async () => storage.getState().applyArtifacts(headers.filter((row): row is NonNullable<typeof row> => row !== null)));
            const linked = ['s1', 's2'].map(sessionId => ({ serverId: home.serverId, sessionId }));
            const hook = await renderHook(() => useDiscussionRequesterApprovals({ serverId: home.serverId,
                discussionId: 'discussion-1' }, linked));
            try {
                await waitForHomeGovernance(() => expect(hook.getCurrent()).toHaveLength(3));
                const redo = hook.getCurrent().find(entry => entry.artifact.id === ownRedo.id);
                expect(redo).toMatchObject({ kind: 'request', subject: null, originMessageId: 'message-ask' });
                const { placeDiscussionRequesterApprovals } = await import('@/components/discussions/discussionTimelineProjection');
                expect(placeDiscussionRequesterApprovals([{ id: 'message-ask', producerV1: null }], hook.getCurrent())
                    .get('message-ask')?.map(entry => entry.artifact.id)).toContain(ownRedo.id);
                expect(hook.getCurrent().find(entry => entry.artifact.id !== ownRedo.id)?.parsed.request.status).toBe('rejected');
                expect(hook.getCurrent()[0]?.originMessageId).toBe('message-ask');
                expect(queries).toHaveLength(1);
                expect(new URLSearchParams(queries[0]).get('approvalSessionIds')).toBe(JSON.stringify(['s1', 's2']));
                expect(bodyReads).toHaveLength(1);
                expect(bodyReads[0]?.sort()).toEqual(receipts.map(receipt => receipt.id).sort());
                const before = hook.getCurrent();
                retainedHeaderReads = 0;
                await act(async () => { await handleNewArtifactSocketUpdate({
                    artifactId: '11111111-1111-4111-8111-111111119999', createdAt: 30, updatedAt: 30, seq: 30,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1,
                    header: encodePlainArtifactStoredContent({ kind: 'memory_doc.v1', title: 'Unrelated' }),
                    artifactDataKeys: new Map(), encryption: null,
                    addArtifact: row => storage.getState().addArtifact(row),
                    invalidateArtifactsSync: () => { throw new Error('A readable socket header must not trigger an inventory refresh'); },
                    log: { log: () => {} },
                }); });
                expect(hook.getCurrent()).toBe(before);
                expect(queries).toHaveLength(1);
                expect(bodyReads).toHaveLength(1);
                expect(retainedHeaderReads).toBe(0);
                const settledRedo = ApprovalRequestV2Schema.parse({ ...JSON.parse(ownRedo.body!), status: 'rejected', updatedAtMs: 20,
                    decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'session-account' } });
                await act(async () => storage.getState().applyArtifacts([{ ...ownRedo,
                    header: buildApprovalRequestArtifactHeaderV1(settledRedo), body: JSON.stringify(settledRedo),
                    bodyVersion: 2, updatedAt: 20,
                }]));
                expect(hook.getCurrent()).toHaveLength(2);
                expect(hook.getCurrent().some(entry => entry.artifact.id === ownRedo.id)).toBe(false);
            } finally { await hook.unmount(); }
        } finally { await disconnect(); await home.dispose(); }
    });
    it('discovers cold settled receipts only for the visible Session without opening Inbox or other bodies', async () => {
        const portableHome = 'srv_settled_receipt';
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 'visible-session' }, requestedSurface: 'agent',
            actionId: 'session.capabilities.set', actionArgs: { sessionId: 'visible-session', kind: 'skill', id: 'skill-1', state: 'on' }, summary: 'Change capabilities',
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-profile', serverIdentityId: portableHome, sessionId: 'visible-session',
                actionId: 'session.capabilities.set', requestId: 'settled-request' } });
        const receipt = (id: string, approval: typeof request): Artifact => {
            const header = buildApprovalRequestArtifactHeaderV1(approval);
            return { id, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none', kind: 'other', kindHint: 'approval_request.v1',
                ...deriveApprovalArtifactQueryHintsV1(header), header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        };
        const selected = receipt('11111111-1111-4111-8111-111111111901', request);
        const other = receipt('11111111-1111-4111-8111-111111111902', ApprovalRequestV2Schema.parse({ ...request,
            createdBy: { surface: 'agent', sessionId: 'other-session' },
            executionOriginV1: { ...request.executionOriginV1, sessionId: 'other-session' } }));
        const queries: string[] = [], bodyReads: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://settled-receipt.test',
            accountId: 'session-account', serverIdentityId: portableHome, currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                queries.push(request.url.search);
                return createArtifactListHttpResponse(request.url, [selected, other]);
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(request.body);
            bodyReads.push(artifactIds);
            return Response.json({ items: artifactIds.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                artifact: projectArtifactBoundaryReadRow(id === selected.id ? selected : other) })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        try {
            const { storage, useTranscriptApprovalArtifactsForSession } = await import('@/sync/domains/state/storage');
            const { sync } = await import('@/sync/sync');
            // Restoration starts independent server-reachable recovery. Await its
            // real owner before measuring a new visible Session's cold demand.
            await act(async () => { await sync.resumeSync('socket-reconnect'); });
            expect(queries).toEqual([]);
            expect(bodyReads).toEqual([]);
            expect(storage.getState().artifacts).toEqual({});
            const presentations = [() => true];
            const hook = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId,
                sessionId: 'visible-session' }, presentations));
            try {
                await waitForHomeGovernance(() => expect(hook.getCurrent()).toHaveLength(1));
                expect(hook.getCurrent()[0]?.approval.status).toBe('executed');
                expect(queries).toHaveLength(1);
                expect(new URLSearchParams(queries[0]).get('approvalSessionIds')).toBe(JSON.stringify(['visible-session']));
                expect(bodyReads).toEqual([[selected.id]]);
                expect(storage.getState().artifacts[other.id]).toBeUndefined();
                expect(storage.getState().artifactsLoaded).toBe(false);
                expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
            } finally { await hook.unmount(); }
        } finally { await disconnect(); await home.dispose(); }
    });
    it('recovers a cold transcript approval through mounted shell demand and refreshes its exact receipt on reconnect without visiting Inbox', async () => {
        const portableHome = 'srv_cold_approval_retry';
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.capabilities.set', actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change session capabilities',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-cli-profile', serverIdentityId: portableHome, sessionId: 's1',
                actionId: 'session.capabilities.set', requestId: 'cold-request' } });
        const artifactId = '11111111-1111-4111-8111-111111111171';
        const artifact: Artifact = { id: artifactId, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            ...deriveApprovalArtifactQueryHintsV1(buildApprovalRequestArtifactHeaderV1(approval)),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none', kind: 'other', kindHint: 'approval_request.v1',
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const failed = createDeferred<void>();
        const retry = createDeferred<void>();
        let listReads = 0;
        let cursorGone = false;
        let currentApproval = approval;
        let currentArtifact = artifact;
        let changesReads = 0;
        let servedGone = 0;
        const listSelections: Array<string | null> = [];
        const bodyReads: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://cold-approval-retry.test',
            accountId: 'session-account', serverIdentityId: portableHome, currentAccount: true }], route: async request => {
            if (request.path === '/v2/cursor') return Response.json({ cursor: 1, changesFloor: 0 });
            if (request.path === '/v2/changes') {
                changesReads++;
                if (cursorGone) {
                    servedGone++;
                    cursorGone = false;
                    return Response.json({ error: 'cursor-gone', currentCursor: 1 }, { status: 410 });
                }
                return Response.json({ changes: [], nextCursor: 1 });
            }
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                listSelections.push(request.url.searchParams.get('kinds'));
                if (++listReads === 1) {
                    failed.resolve();
                    return Response.json({ error: 'artifact_list_failed' }, { status: 500 });
                }
                await retry.promise;
                return createArtifactListHttpResponse(request.url, [currentArtifact]);
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const input = ArtifactReadBatchHttpInputV1Schema.parse(request.body);
            if (!('projection' in input)) bodyReads.push(input.artifactIds);
            return createArtifactReadBatchHttpResponse(input, id => ({ artifactId: id, ok: true, recipientCensus: null,
                artifact: currentArtifact }));
        } });
        const disconnect = await home.restoreActiveConnection();
        try {
            const { storage, useTranscriptApprovalArtifactsForSession } = await import('@/sync/domains/state/storage');
            const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
            const { INBOX_ARTIFACT_KINDS } = await import('@/sync/domains/artifacts/inboxArtifacts');
            const { sync } = await import('@/sync/sync');
            const presentations = [() => true];
            const resumeFacts = () => {
                const row = storage.getState().artifacts[artifactId];
                return { changesReads, servedGone, cursorGone, listSelections, bodyBatchSizes: bodyReads.map(ids => ids.length),
                    versions: row ? { header: row.headerVersion, body: row.bodyVersion,
                        status: row.header?.approvalStatus, bodyPresent: typeof row.body === 'string' } : null };
            };
            const hook = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presentations),
                { wrapper: InboxSummaryProvider });
            try {
                await failed.promise;
                expect(storage.getState().artifacts[artifactId]).toBeUndefined();
                expect(storage.getState().artifactsLoaded).toBe(false);
                expect(hook.getCurrent()).toHaveLength(0);
                await act(async () => {
                    retry.resolve();
                    cursorGone = true;
                    await sync.resumeSync('socket-reconnect');
                });
                await waitForHomeGovernance(() => expect(hook.getCurrent()).toHaveLength(1));
                expect(hook.getCurrent()[0]?.approval.status).toBe('open');
                expect(storage.getState().artifactsLoaded).toBe(false);
                expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
                expect(storage.getState().artifactInboxLoaded).toBe(true);
                expect(listSelections).toContain(JSON.stringify(INBOX_ARTIFACT_KINDS));
                expect(listSelections).toContain(null); // The visible Session's independent relationship selection.
                expect(bodyReads).toEqual([[artifactId]]);
                currentApproval = ApprovalRequestV2Schema.parse({ ...approval, status: 'executed', updatedAtMs: 2,
                    decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
                currentArtifact = { ...artifact, headerVersion: 2, bodyVersion: 2, seq: 2, updatedAt: 2,
                    ...deriveApprovalArtifactQueryHintsV1(buildApprovalRequestArtifactHeaderV1(currentApproval)),
                    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(currentApproval)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(currentApproval) }) };
                cursorGone = true;
                await act(async () => { await sync.resumeSync('socket-reconnect'); });
                await waitForHomeGovernance(() => expect(hook.getCurrent()[0]?.approval.status, JSON.stringify(resumeFacts())).toBe('executed'));
                expect(bodyReads).toEqual([[artifactId], [artifactId]]);
                expect(listSelections.every(selection => selection === null || selection === JSON.stringify(INBOX_ARTIFACT_KINDS))).toBe(true);
                expect(storage.getState().artifactsLoaded).toBe(false);
            } finally { await hook.unmount(); }
        } finally { retry.resolve(); await disconnect(); await home.dispose(); }
    });

    it.each(['ios', 'web'] as const)('batches an Inbox hydration request after real E2EE Account authority acquisition (%s)', async platform => {
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        const webStorage = platform === 'web' ? installLocalStorageMock() : null;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: platform });
        try {
            const artifactIds = Array.from({ length: 32 }, (_, index) => `11111111-1111-4111-8111-${String(index + 201).padStart(12, '0')}`);
            const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'encrypted-reader', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
            const detailRequests: string[][] = [];
            const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://receipt-encrypted-reader.test',
                accountId: 'encrypted-reader', accountMode: 'e2ee',
                credentials: { token, secret: encodeBase64(new Uint8Array(32).fill(47), 'base64url') } }], route: request => {
                if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
                if (request.path !== '/v1/artifacts/read') return undefined;
                const { artifactIds: selected } = ArtifactReadBatchInputV1Schema.parse(request.body);
                detailRequests.push(selected);
                // A keyholding E2EE reader can receive a plain owner's shared Artifact;
                // the real authority path still derives the reader's Account encryption.
                return Response.json({ items: selected.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                    artifact: { id, ownerAccountId: 'plain-owner', access: 'view', encryptionMode: 'plain',
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                        header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', title: 'Receipt' }),
                        body: encodePlainArtifactStoredContent({ body: `receipt-${id}` }),
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } })) });
            } });
            const disconnect = await home.restoreActiveConnection();
            try {
                const { sync } = await import('@/sync/sync');
                const { storage } = await import('@/sync/domains/state/storage');
                await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
                await sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds);
                expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(id => `receipt-${id}`));
                expect({ requests: detailRequests.length, batchSizes: detailRequests.map(ids => ids.length) })
                    .toEqual({ requests: 1, batchSizes: [artifactIds.length] });
                expect(detailRequests[0]).toEqual(artifactIds);
                await sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds);
                expect(detailRequests).toHaveLength(1);
            } finally { await disconnect(); await home.dispose(); }
        } finally {
            Object.defineProperty(Platform, 'OS', previousPlatform);
            webStorage?.restore();
        }
    });

    it('publishes concurrent transcript body completions together through the real Sync writer', async () => {
        const artifactIds = Array.from({ length: 6 }, (_, index) => `11111111-1111-4111-8111-${String(index + 101).padStart(12, '0')}`);
        const detailRequests: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://receipt-publication.test',
            accountId: 'session-account', currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
            if (request.path !== '/v1/artifacts/read') return undefined;
            const { artifactIds: selected } = ArtifactReadBatchInputV1Schema.parse(request.body);
            detailRequests.push(selected);
            return Response.json({ items: selected.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                artifact: { id, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                    header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', title: 'Settled receipt' }),
                    body: encodePlainArtifactStoredContent({ body: `receipt-${id}` }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        let off: (() => void) | undefined;
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                expect(storage.getState().isDataReady).toBe(true);
            });
            let publications = 0;
            off = storage.subscribe((next, before) => {
                if (artifactIds.some(id => next.artifacts[id] !== before.artifacts[id])) publications++;
            });
            await Promise.all(artifactIds.map(id => sync.hydrateSessionApprovalArtifacts(home.serverId, [id])));
            expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(id => `receipt-${id}`));
            expect(publications).toBe(1);
            expect(detailRequests).toEqual([artifactIds]);
        } finally { off?.(); await disconnect(); await home.dispose(); }
    });

    it('separates a prepared peer read from an explicit producer mutation acknowledgement without read-side kind backfill', async () => {
        const artifactId = '11111111-1111-4111-8111-111111111114';
        const held = createDeferred<void>();
        const release = createDeferred<void>();
        let kind: 'prompt' | null = null;
        let reads = 0;
        let listReads = 0;
        let writes = 0;
        const row = () => ({ id: artifactId, kind, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
            header: encodePlainArtifactStoredContent({ title: 'Prompt', kind: 'prompt_doc.v2' }),
            body: encodePlainArtifactStoredContent({ body: 'Current' }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://inventory-backfill-peer.test',
            accountId: 'session-account', currentAccount: true }], route: async request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') { listReads++; return createArtifactListHttpResponse(request.url, []); }
            if (request.path === `/v1/artifacts/${artifactId}` && request.method === 'POST') {
                expect(request.body).toEqual({ kind: 'prompt', expectedHeaderVersion: 1 });
                kind = 'prompt';
                writes++;
                return Response.json({ success: true });
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const ids = ArtifactReadBatchInputV1Schema.parse(request.body).artifactIds;
            const observed = row();
            reads++;
            if (reads === 1) { held.resolve(); await release.promise; }
            return Response.json({ items: ids.map(id => ({ artifactId: id, ok: true, artifact: observed, recipientCensus: null })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        let old: ReturnType<typeof fetchArtifactReadBatch> | undefined;
        let current: ReturnType<typeof fetchArtifactReadBatch> | undefined;
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                expect(storage.getState().isDataReady).toBe(true);
            });
            const credentials = sync.getCredentials();
            if (!credentials) throw new Error('Expected restored Account credentials');
            const active = getActiveServerSnapshot();
            const readTransport = apiSocket.createReadTransportForActiveServer({ ...active, endpoint: active.serverUrl });
            if (!readTransport) throw new Error('Expected actual prepared Account transport');
            old = fetchArtifactReadBatch(credentials, [artifactId], { readTransport });
            await held.promise;
            await updateArtifact(credentials, artifactId, { kind: 'prompt', expectedHeaderVersion: 1 }, { readTransport });
            const readsBeforeAcknowledgedDemand = reads;
            current = fetchArtifactReadBatch(credentials, [artifactId], { readTransport });
            await vi.waitFor(() => expect(reads).toBe(readsBeforeAcknowledgedDemand + 1));
            await expect(current).resolves.toMatchObject([{ ok: true, artifact: { kind: 'prompt' } }]);
            expect(writes).toBe(1);
            expect(listReads).toBe(0);
        } finally {
            release.resolve();
            await Promise.allSettled([old, current]);
            await disconnect(); await home.dispose();
        }
    });

    it.each(['recover', 'retire', 'isolate', 'refuse'] as const)('owns overlapping demanded receipt retries without another navigation (%s)', async scenario => {
        installDisconnectedServerSocketBoundary();
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent', actionId: 'session.capabilities.set',
            actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change capabilities', decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote', sessionId: 's1', actionId: 'session.capabilities.set', requestId: 'request' } });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const artifactIds = [artifactId, '11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111113'];
        let reads = 0;
        const readsById = new Map<string, number>();
        let failedIds: readonly string[] = [];
        let allowRecovery = false;
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: `https://receipt-retry-${scenario}.test`,
            accountId: 'session-account', currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
            if (request.path !== '/v1/artifacts/read') return undefined;
            reads += 1;
            const requestedIds = ArtifactReadBatchInputV1Schema.parse(request.body).artifactIds;
            for (const id of requestedIds) readsById.set(id, (readsById.get(id) ?? 0) + 1);
            if (reads === 1 && (scenario === 'recover' || scenario === 'retire')) {
                failedIds = requestedIds;
                return Response.json({ error: 'artifact_content_unavailable' }, { status: 503 });
            }
            return Response.json({ items: requestedIds.map(id => id === artifactId
                && (scenario === 'refuse' || scenario === 'isolate' && !allowRecovery)
                ? { artifactId: id, ok: false, error: 'artifact_content_unavailable', status: 500, retryable: scenario !== 'refuse' }
                : { artifactId: id, ok: true, recipientCensus: null, artifact: {
                id, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
            } }) });
        } });
        const disconnect = await home.restoreActiveConnection();
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            for (const id of artifactIds) storage.getState().deleteArtifact(id);
            const pending = sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds.slice(0, 2));
            const overlapping = sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds.slice(1));
            const settled = Promise.all([pending, overlapping]).then(() => undefined, (error: unknown) => error);
            if (scenario === 'retire') {
                await vi.waitFor(() => expect(failedIds.length).toBeGreaterThan(0));
                const readsAtRetirement = reads;
                const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
                retireActiveServerAccountScopeLifetime();
                await expect(settled).resolves.toBeUndefined();
                expect(reads).toBe(readsAtRetirement);
                expect(failedIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(failedIds.map(() => undefined));
            } else if (scenario === 'refuse') {
                await expect(pending).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
                await expect(overlapping).resolves.toBeUndefined();
                expect(artifactIds.slice(1).map(id => storage.getState().artifacts[id]?.body)).toEqual([JSON.stringify(approval), JSON.stringify(approval)]);
                expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
                expect(artifactIds.map(id => readsById.get(id))).toEqual([1, 1, 1]);
            } else {
                if (scenario === 'isolate') {
                    await overlapping;
                    expect(artifactIds.slice(1).map(id => storage.getState().artifacts[id]?.body)).toEqual([JSON.stringify(approval), JSON.stringify(approval)]);
                    expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
                    expect(artifactIds.slice(1).map(id => readsById.get(id))).toEqual([1, 1]);
                    allowRecovery = true;
                }
                await Promise.all([pending, overlapping]);
                expect(artifactIds.map(id => readsById.get(id))).toEqual(artifactIds.map(id =>
                    scenario === 'isolate' ? id === artifactId ? 2 : 1 : failedIds.includes(id) ? 2 : 1));
                expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(() => JSON.stringify(approval)));
            }
        } finally { await disconnect(); await home.dispose(); }
    });
    it.each(['already-settled', 'settled-during-read'] as const)('hydrates the exact-Home transcript without reopening its receipt (%s)', async scenario => {
        installDisconnectedServerSocketBoundary();
        const portableHome = 'srv_transcript_approval';
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.capabilities.set', actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change session capabilities', decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: true, result: {} },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-cli-profile', serverIdentityId: portableHome, sessionId: 's1',
                actionId: 'session.capabilities.set', requestId: 'request-1' } });
        const earlier = ApprovalRequestV2Schema.parse({ ...approval, status: 'open', updatedAtMs: 1,
            decision: undefined, execution: undefined });
        const responseApproval = scenario === 'settled-during-read' ? earlier : approval;
        const header = buildApprovalRequestArtifactHeaderV1(responseApproval);
        const settledHeader = buildApprovalRequestArtifactHeaderV1(approval);
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const inventory = [
            { id: artifactId, header: settledHeader },
            { id: 'other', header: { ...settledHeader, serverIdentityId: 'srv_other_home' } },
        ].map((row): Artifact => ({ ...row, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            kind: 'other', kindHint: 'approval_request.v1', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
            header: encodePlainArtifactStoredContent(row.header),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 }));
        const reads: unknown[] = [];
        const responseReady = createDeferred<void>();
        const inventoryRequested = createDeferred<void>(), releaseInventory = createDeferred<void>();
        const listSelections: Array<string | null> = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://transcript-approval.test',
            accountId: 'session-account', serverIdentityId: portableHome, currentAccount: true }], route: async request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                listSelections.push(request.url.searchParams.get('kinds'));
                inventoryRequested.resolve();
                await releaseInventory.promise;
                return createArtifactListHttpResponse(request.url, inventory);
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            reads.push(request.body);
            await responseReady.promise;
            const input = ArtifactReadBatchHttpInputV1Schema.parse(request.body);
            return createArtifactReadBatchHttpResponse(input, id => {
                const stored = inventory.find(row => row.id === id);
                if (!stored) return { artifactId: id, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                const bodyApproval = id === artifactId ? responseApproval : ApprovalRequestV2Schema.parse({
                    ...responseApproval,
                    executionOriginV1: { ...responseApproval.executionOriginV1, serverIdentityId: 'srv_other_home' },
                });
                return { artifactId: id, ok: true, recipientCensus: null, artifact: {
                    ...stored,
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(bodyApproval) }),
                } };
            });
        } });
        const disconnect = await home.restoreActiveConnection();
        const { storage, useTranscriptApprovalArtifactsForSession, useOpenApprovalSessionReferences } = await import('@/sync/domains/state/storage');
        const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
        const { INBOX_ARTIFACT_KINDS } = await import('@/sync/domains/artifacts/inboxArtifacts');
        const shell = await renderHook(() => null, { wrapper: InboxSummaryProvider });
        const presents = [() => true];
        try {
            await inventoryRequested.promise;
            expect(storage.getState().artifactsLoaded).toBe(false);
            expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
            // A known header observation can demand its exact receipt before the shell's census settles.
            inventory[0]!.header = encodePlainArtifactStoredContent(header);
            inventory[1]!.header = encodePlainArtifactStoredContent({ ...header, serverIdentityId: 'srv_other_home' });
            const { decryptArtifactListItems } = await import('@/sync/engine/artifacts/syncArtifacts');
            const observed = await decryptArtifactListItems({ artifacts: inventory, encryption: null, artifactDataKeys: new Map() });
            await act(async () => { storage.getState().applyArtifacts(observed.filter((row): row is NonNullable<typeof row> => row !== null)); });
            const hook = await renderHook(() => ({
                approvals: useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents),
                open: useOpenApprovalSessionReferences(),
            }));
            const duplicate = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents));
            await act(async () => { await vi.waitFor(() => expect(reads).toHaveLength(1)); });
            const { sync } = await import('@/sync/sync');
            const inFlight = sync.hydrateSessionApprovalArtifacts(home.serverId, [artifactId]);
            if (scenario === 'settled-during-read') {
                const { handleUpdateArtifactSocketUpdate } = await import('@/sync/engine/artifacts/syncArtifacts');
                await act(async () => { await handleUpdateArtifactSocketUpdate({ artifactId, createdAt: 3,
                    header: { version: 2, value: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)) },
                    body: { version: 2, value: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) },
                    artifactDataKeys: new Map(), getExistingArtifact: id => storage.getState().artifacts[id],
                    updateArtifact: row => storage.getState().updateArtifact(row),
                    invalidateArtifactsSync: () => { throw new Error('Readable settlement must not need a refresh'); },
                    log: { log: () => {} },
                }); });
            }
            await act(async () => { responseReady.resolve(); await inFlight; });
            await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().approvals).toHaveLength(1)); });
            expect(hook.getCurrent().approvals[0]?.approval.status).toBe('executed');
            expect(hook.getCurrent().open).toEqual(scenario === 'settled-during-read'
                ? [{ kind: 'exact', address: { serverId: 'srv_other_home', sessionId: 's1' } }] : []);
            expect(duplicate.getCurrent()[0]?.approval.status).toBe('executed');
            expect(reads).toEqual([{ artifactIds: scenario === 'settled-during-read' ? [artifactId, 'other'] : [artifactId] }]);
            expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
            expect(listSelections[0]).toBe(JSON.stringify(INBOX_ARTIFACT_KINDS));
            expect(listSelections.every(selection => selection === null || selection === JSON.stringify(INBOX_ARTIFACT_KINDS))).toBe(true);
            await duplicate.unmount();
            await hook.unmount();
            const remount = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents));
            expect(remount.getCurrent()).toHaveLength(1);
            expect(reads).toHaveLength(1);
            await remount.unmount();
        } finally { responseReady.resolve(); releaseInventory.resolve(); await shell.unmount(); await disconnect(); await home.dispose(); }
    });
});
