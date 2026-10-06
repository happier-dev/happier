import { describe, expect, it } from 'vitest';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionBoard, type SessionBoardBinding, type SessionBoardAuthority } from './observeSessionBoard';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: scope.serverId, sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } as const;
const hostedItem = {
    v: 1,
    title: 'Interactive view',
    frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: { kind: 'html', html: '<main>Hello</main>' } },
} as const;
function record(localId: string, kind: string, value: unknown) {
    return { id: localId, address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
}
const layout = record('layout', 'layout.v1', { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'full' }] }] });
const authority: SessionBoardAuthority = { contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true } };

describe('Board repository binding', () => {
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
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true, onChange: value => { latest = value; } });
        try {
            await flushHookEffects({ cycles: 50 });
            if (latest?.status !== 'ready') throw new Error('Board not ready');
            expect(latest.snapshot.layoutState.kind).toBe('ready');
            expect(latest.snapshot.itemsById.get('widget')?.state).toEqual({ kind: 'ready', item: widget });
            expect(latest.snapshot.itemsById.get('snapshot')?.state).toEqual({ kind: 'ready', item: snapshot });
            expect(latest.snapshot.itemsById.get('invalid')?.state.kind).toBe('unopenable');
            expect(latest.snapshot.itemsById.get('unknown')?.state.kind).toBe('unopenable');
        } finally { stop(); }
    });
    it('opens paged records, isolates malformed siblings, preserves offline content and retires denied access', async () => {
        let failure: 'offline' | 'forbidden' | null = null;
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            if (failure === 'offline') throw new TypeError('offline');
            if (failure === 'forbidden') return new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 });
            const cursor = new URL(path, 'https://home-a').searchParams.get('cursor');
            return new Response(JSON.stringify(cursor ? { records: [record('broken', 'item.v1', {})], nextCursor: null, hasNext: false }
                : { records: [layout, record('note', 'item.v1', item)], nextCursor: 'next', hasNext: true }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { incomplete: false, layoutState: { kind: 'ready' } } });
        if (latest?.status !== 'ready') throw new Error('Board not ready');
        expect(latest.snapshot.itemsById.get('note')?.state.kind).toBe('ready');
        expect(latest.snapshot.itemsById.get('broken')?.state.kind).toBe('unopenable');
        const previous = latest.snapshot.itemsById.get('note');
        failure = 'offline'; repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'offline', canEdit: true, capabilities: { editSessionRecords: true } } });
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
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => ({ status: 'ok', value: authority }),
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
        const stop = observeSessionBoard({ session: { ...session, serverId: 'home-b' }, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects();
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0); stop();
    });
});

describe('Board encryption and authority renewal', () => {
    it('makes retained content inert as soon as canonical access is revoked, before renewal settles', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [layout, record('note', 'item.v1', item)],
            nextCursor: null,
            hasNext: false,
        })) });
        let current = authority;
        let settleRenewal: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        let latest: SessionBoardBinding | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,
            renewAuthority: async () => await new Promise((resolve) => { settleRenewal = resolve; }),
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

        // Even a stale successful renewal result cannot overwrite the newer
        // canonical access projection that already revoked this viewer.
        settleRenewal?.({ status: 'ok', value: authority });
        await flushHookEffects({ cycles: 20 });
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
            authority,
            readCapabilities: () => null,
            readContentContext: () => null,
            renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0);
        stop();
    });

    it('coalesces one access renewal while the same record refresh publishes newer states', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [layout, record('note', 'item.v1', item)],
            nextCursor: null,
            hasNext: false,
        })) });
        let latest: SessionBoardBinding | undefined;
        let renewals = 0;
        let settleRenewal: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => {
                renewals += 1;
                return await new Promise((resolve) => { settleRenewal = resolve; });
            },
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });

        repository.invalidate(session);
        await flushHookEffects({ cycles: 10 });
        expect(renewals).toBe(1);
        settleRenewal?.({ status: 'ok', value: authority });
        await flushHookEffects({ cycles: 50 });

        expect(renewals).toBe(1);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });
        stop();
    });

    it('renews access again when a retained stale Board reconnects', async () => {
        let recordsOffline = false;
        let authorityOffline = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (recordsOffline) throw new TypeError('offline');
            return new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        let renewals = 0;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => {
                renewals += 1;
                return authorityOffline ? { status: 'offline' } : { status: 'ok', value: authority };
            },
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });

        recordsOffline = true;
        authorityOffline = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(1);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'offline' } });

        recordsOffline = false;
        authorityOffline = false;
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(2);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', reachability: 'reachable' } });

        authorityOffline = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(3);
        expect(repository.getSnapshot(session, { type: 'list', namespace: 'surface' }).freshness).toBe('fresh');
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'offline' } });

        authorityOffline = false;
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(4);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', reachability: 'reachable' } });
        stop();
    });

    it('reopens cached encrypted bytes when the Session key arrives, without another record GET', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++;
            return new Response(JSON.stringify({ records: [{ ...layout, content: { t: 'encrypted', c: 'layout' } }, { ...record('note', 'item.v1', item), content: { t: 'encrypted', c: 'item' } }], nextCursor: null, hasNext: false }));
        } });
        let current: SessionBoardAuthority = { ...authority, contentContext: { mode: 'e2ee', encryption: null } };
        let latest: SessionBoardBinding | undefined;
        let authorityRenewals = 0;
        const stop = observeSessionBoard({
            session,
            repository,
            authority: current,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,
            renewAuthority: async () => {
                authorityRenewals += 1;
                return { status: 'ok', value: current };
            },
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
        expect(authorityRenewals).toBe(0);
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
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
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
            if (offline) throw new TypeError('offline');
            return new Response(JSON.stringify({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'offline' });
        offline = false;
        repository.refreshObserved();
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { reachability: 'reachable', incomplete: false } });
        stop();
    });
});
