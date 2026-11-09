import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it, vi } from 'vitest';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionBoard, type SessionBoardBinding } from './observeSessionBoard';
import type { SessionBoardCapabilities } from '@/sync/domains/session/board';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import { resolveSessionBoardRetainedFreshness } from '@/sync/domains/session/board/sessionBoardProjection';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: scope.serverId, sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } as const;
const hostedItem = {
    v: 1,
    title: 'Interactive view',
    frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>Hello</main>') },
} as const;
function record(localId: string, kind: string, value: unknown) {
    return { id: localId, address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
}
const layout = record('layout', 'layout.v1', { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'full' }] }] });
type ReadContext = Readonly<{ contentContext: SessionStoredContentContext | null; capabilities: SessionBoardCapabilities }>;
const authority: ReadContext = { contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true } };

describe('Board repository binding', () => {
    it.each(['forbidden', 'session_board_storage_mode_mismatch'] as const)('keeps a thrown %s record refusal and recovers on explicit invalidation', async code => {
        let refused = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (refused) throw Object.assign(new Error('private record detail'), { code });
            return Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,

            isCurrent: () => true, onChange: value => { latest = value; },
        });
        try {
            await flushHookEffects({ cycles: 50 });
            expect(latest?.status).toBe('ready');
            refused = true;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 50 });
            expect(latest).toEqual({ status: 'unavailable', reason: code });
            refused = false;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 50 });
            expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });
        } finally { stop(); repository.retire(); }
    });

    it('does no timer, read or publication work during a settled minute and leaves hidden invalidations dormant', async () => {
        let requests = 0;
        let publications = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++;
            return Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        } });
        const stop = observeSessionBoard({ session, repository,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            isCurrent: () => true,
            onChange: () => { publications++; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(requests).toBe(1);
        expect(publications).toBeGreaterThan(0);
        vi.useFakeTimers();
        const timers = installTimerCensus();
        try {
            publications = 0;
            await vi.advanceTimersByTimeAsync(60_000);
            expect({ reads: requests - 1, publications, timers: timers.read(), pendingTimers: vi.getTimerCount() })
                .toEqual({ reads: 0, publications: 0, timers: [], pendingTimers: 0 });
            stop();
            for (let wake = 0; wake < 60; wake++) {
                repository.invalidateAll();
                await vi.advanceTimersByTimeAsync(1000);
            }
            expect({ reads: requests - 1, publications, timers: timers.read(), pendingTimers: vi.getTimerCount() })
                .toEqual({ reads: 0, publications: 0, timers: [], pendingTimers: 0 });
        } finally {
            stop();
            repository.retire();
            timers.stop();
            vi.useRealTimers();
        }
    });
    it('does not inventory Session content before a Board consumer demands it', async () => {
        const requests: string[] = [];
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            requests.push(path);
            return Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        } });
        const stop = observeSessionBoard({ session, repository, demanded: false,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            isCurrent: () => true, onChange: () => {},
        });
        await flushHookEffects({ cycles: 10 });
        expect(requests).toEqual([]);
        stop();
    });
    it('normalizes additive stored fields while isolating invalid required fields and unknown sources', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'widget', definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'status' } },
            bindings: { session: { kind: 'context', slot: 'session' } },
        } } };
        const snapshot = { ...item, source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Frozen' } } },
            snapshot: { asOf: '2026-09-05T00:00:00.000Z', provenance: [{ label: 'Status' }] } };
        const storedWidget = { ...widget, extra: true, height: { ...widget.height, extra: true }, source: {
            ...widget.source, extra: true, instance: { ...widget.source.instance, extra: true,
                definition: { ...widget.source.instance.definition, extra: true, surface: { ...widget.source.instance.definition.surface, extra: true } },
                bindings: { session: { ...widget.source.instance.bindings.session, extra: true } },
            },
        } };
        const storedSnapshot = { ...snapshot, source: { ...snapshot.source, extra: true, document: { ...snapshot.source.document,
            extra: true, root: { ...snapshot.source.document.root, extra: true } } },
            snapshot: { ...snapshot.snapshot, extra: true, provenance: [{ label: 'Status', extra: true }] } };
        const savedLayout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'widget', width: 'full' }] }] };
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [record('layout', 'layout.v1', { ...savedLayout, extra: true, tabs: [{ ...savedLayout.tabs[0], extra: true,
                items: [{ ...savedLayout.tabs[0].items[0], extra: true }] }] }),
                record('widget', 'item.v1', storedWidget), record('snapshot', 'item.v1', storedSnapshot),
                record('invalid', 'item.v1', { ...item, height: { mode: 'fixed' } }),
                record('unknown', 'item.v1', { ...item, source: { kind: 'unknown' } })], nextCursor: null, hasNext: false,
        })) });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            isCurrent: () => true, onChange: value => { latest = value; } });
        try {
            await flushHookEffects({ cycles: 50 });
            if (latest?.status !== 'ready') throw new Error('Board not ready');
            expect(latest.snapshot.layoutState.kind).toBe('ready');
            expect(latest.snapshot.itemsById.get('widget')?.state).toEqual({ kind: 'ready', item: { ...widget, destination: 'board' } });
            expect(latest.snapshot.itemsById.get('snapshot')?.state).toEqual({ kind: 'ready', item: { ...snapshot, destination: 'board' } });
            expect(latest.snapshot.itemsById.get('invalid')?.state.kind).toBe('unopenable');
            expect(latest.snapshot.itemsById.get('unknown')?.state.kind).toBe('unopenable');
        } finally { stop(); }
    });
    it('opens paged records, isolates malformed siblings, preserves offline content and retires denied access', async () => {
        let failure: 'offline' | 'forbidden' | null = null;
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            if (failure === 'offline') throw new TypeError('Failed to fetch');
            if (failure === 'forbidden') return new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 });
            const cursor = new URL(path, 'https://home-a').searchParams.get('cursor');
            return new Response(JSON.stringify(cursor ? { records: [record('broken', 'item.v1', {})], nextCursor: null, hasNext: false }
                : { records: [layout, record('note', 'item.v1', item)], nextCursor: 'next', hasNext: true }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { incomplete: false, layoutState: { kind: 'ready' } } });
        if (latest?.status !== 'ready') throw new Error('Board not ready');
        expect(latest.snapshot.itemsById.get('note')?.state.kind).toBe('ready');
        expect(latest.snapshot.itemsById.get('broken')?.state.kind).toBe('unopenable');
        const previous = latest.snapshot.itemsById.get('note');
        failure = 'offline'; repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        // A thrown read is not evidence the Home is offline: the retained Board stays reachable.
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'reachable', canEdit: true, capabilities: { editSessionRecords: true } } });
        expect(latest.snapshot.itemsById.get('note')).toBe(previous);
        failure = 'forbidden'; repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
    it('retires a previously ready executable Board when any required page reports the feature disabled', async () => {
        let featureDisabled = false;
        const hostedLayout = record('layout', 'layout.v1', {
            v: 1,
            tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'interactive', width: 'full' }] }],
        });
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            const cursor = new URL(path, 'https://home-a').searchParams.get('cursor');
            if (featureDisabled && cursor === 'next') {
                return new Response(JSON.stringify({ error: 'disabled', code: 'plugin_session_record_feature_disabled' }), { status: 404 });
            }
            return new Response(JSON.stringify(cursor
                ? { records: [record('interactive', 'item.v1', hostedItem)], nextCursor: null, hasNext: false }
                : { records: [hostedLayout], nextCursor: 'next', hasNext: true }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,

            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { incomplete: false } });
        if (latest?.status !== 'ready') throw new Error('Board not ready');
        expect(latest.snapshot.itemsById.get('interactive')?.state.kind).toBe('ready');
        expect(latest.snapshot.views[0]?.placements[0]?.itemId).toBe('interactive');

        featureDisabled = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'board_feature_disabled' });
        expect(repository.getSnapshot(session, {
            type: 'list',
            namespace: 'surface',
            cursor: 'next',
        })).toMatchObject({
            data: { records: [{ address: { localId: 'interactive' } }] },
            freshness: 'stale',
            lastError: { status: 'feature_disabled' },
        });
        stop();
    });
    it('does not read under unknown access or another Home', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => { requests++; return new Response('{}'); } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session: { ...session, serverId: 'home-b' }, repository, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects();
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0); stop();
    });
});

describe('Board encryption and canonical access', () => {
    it.each(['plain', 'e2ee'] as const)('keeps explicit envelope/mode handling and Board orphan recovery in %s mode', async mode => {
        const encryption = new SessionEncryption(session.sessionId,
            new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
        const boardItem = { ...item, destination: 'board' as const };
        const seal = async (value: unknown) => mode === 'plain'
            ? { t: 'plain' as const, v: value } : { t: 'encrypted' as const, c: await encryption.encryptRaw(value) };
        const stored = (localId: string, kind: string, content: unknown) =>
            SessionSystemRecordStoredSchema.parse({ ...record(localId, kind, null), content });
        const records = [stored('layout', 'layout.v1', await seal(layout.content.v)),
            stored('note', 'item.v1', await seal(boardItem)), stored('orphan', 'item.v1', await seal(boardItem)),
            stored('wrong-mode', 'item.v1', mode === 'plain'
                ? { t: 'encrypted', c: await encryption.encryptRaw(boardItem) } : { t: 'plain', v: boardItem }),
            stored('failed-decrypt', 'item.v1', { t: 'encrypted', c: 'not-authenticated-ciphertext' })];
        const repository = createSessionSystemRecordRepository({ scope, request: async () =>
            Response.json({ records, nextCursor: null, hasNext: false }) });
        const current: ReadContext = { capabilities: authority.capabilities,
            contentContext: mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', encryption } };
        let settle!: (binding: Extract<SessionBoardBinding, { status: 'ready' }>) => void;
        const settled = new Promise<Extract<SessionBoardBinding, { status: 'ready' }>>(resolve => { settle = resolve; });
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,
            isCurrent: () => true, onChange: binding => {
                if (binding.status === 'ready' && !binding.snapshot.incomplete && binding.snapshot.loading === 'idle') settle(binding);
            } });
        try {
            const { snapshot } = await settled;
            expect(snapshot.views[0]?.placements[0]?.item.state).toEqual({ kind: 'ready', item: boardItem });
            expect(snapshot.unplacedItemIds).toEqual(['orphan']);
            expect(snapshot.itemsById.get('wrong-mode')?.state).toEqual({ kind: 'unopenable', reason: 'mode_mismatch' });
            expect(snapshot.itemsById.get('failed-decrypt')?.state).toEqual({ kind: 'unopenable',
                reason: mode === 'plain' ? 'mode_mismatch' : 'corrupt_or_unopenable' });
        } finally { stop(); repository.retire(); }
    });
    it('keeps retained content while a background record reread settles, and reports a failed reread', async () => {
        const response = () => Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        let failRead: ((error: Error) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>((_resolve, reject) => { failRead = reject; }) : response() });
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,

            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', loading: 'idle' } });
            refreshing = true;
            seen.length = 0;
            repository.refreshObserved({ force: true });
            await flushHookEffects({ cycles: 10 });
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(binding => binding.status === 'ready'
                && resolveSessionBoardRetainedFreshness(binding.snapshot) === null
                && binding.snapshot.loading === 'refreshing')).toBe(true);
            failRead?.(new RetryableServerResponseError(503, 'private server detail'));
            await flushHookEffects({ cycles: 30 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: {
                freshness: 'stale', loading: 'idle', itemsById: expect.any(Map),
            } });
            const failed = seen.at(-1);
            if (failed?.status !== 'ready') throw new Error('Board lost its retained content');
            expect(resolveSessionBoardRetainedFreshness(failed.snapshot)).toBe('stale');
            expect(failed.snapshot.itemsById.get('note')?.state.kind).toBe('ready');
        } finally { stop(); }
    });

    it('keeps an unchanged widget admitted through a Board reread, but withdraws it on access loss', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'counter', bindings: {},
            definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'counter' } },
        } } } as const;
        const response = () => Response.json({ records: [layout, record('counter', 'item.v1', widget)], nextCursor: null, hasNext: false });
        let settleRead: ((value: Response) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>(resolve => { settleRead = resolve; }) : response() });
        let current = authority;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository,
            readCapabilities: () => current.capabilities, readContentContext: () => current.contentContext,

            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            const initial = seen.at(-1);
            if (initial?.status !== 'ready') throw new Error('Board not ready');
            const counter = initial.snapshot.itemsById.get('counter')!;
            expect(counter.state.kind).toBe('ready');
            refreshing = true;
            seen.length = 0;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 10 });
            const pending = seen.at(-1);
            expect(pending).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', loading: 'refreshing' } });
            if (pending?.status !== 'ready') throw new Error('Board lost its retained content');
            expect(resolveSessionBoardRetainedFreshness(pending.snapshot)).toBeNull();
            expect(pending.snapshot.itemsById.get('counter')).toBe(counter);
            expect(seen.every(binding => binding.status === 'ready'
                && binding.snapshot.itemsById.get('counter') === counter)).toBe(true);

            // A fresh record response cannot revive content after canonical access loss.
            settleRead?.(response());
            await flushHookEffects({ cycles: 10 });
            current = { ...authority, capabilities: { readTranscript: false, editSessionRecords: false } };
            repository.notifyContentContextChanged(session);
            await flushHookEffects({ cycles: 10 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
        } finally { stop(); }
    });

    it('keeps an installed widget running through a thrown Board read and recovers on the sync backoff', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'counter', bindings: {},
            definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'counter' } },
        } } } as const;
        let failing = false;
        const repository = createSessionSystemRecordRepository({ scope, retryBackoff: { minDelayMs: 20, maxDelayMs: 40 }, request: async () => {
            if (failing) throw new TypeError('Failed to fetch');
            return Response.json({ records: [layout, record('counter', 'item.v1', widget)], nextCursor: null, hasNext: false });
        } });
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            const initial = seen.at(-1);
            if (initial?.status !== 'ready') throw new Error('Board not ready');
            const counter = initial.snapshot.itemsById.get('counter')!;
            failing = true;
            seen.length = 0;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 30 });
            await new Promise(resolve => setTimeout(resolve, 100));
            await flushHookEffects({ cycles: 30 });
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(binding => binding.status === 'ready' && binding.snapshot.reachability === 'reachable'
                && binding.snapshot.itemsById.get('counter') === counter)).toBe(true);
            failing = false;
            await new Promise(resolve => setTimeout(resolve, 150));
            await flushHookEffects({ cycles: 30 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', loading: 'idle', reachability: 'reachable' } });
        } finally { stop(); }
    });

    it('does not republish retained Board content after a record denial', async () => {
        let settleRead: ((value: Response) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>(resolve => { settleRead = resolve; })
            : Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false }) });
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,

            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });
            refreshing = true;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 10 });
            settleRead?.(Response.json({ error: 'denied', code: 'plugin_session_record_forbidden' }, { status: 403 }));
            await flushHookEffects({ cycles: 10 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
            const afterDenial = seen.length;
            await flushHookEffects({ cycles: 30 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
            expect(seen.slice(afterDenial).every(binding => binding.status === 'unavailable')).toBe(true);
        } finally { stop(); }
    });

    it('makes retained content unavailable as soon as canonical access is revoked', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [layout, record('note', 'item.v1', item)],
            nextCursor: null,
            hasNext: false,
        })) });
        let current = authority;
        let latest: SessionBoardBinding | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({
            session,
            repository,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,

            isCurrent: () => true,
            onChange: (value: SessionBoardBinding) => { latest = value; seen.push(value); },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'ready' } } });

        seen.length = 0;
        current = { ...authority, capabilities: { readTranscript: true, editSessionRecords: false } };
        repository.invalidate(session);
        await flushHookEffects({ cycles: 10 });

        expect(latest).toMatchObject({
            status: 'ready',
            snapshot: {
                canEdit: false,
                capabilities: { readTranscript: true, editSessionRecords: false },
            },
        });
        expect(seen.filter((binding): binding is Extract<SessionBoardBinding, { status: 'ready' }> => binding.status === 'ready')
            .every((binding) => binding.snapshot.canEdit === false)).toBe(true);

        current = { ...authority, capabilities: { readTranscript: false, editSessionRecords: false } };
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 10 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 10 });
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });

        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });

    it('does not expose same-id content when the canonical Session projection belongs to another Home', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            return new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            readCapabilities: () => null,
            readContentContext: () => null,

            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0);
        stop();
    });

    it('refreshes retained stale Board records when reconnecting', async () => {
        let recordsOffline = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (recordsOffline) throw new TypeError('Failed to fetch');
            return new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,

            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });

        recordsOffline = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'reachable' } });

        recordsOffline = false;
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', reachability: 'reachable' } });

        stop();
    });

    it('reopens cached encrypted bytes when the Session key arrives, without another record GET', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++;
            return new Response(JSON.stringify({ records: [{ ...layout, content: { t: 'encrypted', c: 'layout' } }, { ...record('note', 'item.v1', item), content: { t: 'encrypted', c: 'item' } }], nextCursor: null, hasNext: false }));
        } });
        let current: ReadContext = { ...authority, contentContext: { mode: 'e2ee', encryption: null } };
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,

            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'locked' } } });
        // Crypto is the system boundary; codec, repository and projection stay real.
        current = { ...authority, contentContext: { mode: 'e2ee', encryption: { encryptRaw: async () => '', decryptRaw: async ciphertext => ciphertext === 'layout' ? layout.content.v : item } } };
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'ready' } } });
        expect(requests).toBe(1);
        current = { ...current, capabilities: { readTranscript: false, editSessionRecords: false } };
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        repository.retire();
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
});

describe('Board lifetime', () => {
    it('discards a late page when the Account repository retires', async () => {
        let resolve: ((response: Response) => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Promise<Response>(settle => { resolve = settle; }) });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects();
        repository.retire();
        resolve?.(new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false })));
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
});

describe('Board initial failure', () => {
    it('ends initial loading with an offline result when no stored content was read', async () => {
        let offline = true;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (offline) throw new TypeError('Failed to fetch');
            return new Response(JSON.stringify({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'offline' });
        offline = false;
        repository.refreshObserved();
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { reachability: 'reachable', incomplete: false } });
        stop();
    });
});
