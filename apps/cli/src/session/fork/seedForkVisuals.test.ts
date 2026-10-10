import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { seedForkVisualCopies, seedForkVisualsBestEffort } from './seedForkVisuals';

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
function toolRows(itemId: string, startSeq: number, destination: 'transcript' | 'board' = 'transcript', sessionId = 'parent') {
    const input = { sessionId, itemId, expectedItemRevision: destination === 'board' ? revision : null,
        destination, item: { ...item, destination } };
    const result = { v: 1, serverId: configuration.activeServerId, sessionId, itemDestination: destination, destination: null,
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
        app.get('/v2/sessions/:id', async request => ({ session: rawSession((request.params as { id: string }).id) }));
    });
    afterEach(async () => { restore(); vi.restoreAllMocks(); await app.close(); });

    it('copies only completed admitted references through the real transcript mutation and keeps independent successes on failure', async () => {
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
        const childRecords = new Map<string, unknown>();
        let parentContentAvailable = true;
        app.get('/v1/sessions/parent/messages', async () => ({ messages: [
            ...toolRows('good', 1), ...toolRows('missing', 3), ...toolRows('board-only', 5, 'board'), ...toolRows('late', 7),
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
        } } } }, surfaceItemReference: { v: 1, itemId: copies[0]?.status === 'copied' ? copies[0].itemId : null,
            itemRevision: revision, sourceAddress: { serverId: configuration.activeServerId, sessionId: 'parent' } } });
        expect(importedRows[2]).not.toHaveProperty('surfaceItemReference');
        parentContentAvailable = false;
        const recovered = await seedForkVisualCopies({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 7, childSessionId: 'child' });
        expect(recovered).toEqual(copies);
        expect(writes).toHaveLength(2);
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
        expect(importedRows).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ surfaceItemReference: {
            v: 1, itemId: copies[0]?.status === 'copied' ? copies[0].itemId : null, itemRevision: revision,
            sourceAddress: { serverId: configuration.activeServerId, sessionId: 'grandparent' },
        } })));
    });
    it('never rejects a committed fork when visual acquisition is unavailable', async () => {
        app.get('/v1/account/encryption/currentness', async (_request, reply) => reply.code(503).send({ error: 'offline' }));
        await expect(seedForkVisualsBestEffort({ credentials, sourceSessionId: 'parent', cutoffSeqInclusive: 5, childSessionId: 'child' })).resolves.toBeUndefined();
    });
});
