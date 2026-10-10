import { describe, expect, it } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionSurfaceItem, type SessionSurfaceItemBinding } from './observeSessionSurfaceItem';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';

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
    it('reads only demanded addresses, shares in-flight reads, and releases hidden items', async () => {
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
            authority: { contentContext: context, capabilities }, readCapabilities: () => capabilities,
            readContentContext: () => context, renewAuthority: async () => ({ status: 'ok', value: { contentContext: context, capabilities } }),
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
        expect(repository.getSnapshot(session, { type: 'read', address: record('visible').address }).data).toBeNull();
    });

    it('keeps locked and mode mismatch states explicit and makes revoked content unavailable synchronously', async () => {
        const encrypted = record('locked', { t: 'encrypted', c: 'cipher' });
        const repository = createSessionSystemRecordRepository({ scope, request: async () => Response.json({ record: encrypted }) });
        let context: Parameters<typeof repository.openSurfaceItem>[1] = { mode: 'e2ee', encryption: null };
        let readable = true;
        let latest: SessionSurfaceItemBinding | undefined;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'locked',
            authority: { contentContext: context, capabilities }, readCapabilities: () => ({ ...capabilities, readTranscript: readable }),
            readContentContext: () => context, renewAuthority: async () => ({ status: 'ok', value: { contentContext: context, capabilities } }),
            isCurrent: () => true, onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'locked' } } });
        context = { mode: 'plain' };
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'unopenable', reason: 'mode_mismatch' } } });
        readable = false;
        repository.notifyContentContextChanged(session);
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });

    it('retains content with stale offline authority, then recovers and reports removal', async () => {
        let removed = false;
        let reachable = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => Response.json({ record: removed ? null : record('retained') }) });
        let latest: SessionSurfaceItemBinding | undefined;
        const context = { mode: 'plain' } as const;
        const stop = observeSessionSurfaceItem({ session, repository, itemId: 'retained',
            authority: { contentContext: context, capabilities }, readCapabilities: () => capabilities,
            readContentContext: () => context, renewAuthority: async () => reachable
                ? { status: 'ok', value: { contentContext: context, capabilities } }
                : { status: 'offline' },
            isCurrent: () => true, onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } }, freshness: 'fresh', reachability: 'reachable' });
        repository.invalidate(session);
        expect(latest).toMatchObject({ status: 'ready', freshness: 'stale' });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } }, freshness: 'stale', reachability: 'offline' });
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
