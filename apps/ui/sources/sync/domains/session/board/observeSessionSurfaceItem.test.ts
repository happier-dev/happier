import { describe, expect, it, vi } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionSurfaceItem, readRetainedSessionSurfaceItem, type SessionSurfaceItemBinding } from './observeSessionSurfaceItem';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import { log } from '@/log';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: scope.serverId, sessionId: 'session-one' };
const item = { v: 1, destination: 'transcript', title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } };
function record(itemId: string, content: unknown = { t: 'plain', v: item }) {
    return SessionSystemRecordStoredSchema.parse({ id: itemId, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId },
        content, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
}
const capabilities = { readTranscript: true, editSessionRecords: false };

describe('addressed Session surface item observation', () => {
    it.each([
        { code: 'plugin_session_record_forbidden', reason: 'forbidden' },
        { code: 'plugin_session_records_unavailable', reason: 'protocol_unavailable' },
        { code: 'account-encryption-currentness-unavailable', reason: 'encryption_material_unavailable' },
        { code: 'plugin_session_record_invalid_response', reason: 'invalid_response' },
        { code: 'session_board_storage_mode_mismatch', reason: 'session_board_storage_mode_mismatch' },
    ])('keeps $reason from the request boundary and never re-polls a definite refusal', async ({ code, reason }) => {
        vi.useFakeTimers();
        let requests = 0;
        const logStart = log.getCount();
        const repository = createSessionSystemRecordRepository({ scope, retryBackoff: { minDelayMs: 10, maxDelayMs: 100 },
            request: async () => { requests++; throw Object.assign(new Error('private transport detail'), { code }); } });
        let latest: SessionSurfaceItemBinding | undefined;
        const context = { mode: 'plain' } as const;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'refused',
            readCapabilities: () => capabilities,
            readContentContext: () => context,
            isCurrent: () => true, onChange: value => { latest = value; },
        });
        try {
            await flushHookEffects({ cycles: 20 });
            expect(latest).toEqual({ status: 'unavailable', reason });
            const diagnostics = log.getLogs().slice(logStart).join('\n');
            expect(diagnostics).toContain(`code=${reason}`);
            expect(diagnostics).not.toContain('private transport detail');
            await vi.advanceTimersByTimeAsync(1000);
            expect(requests).toBe(1);
        } finally { stop(); repository.retire(); vi.useRealTimers(); }
    });

    it('retires content on a record refusal and lets a later record read recover', async () => {
        let refused = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (refused) throw Object.assign(new Error('private record detail'), { code: 'forbidden' });
            return Response.json({ record: record('renewed') });
        } });
        let latest: SessionSurfaceItemBinding | undefined;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'renewed',
            readCapabilities: () => capabilities,
            readContentContext: () => ({ mode: 'plain' }),

            isCurrent: () => true, onChange: value => { latest = value; },
        });
        try {
            await flushHookEffects({ cycles: 20 });
            expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } } });
            refused = true;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 20 });
            expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
            refused = false;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 30 });
            expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } }, freshness: 'fresh' });
        } finally { stop(); repository.retire(); }
    });

    it('reads only demanded addresses, shares in-flight reads, and stops work while retaining hidden items', async () => {
        const reads: string[] = [];
        let decryptions = 0;
        let settle: (() => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            const query = new URL(path, 'https://home-a').searchParams;
            expect(query.get('kind')).toBe('item.v1');
            const id = query.get('localId')!;
            reads.push(id);
            if (reads.length === 1) await new Promise<void>(resolve => { settle = resolve; });
            return Response.json({ record: record(id, { t: 'encrypted', c: id }) });
        } });
        // The crypto adapter is the supplied Session-content boundary; the
        // envelope validation, opening policy, decoder and repository stay real.
        const context: SessionStoredContentContext = { mode: 'e2ee', encryption: {
            encryptRaw: async () => 'cipher', decryptRaw: async () => { decryptions++; return item; },
        } };
        const observed: SessionSurfaceItemBinding[] = [];
        const observe = (itemId: string) => observeSessionSurfaceItem({ session, repository, itemId,
            readCapabilities: () => capabilities,
            readContentContext: () => context,
            isCurrent: () => true, onChange: value => { observed.push(value); },
        });
        const stopFirst = observe('visible');
        const stopDuplicate = observe('visible');
        expect(reads).toEqual(['visible']);
        settle!();
        await flushHookEffects({ cycles: 30 });
        expect(observed.at(-1)).toMatchObject({ status: 'ready', item: { itemId: 'visible', state: { kind: 'ready' } } });
        expect(decryptions).toBe(1);
        const stopNear = observe('near');
        await flushHookEffects({ cycles: 20 });
        expect(reads).toEqual(['visible', 'near']);
        expect(decryptions).toBe(2);
        stopFirst(); stopDuplicate(); stopNear();
        repository.invalidate(session);
        await flushHookEffects({ cycles: 20 });
        expect(reads).toEqual(['visible', 'near']);
        expect(repository.getSnapshot(session, { type: 'read', address: {
            owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visible',
        } })).toMatchObject({
            data: { id: 'visible' }, freshness: 'stale', loading: 'idle',
        });
    });

    it('keeps locked and mode mismatch states explicit and makes revoked content unavailable synchronously', async () => {
        const encrypted = record('locked', { t: 'encrypted', c: 'cipher' });
        const repository = createSessionSystemRecordRepository({ scope, request: async () => Response.json({ record: encrypted }) });
        let context: Parameters<typeof repository.openSurfaceItem>[1] = { mode: 'e2ee', encryption: null };
        let readable = true;
        let latest: SessionSurfaceItemBinding | undefined;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'locked',
            readCapabilities: () => ({ ...capabilities, readTranscript: readable }),
            readContentContext: () => context,
            isCurrent: () => true, onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'locked' } } });
        const readRetained = () => readRetainedSessionSurfaceItem({ session, repository, itemId: 'locked',
            readCapabilities: () => ({ ...capabilities, readTranscript: readable }), readContentContext: () => context, isCurrent: () => true });
        expect(readRetained()).toMatchObject({ status: 'ready', item: { state: { kind: 'locked' } } });
        context = { mode: 'plain' };
        expect(readRetained()).toBeNull();
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'unopenable', reason: 'mode_mismatch' } } });
        readable = false;
        expect(readRetained()).toEqual({ status: 'unavailable', reason: 'forbidden' });
        repository.notifyContentContextChanged(session);
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        stop();
        repository.retire();
        expect(readRetained()).toEqual({ status: 'unavailable', reason: 'forbidden' });
    });

    it('retains content through a failed record read, then recovers and reports removal', async () => {
        let removed = false;
        let reachable = true;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (!reachable) throw new TypeError('Failed to fetch');
            return Response.json({ record: removed ? null : record('retained') });
        } });
        let latest: SessionSurfaceItemBinding | undefined;
        const context = { mode: 'plain' } as const;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'retained',
            readCapabilities: () => capabilities,
            readContentContext: () => context,
            isCurrent: () => true, onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } }, freshness: 'fresh', reachability: 'reachable' });
        reachable = false;
        repository.invalidate(session);
        expect(latest).toMatchObject({ status: 'ready', freshness: 'stale' });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } }, freshness: 'stale', reachability: 'reachable' });
        reachable = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', freshness: 'fresh', reachability: 'reachable' });
        removed = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { revision: null, state: { kind: 'removed' } } });
        stop();
    });
});
