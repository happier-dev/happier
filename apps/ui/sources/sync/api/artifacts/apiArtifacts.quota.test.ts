import { describe, expect, it } from 'vitest';
import { createArtifact, updateArtifact, deleteArtifact } from './apiArtifacts';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';

const refusal = { error: 'quota_exceeded', budget: 'document', limitBytes: 1_048_576, usedBytes: 1_363_148 };

describe('Artifact storage budget refusals', () => {
    it('keeps an unknown server exception out of the delete failure', async () => {
        const request = async () => Response.json({ error: 'private server exception' }, { status: 500 });
        await expect(deleteArtifact({ token: 't' }, 'a1', { request, retry: 'none' }))
            .rejects.toThrow('Failed to delete artifact: 500');
    });
    it.each(['create', 'update', 'delete'] as const)('preserves a typed 503 from %s without replaying the write', async operation => {
        let calls = 0;
        const request = async () => { calls++; return Response.json({ error: 'database_transaction_conflict_exhausted' }, { status: 503 }); };
        const opts = { request, retry: 'none' as const };
        const pending = operation === 'create'
            ? createArtifact({ token: 't' }, { id: 'a1', header: 'h', body: 'b', dataEncryptionKey: 'k' }, opts)
            : operation === 'update' ? updateArtifact({ token: 't' }, 'a1', { body: 'b', expectedBodyVersion: 1 }, opts)
                : deleteArtifact({ token: 't' }, 'a1', opts);
        await expect(pending).rejects.toMatchObject({ status: 503, code: 'database_transaction_conflict_exhausted', canTryAgain: true });
        expect(calls).toBe(1);
    });
    it('keeps a supported source operation target refusal distinct from an absent operation', async () => {
        const memoryDecisionSource = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
        const request = async () => Response.json({ error: 'Artifact not found' }, { status: 404 });
        await expect(updateArtifact({ token: 't' }, 'missing', { body: 'b', expectedBodyVersion: 1, memoryDecisionSource }, { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'not_found' });
    });
    it('refuses an unsupported source-bearing binary shape before upload', async () => {
        let requests = 0;
        const request = async () => { requests++; return Response.json({ error: 'Unexpected upload' }, { status: 400 }); };
        const memoryDecisionSource = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const blob = { blobId: '22222222-2222-4222-8222-222222222222', content: { t: 'plain' as const, v: 'AA==' } };
        await expect(createArtifact({ token: 't' }, { id: artifactId, header: 'h', body: 'b', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            blob, memoryDecisionSource }, { request, retry: 'none' })).rejects.toMatchObject({ code: 'memory_decision_source_unsupported' });
        await expect(updateArtifact({ token: 't' }, artifactId, { body: 'b', expectedBodyVersion: 1, blob, memoryDecisionSource }, { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'memory_decision_source_unsupported' });
        expect(requests).toBe(0);
    });
    it('refuses source writes without effects or ordinary-route fallback on an older Home', async () => {
        // The predecessor/released Home accepts ordinary writes and strips unknown fields.
        // Its existing generic /:artifactId update route is intentionally left reachable.
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const paths: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            paths.push(path);
            return await boundary.handle(path, init) ?? Response.json({ error: 'Route not found' }, { status: 404 });
        };
        const memoryDecisionSource = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
        const draft = { id: 'memory-decision', header: 'h', body: 'original', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
        // Seed through the canonical boundary; no client read is needed for these opaque wire writes.
        const original = await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(draft) });
        expect(original?.status).toBe(200);
        const before = boundary.read(draft.id);
        await expect(createArtifact({ token: 't' }, { ...draft, id: 'new-memory', memoryDecisionSource }, { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'memory_decision_source_unsupported' });
        await expect(updateArtifact({ token: 't' }, draft.id, { body: 'changed', expectedBodyVersion: 1, memoryDecisionSource }, { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'memory_decision_source_unsupported' });
        expect(boundary.list()).toEqual([before]);
        expect(paths).toEqual(['/v1/artifacts/memory-decision/create', '/v1/artifacts/memory-decision/memory-decision']);
    });
    it.each([
        ['memory_decision_source_unavailable', 404],
        ['memory_decision_source_unsupported', 409],
        ['memory_decision_disclosure_denied', 403],
    ] as const)('retains decision admission refusal %s on both writes', async (code, status) => {
        const request = async () => Response.json({ error: code }, { status });
        const memoryDecisionSource = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
        await expect(createArtifact({ token: 't' }, { id: 'a1', header: 'h', body: 'b', dataEncryptionKey: 'k', memoryDecisionSource }, { request }))
            .rejects.toMatchObject({ status, code });
        await expect(updateArtifact({ token: 't' }, 'a1', { body: 'b', expectedBodyVersion: 2, memoryDecisionSource }, { request }))
            .rejects.toMatchObject({ status, code });
    });
    it('names the refused budget and its sizes on create and update, without retrying', async () => {
        let calls = 0;
        const request = async () => { calls += 1; return Response.json(refusal, { status: 413 }); };
        await expect(createArtifact({ token: 't' }, { id: 'a1', header: 'h', body: 'b', dataEncryptionKey: 'k' }, { request }))
            .rejects.toMatchObject({ status: 413, code: 'quota_exceeded', quota: { budget: 'document', limitBytes: 1_048_576, usedBytes: 1_363_148 } });
        await expect(updateArtifact({ token: 't' }, 'a1', { body: 'b', expectedBodyVersion: 2 }, { request }))
            .rejects.toMatchObject({ status: 413, code: 'quota_exceeded', quota: { budget: 'document', limitBytes: 1_048_576, usedBytes: 1_363_148 } });
        expect(calls).toBe(2);
    });
});
