import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { seedForkVisualCopies, seedForkVisualsBestEffort } from './seedForkVisuals';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64 } from '@/api/encryption';
import { openSessionStoredContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, destination: 'transcript', title: 'Graph', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Child independent content' } } },
} as const;
const credentials = { token: 'token', encryption: null };

function rawSession(id: string) {
    return { id, seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, dataEncryptionKey: null, agentState: null, agentStateVersion: 0,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        responsibleAccountId: null, responsibleAccount: null };
}
function toolRows(itemId: string, startSeq: number, destination: 'transcript' | 'board' = 'transcript', sessionId = 'parent', serverId = configuration.activeServerId) {
    const input = { sessionId, itemId, expectedItemRevision: destination === 'board' ? revision : null,
        destination, item: { ...item, destination } };
    const result = { v: 1, serverId, sessionId, itemDestination: destination, destination: null,
        result: { operation: 'upsert_item', itemId, itemRevision: revision, outcome: destination === 'board' ? 'updated' : 'created' } };
    return [
        { id: `${itemId}-call`, seq: startSeq, createdAt: startSeq, content: { t: 'plain', v: { role: 'agent', content: {
            type: 'acp', agentId: 'codex', data: { type: 'tool-call', callId: itemId, name: 'session_board_item_upsert', id: `${itemId}-call`, input },
        } } } },
        { id: `${itemId}-result`, seq: startSeq + 1, createdAt: startSeq + 1, content: { t: 'plain', v: { role: 'agent', content: {
            type: 'acp', agentId: 'codex', data: { type: 'tool-result', callId: itemId, id: `${itemId}-result`, output: result },
        } } } },
    ];
}

describe('fork visual seed', () => {
    let app = fastify();
    let restore = () => {};
    beforeEach(() => {
        app = fastify();
        restore = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
        // The Home feature endpoint is an external environment boundary, not the mutation owner.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
            features: { sessions: { enabled: true, board: { enabled: false } }, sharing: { session: { enabled: true } } }, capabilities: {},
        })));
        const detailReads = new Set<string>();
        app.get('/v2/sessions/:id', async request => {
            const id = (request.params as { id: string }).id;
            // Board Actions may read the same child later with their own label.
            if (id === 'child' && !detailReads.has(id)) {
                expect(request.headers['x-happier-request-purpose']).toBe('session-detail:session-replay');
            }
            detailReads.add(id);
            return { session: rawSession(id) };
        });
    });
    afterEach(async () => { restore(); vi.restoreAllMocks(); await app.close(); });

    it.each([false, true])('seeds a real portable Home acknowledgement on a differently named CLI profile and refuses foreign or unknown Homes (inherited: %s)', async inherited => {
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const serverUrl = resolveServerHttpBaseUrl();
        try {
            await withTempDir('happier-cli-fork-home-', async homeDir => {
                envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined });
                reloadConfiguration();
                const profile = await addServerProfile({ name: 'fork-daemon-profile', serverUrl, webappUrl: serverUrl });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: 'srv_fork_home', canonicalServerUrl: serverUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
                envScope.patch({ HAPPIER_ACTIVE_SERVER_ID: profile.id });
                reloadConfiguration();
                expect(configuration.activeServerId).not.toBe('srv_fork_home');
                const originSessionId = inherited ? 'grandparent' : 'parent';
                const legacyRows = toolRows('portable', 1, 'transcript', originSessionId, profile.id).map(row => ({
                    ...row, id: `legacy-${row.id}`, content: { ...row.content, v: { ...row.content.v,
                        content: { ...row.content.v.content, data: { ...row.content.v.content.data, callId: 'legacy-portable' } },
                    } },
                }));
                const portableRows = toolRows('portable', 3, 'transcript', originSessionId, 'srv_fork_home');
                app.get('/v1/sessions/parent/messages', async () => ({ messages: [
                    ...[...legacyRows, ...portableRows].map(row => inherited ? { ...row, content: { t: 'plain', v: { ...row.content.v,
                        meta: { forkVisualOriginV1: { v: 1, serverId: profile.id, sessionId: originSessionId,
                            sourceMessageId: row.id, sourceSeq: row.seq } },
                    } } } : row),
                    ...([['foreign', 5, 'srv_foreign_home'], ['unknown', 7, 'unknown-daemon-profile']] as const)
                        .flatMap(([itemId, seq, serverId]) => toolRows(itemId, seq, 'transcript', 'parent', serverId).map(row => ({
                            ...row, content: { t: 'plain', v: { ...row.content.v, meta: { forkVisualOriginV1: {
                                v: 1, serverId, sessionId: 'parent', sourceMessageId: row.id, sourceSeq: row.seq,
                            } } } },
                        }))),
                ], hasMore: false }));
                if (inherited) app.get('/v2/sessions/grandparent', async (_request, reply) => reply.code(403).send({ error: 'forbidden' }));
                const childRecords = new Map<string, unknown>();
                const sourceReads: string[] = [];
                let parentAvailable = true;
                app.get('/v2/sessions/:id/system-records/record', async request => {
                    const { id } = request.params as { id: string };
                    const { localId } = request.query as { localId: string };
                    if (id === 'child') return { record: childRecords.get(localId) ?? null };
                    sourceReads.push(localId);
                    if (!parentAvailable) return { record: null };
                    return { record: { id: 'parent-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                        content: { t: 'plain', v: item }, revision,
                        createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
                });
                app.put('/v2/sessions/child/board', async request => {
                    const body = request.body as { itemId: string; itemContent: unknown };
                    childRecords.set(body.itemId, { id: 'child-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: body.itemId },
                        content: body.itemContent, revision,
                        createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
                    return { operation: 'upsert_item', itemId: body.itemId, itemRevision: revision, outcome: 'created' };
                });
                const importedRows: unknown[] = [];
                app.post('/v3/sessions/child/transcript/import', async request => {
                    const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
                    return { imported: body.items.length, cursor: body.items.length };
                });
                const params = { credentials, accountEncryptionMode: 'plain' as const, sourceSessionId: 'parent',
                    cutoffSeqInclusive: 8, childSessionId: 'child', sourceMetadata: { path: '', host: '', ...(inherited ? { forkV1: {
                        v: 1, parentSessionId: originSessionId, parentCutoffSeqInclusive: 4, createdAtMs: 1, strategy: 'native',
                        visualCopies: [{ originServerId: profile.id, originSessionId, originItemId: 'portable', status: 'copied', itemId: 'parent-independent' }],
                    } } : {}) } };
                const copies = await seedForkVisualCopies(params);
                expect(copies).toEqual([{ originServerId: 'srv_fork_home', originSessionId, originItemId: 'portable',
                    status: 'copied', itemId: expect.any(String) }]);
                expect(sourceReads).toEqual([inherited ? 'parent-independent' : 'portable']);
                expect(importedRows).toHaveLength(4);
                expect(importedRows[0]).toMatchObject({ content: { t: 'plain', v: { meta: { forkVisualOriginV1: {
                    serverId: 'srv_fork_home', sessionId: originSessionId, sourceMessageId: 'legacy-portable-call',
                } } } }, surfaceItemReference: { v: 1, references: [{
                    sourceAddress: { serverId: 'srv_fork_home', sessionId: originSessionId }, sourceItemId: 'portable', sourceItemRevision: revision,
                }] } });
                expect(importedRows).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
                    content: { t: 'plain', v: expect.objectContaining({ meta: { forkVisualOriginV1: expect.objectContaining({
                        serverId: 'srv_fork_home', sessionId: originSessionId,
                    }) } }) },
                    surfaceItemReference: { v: 1, references: [expect.objectContaining({
                        sourceAddress: { serverId: 'srv_fork_home', sessionId: originSessionId }, sourceItemId: 'portable',
                    })] },
                })));
                parentAvailable = false;
                expect(await seedForkVisualCopies(params)).toEqual(copies);
                expect(sourceReads).toEqual([inherited ? 'parent-independent' : 'portable']);
            });
        } finally {
            envScope.restore();
            reloadConfiguration();
        }
    });

    it.each(['allowed', 'approved Ask'] as const)('copies only completed admitted %s references through the real transcript mutation and keeps independent successes on failure', async approval => {
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
        const childRecords = new Map<string, unknown>();
        let parentContentAvailable = true;
        const visualRows = (itemId: string, startSeq: number, settled = true) => toolRows(itemId, startSeq).map((row, index) =>
            approval === 'allowed' || index === 0 ? row : { ...row,
                content: { ...row.content, v: { ...row.content.v, content: { ...row.content.v.content,
                    data: { ...row.content.v.content.data, output: { kind: 'approval_request_created',
                        artifactId: `approval-${itemId}`, actionId: 'session.board.item.upsert' } },
                } } },
                ...(settled ? { surfaceItemReference: { v: 1, references: [{ v: 1, itemId, itemRevision: revision,
                    sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' },
                    sourceItemId: itemId, sourceItemRevision: revision,
                    approvalRequestArtifactId: `approval-${itemId}` }] } } : {}),
            });
        let messages = [...visualRows('good', 1), ...visualRows('missing', 3),
            ...toolRows('board-only', 5, 'board'), ...visualRows('late', 7)];
        app.get('/v1/sessions/parent/messages', async () => ({ messages: [
            ...messages,
        ], hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId, kind } = request.query as { localId: string; kind: string };
            expect(kind).toBe('item.v1');
            if (id === 'child') return { record: childRecords.get(localId) ?? null };
            if (!parentContentAvailable || localId === 'missing') return { record: null };
            return { record: { id: `record-${localId}`, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: localId === 'board-only' ? { ...item, destination: 'board' } : item },
                revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        const writes: unknown[] = [];
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] };
            importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.put('/v2/sessions/child/board', async request => {
            writes.push(request.body);
            const body = request.body as { itemId: string; itemContent: unknown };
            childRecords.set(body.itemId, { id: `child-${body.itemId}`, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: body.itemId },
                content: body.itemContent, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
            return { operation: 'upsert_item', itemId: body.itemId, itemRevision: revision, outcome: 'created' };
        });
        const copies = await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 7, childSessionId: 'child' });
        expect(copies).toEqual([
            { originServerId: configuration.activeServerId, originSessionId: 'parent', originItemId: 'good', status: 'copied', itemId: expect.any(String) },
            { originServerId: configuration.activeServerId, originSessionId: 'parent', originItemId: 'missing', status: 'not_copied' },
            { originServerId: configuration.activeServerId, originSessionId: 'parent', originItemId: 'board-only', status: 'copied', itemId: expect.any(String) },
        ]);
        expect(writes).toEqual(Array.from({ length: 2 }, () => ({ operation: 'upsert_item', itemId: expect.any(String), expectedItemRevision: null,
            destination: 'transcript', itemContent: { t: 'plain', v: item } })));
        // Child reads need no parent record or grant once the copy is committed.
        expect(copies[0]?.status).toBe('copied');
        expect(importedRows).toHaveLength(6);
        expect(importedRows[0]).toMatchObject({ content: { t: 'plain', v: { meta: { forkVisualOriginV1: {
            v: 1, sessionId: 'parent', sourceMessageId: 'good-call', sourceSeq: 1,
        } } } }, surfaceItemReference: { v: 1, references: [{ v: 1, itemId: copies[0]?.status === 'copied' ? copies[0].itemId : null,
            itemRevision: revision, sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' },
            sourceItemId: 'good', sourceItemRevision: revision }] } });
        expect(importedRows[2]).not.toHaveProperty('surfaceItemReference');
        parentContentAvailable = false;
        const recovered = await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 7, childSessionId: 'child' });
        expect(recovered).toEqual(copies);
        expect(writes).toHaveLength(2);
        if (approval === 'approved Ask') {
            // Pending and denied receipts never acquire a settled Session publication.
            messages = visualRows('not-approved', 1, false);
            expect(await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 2, childSessionId: 'child' })).toEqual([]);
            expect(writes).toHaveLength(2);
            messages = visualRows('wrong-receipt', 1).map(row => ({ ...row,
                surfaceItemReference: { v: 1, references: [{ v: 1, itemId: 'wrong-receipt', itemRevision: revision,
                    sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' },
                    sourceItemId: 'wrong-receipt', sourceItemRevision: revision, approvalRequestArtifactId: 'other-approval' }] },
            }));
            expect(await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 2, childSessionId: 'child' })).toEqual([]);
            expect(writes).toHaveLength(2);
        }
    });
    it('seeds the admitted ancestor visual when the source is an older fork without child-owned imports', async () => {
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: toolRows('source', 1), hasMore: false }));
        app.get('/v1/sessions/grandparent/messages', async () => ({ messages: [
            ...toolRows('ancestor', 1, 'transcript', 'grandparent'), ...toolRows('excluded', 3, 'transcript', 'grandparent'),
        ], hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            if (id === 'child') return { record: null };
            return { record: { id: 'ancestor-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: item }, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.put('/v2/sessions/child/board', async request => {
            const body = request.body as { itemId: string };
            return { operation: 'upsert_item', itemId: body.itemId, itemRevision: revision, outcome: 'created' };
        });
        const copies = await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 2, childSessionId: 'child',
            sourceMetadata: { path: '', host: '', forkV1: { v: 1, parentSessionId: 'grandparent', parentCutoffSeqInclusive: 2,
                createdAtMs: 1, strategy: 'replay' } } });
        expect(copies).toEqual([
            { originServerId: configuration.activeServerId, originSessionId: 'parent', originItemId: 'source', status: 'copied', itemId: expect.any(String) },
            { originServerId: configuration.activeServerId, originSessionId: 'grandparent', originItemId: 'ancestor', status: 'copied', itemId: expect.any(String) },
        ]);
        expect(importedRows).toHaveLength(4);
        expect(importedRows[0]).toMatchObject({ content: { t: 'plain', v: { meta: { forkVisualOriginV1: { sessionId: 'grandparent', sourceSeq: 1 } } } } });
        expect(importedRows[2]).toMatchObject({ content: { t: 'plain', v: { meta: { forkVisualOriginV1: { sessionId: 'parent', sourceSeq: 1 } } } } });
    });
    it('retains independent source copies when an older ancestor grant is unavailable', async () => {
        app.get('/v2/sessions/grandparent', async (_request, reply) => reply.code(403).send({ error: 'forbidden' }));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: toolRows('source-visual', 1), hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            return { record: id === 'child' ? null : { id: 'source-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: item }, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.put('/v2/sessions/child/board', async request => ({ operation: 'upsert_item',
            itemId: (request.body as { itemId: string }).itemId, itemRevision: revision, outcome: 'created' }));
        const copies = await seedForkVisualCopies({ credentials, accountEncryptionMode: 'plain', sourceSessionId: 'parent',
            cutoffSeqInclusive: 2, childSessionId: 'child', sourceMetadata: { path: '', host: '', forkV1: {
                v: 1, parentSessionId: 'grandparent', parentCutoffSeqInclusive: 2, createdAtMs: 1, strategy: 'replay',
            } } });
        expect(copies).toEqual([{ originServerId: configuration.activeServerId, originSessionId: 'parent',
            originItemId: 'source-visual', status: 'copied', itemId: expect.any(String) }]);
        expect(importedRows).toHaveLength(2);
    });
    it('attempts an identical unavailable source once per invocation and retries on a fresh invocation', async () => {
        const repeats = [1, 3, 5].flatMap(start => toolRows('missing', start).map(row => ({
            ...row, id: `${row.id}-${start}`, content: { ...row.content, v: { ...row.content.v,
                content: { ...row.content.v.content, data: { ...row.content.v.content.data, callId: `missing-${start}` } },
            } },
        })));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: repeats, hasMore: false }));
        const reads: string[] = [];
        let available = false;
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            reads.push(id);
            return { record: id === 'parent' && available ? { id: 'source-record',
                address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId }, content: { t: 'plain', v: item },
                revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } : null };
        });
        const imported: unknown[] = [];
        app.post('/v2/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; imported.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; imported.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.put('/v2/sessions/child/board', async request => ({ operation: 'upsert_item',
            itemId: (request.body as { itemId: string }).itemId, itemRevision: revision, outcome: 'created' }));
        const params = { credentials, accountEncryptionMode: 'plain' as const, sourceSessionId: 'parent', cutoffSeqInclusive: 6, childSessionId: 'child' };
        expect(await seedForkVisualCopies(params)).toMatchObject([{ status: 'not_copied' }]);
        expect(imported).toHaveLength(6);
        expect(reads).toEqual(['child', 'parent']);
        available = true;
        expect(await seedForkVisualCopies(params)).toMatchObject([{ status: 'copied' }]);
        expect(reads.filter(id => id === 'parent')).toHaveLength(2);
        expect(imported).toHaveLength(12);
    });
    it('copies an authorized available ancestor when the previous fork settled that reference as not copied', async () => {
        const ancestorRows = toolRows('ancestor', 1, 'transcript', 'grandparent');
        const inheritedRows = ancestorRows.map((row, index) => ({ ...row, id: `parent-import-${index}`, seq: 20 + index,
            content: { t: 'plain', v: { ...row.content.v, meta: { forkVisualOriginV1: { v: 1,
                serverId: configuration.activeServerId, sessionId: 'grandparent', sourceMessageId: row.id, sourceSeq: row.seq } } } } }));
        app.get('/v2/sessions/parent', async () => ({ session: { ...rawSession('parent'), seq: 21 } }));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: inheritedRows, hasMore: false }));
        app.get('/v1/sessions/grandparent/messages', async () => ({ messages: ancestorRows, hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            return { record: id !== 'grandparent' ? null : { id: 'ancestor-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: item }, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.post('/v2/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        app.put('/v2/sessions/child/board', async request => ({ operation: 'upsert_item',
            itemId: (request.body as { itemId: string }).itemId, itemRevision: revision, outcome: 'created' }));
        const copies = await seedForkVisualCopies({ credentials, accountEncryptionMode: 'plain', sourceSessionId: 'parent',
            cutoffSeqInclusive: 0, childSessionId: 'child', sourceMetadata: { path: '', host: '', forkV1: {
                v: 1, parentSessionId: 'grandparent', parentCutoffSeqInclusive: 2, createdAtMs: 1, strategy: 'replay', visualCopies: [{
                    originServerId: configuration.activeServerId, originSessionId: 'grandparent', originItemId: 'ancestor', status: 'not_copied',
                }],
            } } });
        expect(copies).toEqual([{ originServerId: configuration.activeServerId, originSessionId: 'grandparent', originItemId: 'ancestor',
            status: 'copied', itemId: expect.any(String) }]);
        expect(importedRows).toHaveLength(2);
        expect(importedRows).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ surfaceItemReference: { v: 1, references: [{
            v: 1, itemId: copies[0]?.status === 'copied' ? copies[0].itemId : null, itemRevision: revision,
            sourceAddress: { serverId: configuration.activeServerId, sessionId: 'grandparent' },
            sourceItemId: 'ancestor', sourceItemRevision: revision,
        }] } })));
    });
    it('seals independent child records and native transcript rows with the child Session key, not the parent key', async () => {
        const machineKey = new Uint8Array(32).fill(9);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const encryptedCredentials = { token: 'token', encryption: { type: 'dataKey' as const, machineKey, publicKey } };
        const sourceCrypto = { mode: 'e2ee' as const, ctx: { encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' as const } };
        const childCrypto = { mode: 'e2ee' as const, ctx: { encryptionKey: new Uint8Array(32).fill(23), encryptionVariant: 'dataKey' as const } };
        for (const [sessionId, crypto] of [['parent', sourceCrypto], ['child', childCrypto]] as const) {
            app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { ...rawSession(sessionId), encryptionMode: 'e2ee',
                dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: crypto.ctx.encryptionKey,
                    recipientPublicKey: publicKey, randomBytes: length => new Uint8Array(length).fill(11) })) } }));
        }
        app.get('/v1/sessions/parent/messages', async () => ({ messages: toolRows('encrypted-visual', 1).map(row => ({
            ...row, content: sealSessionStoredContent({ ...sourceCrypto, payload: row.content.v }),
        })), hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            return { record: id === 'child' ? null : { id: 'source-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: sealSessionStoredContent({ ...sourceCrypto, payload: item }), revision,
                createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        const childContent: unknown[] = [];
        const importedContent: unknown[] = [];
        app.put('/v2/sessions/child/board', async request => {
            const body = request.body as { itemId: string; itemContent: unknown }; childContent.push(body.itemContent);
            return { operation: 'upsert_item', itemId: body.itemId, itemRevision: revision, outcome: 'created' };
        });
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: { content: unknown }[] }; importedContent.push(...body.items.map(row => row.content));
            return { imported: body.items.length, cursor: body.items.length };
        });
        const copies = await seedForkVisualCopies({ credentials: encryptedCredentials, accountEncryptionMode: 'e2ee',
            sourceSessionId: 'parent', cutoffSeqInclusive: 2, childSessionId: 'child', sourceMetadata: { path: '', host: '' } });
        expect(copies).toMatchObject([{ status: 'copied' }]);
        expect(childContent).toHaveLength(1);
        const sealedItem = SessionStoredMessageContentSchema.parse(childContent[0]);
        expect(sealedItem.t).toBe('encrypted');
        expect(openSessionStoredContent({ ...childCrypto, content: sealedItem })).toEqual(item);
        expect(() => openSessionStoredContent({ ...sourceCrypto, content: sealedItem })).toThrow();
        expect(importedContent).toHaveLength(2);
        for (const content of importedContent) {
            const sealed = SessionStoredMessageContentSchema.parse(content);
            expect(sealed.t).toBe('encrypted');
            expect(openSessionStoredContent({ ...childCrypto, content: sealed })).toMatchObject({ role: 'agent', meta: { forkVisualOriginV1: { sessionId: 'parent' } } });
            expect(() => openSessionStoredContent({ ...sourceCrypto, content: sealed })).toThrow();
        }
    });
    it('preserves exact child associations when inherited sources reuse one native tool id', async () => {
        const origins = [['first-parent', 'first-item', 'source-first'], ['second-parent', 'second-item', 'source-second']] as const;
        const rows = origins.flatMap(([sessionId, itemId], index) => toolRows(itemId, 1, 'transcript', sessionId).map(row => ({
            ...row, seq: 20 + index * 2 + row.seq,
            content: { t: 'plain', v: { ...row.content.v,
                content: { ...row.content.v.content, data: { ...row.content.v.content.data, callId: 'shared-native-id' } },
                meta: { forkVisualOriginV1: { v: 1, serverId: configuration.activeServerId, sessionId, sourceMessageId: row.id, sourceSeq: row.seq, retiredField: true } },
            } },
        })));
        app.get('/v2/sessions/parent', async () => ({ session: { ...rawSession('parent'), seq: 24 } }));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: rows, hasMore: false }));
        app.get('/v1/sessions/first-parent/messages', async () => ({ messages: [], hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            return { record: id === 'child' ? null : { id: 'source-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: item }, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        app.put('/v2/sessions/child/board', async request => ({ operation: 'upsert_item',
            itemId: (request.body as { itemId: string }).itemId, itemRevision: revision, outcome: 'created' }));
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        const copies = await seedForkVisualCopies({ credentials, accountEncryptionMode: 'plain', sourceSessionId: 'parent', cutoffSeqInclusive: 0,
            childSessionId: 'child', sourceMetadata: { path: '', host: '', forkV1: { v: 1, parentSessionId: 'first-parent', parentCutoffSeqInclusive: 0,
                createdAtMs: 1, strategy: 'replay', visualCopies: origins.map(([sessionId, itemId, sourceCopy]) => ({
                    originServerId: configuration.activeServerId, originSessionId: sessionId, originItemId: itemId, status: 'copied', itemId: sourceCopy, retiredField: true,
                })) } } });
        expect(copies).toHaveLength(2);
        expect(importedRows).toHaveLength(4);
        for (const [sessionId] of origins) {
            const copy = copies.find(candidate => candidate.originSessionId === sessionId);
            if (copy?.status !== 'copied') throw new Error('Expected independently copied source');
            expect(importedRows.filter(row => typeof row === 'object' && row !== null)).toEqual(expect.arrayContaining([
                expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ meta: {
                    forkVisualOriginV1: expect.objectContaining({ sessionId }),
                } }) }, surfaceItemReference: { v: 1, references: [{ v: 1, itemId: copy.itemId, itemRevision: revision,
                    sourceAddress: { serverId: configuration.activeServerId, sessionId }, sourceItemId: copy.originItemId, sourceItemRevision: revision }] } }),
            ]));
        }
    });
    it.each([{ secondUnavailable: false, approved: false }, { secondUnavailable: true, approved: false },
        { secondUnavailable: false, approved: true }])('keeps native multi-result bodies and receipt correspondence (unavailable=$secondUnavailable, Ask=$approved)', async ({ secondUnavailable, approved }) => {
        const callIds = ['first', 'second'];
        const calls = callIds.map(callId => ({ type: 'tool_use', id: callId, name: 'session_board_item_upsert',
            input: { sessionId: 'parent', itemId: approved ? 'shared' : callId, expectedItemRevision: null, destination: 'transcript', item } }));
        const results = callIds.map(itemId => ({ type: 'tool_result', tool_use_id: itemId, content: JSON.stringify(approved
            ? { kind: 'approval_request_created', artifactId: `approval-${itemId}`, actionId: 'session.board.item.upsert' } : {
            v: 1, serverId: configuration.activeServerId, sessionId: 'parent', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId, itemRevision: revision, outcome: 'created' },
        }) }));
        const rows = [
            { id: 'native-call', seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: {
                type: 'output', data: { type: 'assistant', uuid: 'native-call', message: { role: 'assistant', content: calls } },
            } } } },
            { id: 'native-result', seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: {
                type: 'output', data: { type: 'user', uuid: 'native-result', message: { role: 'user', content: results } },
            } } } },
        ];
        const settledApprovalReferences = callIds.map(callId => ({ approvalRequestArtifactId: `approval-${callId}`,
            sourceItemId: 'shared', sourceItemRevision: revision }));
        app.get('/v1/sessions/parent/messages', async () => ({ messages: rows.map((row, index) => approved && index === 1
            ? { ...row, surfaceItemReference: { v: 1, references: settledApprovalReferences.map(reference => ({ v: 1,
                itemId: 'shared', itemRevision: revision, sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' }, ...reference })) } }
            : row), hasMore: false }));
        app.get('/v2/sessions/:id/system-records/record', async request => {
            const { id } = request.params as { id: string };
            const { localId } = request.query as { localId: string };
            return { record: id === 'child' || (secondUnavailable && localId === 'second') ? null : { id: 'source-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
                content: { t: 'plain', v: item }, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        });
        app.put('/v2/sessions/child/board', async request => ({ operation: 'upsert_item',
            itemId: (request.body as { itemId: string }).itemId, itemRevision: revision, outcome: 'created' }));
        const importedRows: unknown[] = [];
        app.post('/v3/sessions/child/transcript/import', async request => {
            const body = request.body as { items: unknown[] }; importedRows.push(...body.items);
            return { imported: body.items.length, cursor: body.items.length };
        });
        const copies = await seedForkVisualCopies({ credentials, accountEncryptionMode: 'plain', sourceSessionId: 'parent',
            cutoffSeqInclusive: 2, childSessionId: 'child', sourceMetadata: { path: '', host: '' } });
        expect(copies).toHaveLength(approved ? 1 : 2);
        expect(copies.map(copy => copy.status)).toEqual(approved ? ['copied'] : secondUnavailable ? ['copied', 'not_copied'] : ['copied', 'copied']);
        const references = copies.flatMap(copy => {
            if (copy.status !== 'copied') return [];
            const reference = { v: 1, itemId: copy.itemId, itemRevision: revision,
                sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' },
                sourceItemId: copy.originItemId, sourceItemRevision: revision };
            return approved ? settledApprovalReferences.map(origin => ({ ...reference, ...origin })) : [reference];
        });
        expect(importedRows).toEqual(rows.map(row => expect.objectContaining({
            content: { t: 'plain', v: expect.objectContaining({ content: row.content.v.content }) },
            surfaceItemReference: { v: 1, references },
        })));
        if (approved) expect(importedRows).toEqual(rows.map(() => expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
            meta: { forkVisualOriginV1: expect.objectContaining({ settledApprovalReferences }) },
        }) } })));
    });
    it('never rejects a committed fork when visual acquisition is unavailable', async () => {
        app.get('/v1/account/encryption/currentness', async (_request, reply) => reply.code(503).send({ error: 'offline' }));
        await expect(seedForkVisualsBestEffort({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 5, childSessionId: 'child' })).resolves.toBeUndefined();
    });
});
