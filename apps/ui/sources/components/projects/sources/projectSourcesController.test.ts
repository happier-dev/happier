import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createProjectSourcesController } from './projectSourcesController';
import type { ServerFetch } from '@/sync/http/client';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { observeProjectSources } from './observeProjectSources';
import { createProjectSourcesCatalog } from './projectSourcesCatalog';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' }, protocol: 'https' } satisfies ProjectSourceRepositorySelectorV1;
const source = (revision = 1) => ({ id: 'source-a', revision, name: 'Repository', repository,
    audience: [], createdByAccountId: scope.accountId });
function harness(request: ServerFetch, observeContext?: (context: Parameters<ReturnType<typeof createActionExecutor>['execute']>[2]) => void) {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', request,
            assertCurrent() {}, workflowArtifacts: { read: async () => null } }),
    }));
    // This fixture is an already-approved present user's Account channel; the
    // shared executor still validates every request/result and dispatches the real transport.
    return createProjectSourcesController(scope, (id, input, context) => {
        observeContext?.(context);
        return executor.execute(id, input, { ...context, authority: 'present_user', bypassApprovals: true });
    });
}
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(
    body && typeof body === 'object' && 'source' in body ? { ...body, canManage: true } : body,
), { status });

describe('Project Sources controller through Source Actions', () => {
    it('retires unused searches from wake demand while retaining the default catalog across navigation', async () => {
        const requested: string[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {},
                workflowArtifacts: { read: async () => null }, request: async path => {
                    requested.push(new URL(path, 'https://home.test').searchParams.get('query') ?? '');
                    return answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } });
                } }),
        }));
        const catalog = createProjectSourcesCatalog({ scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            (id, input, context) => executor.execute(id, input, { ...context, authority: 'present_user', bypassApprovals: true }));
        const all = catalog.read('', undefined);
        const stopAll = all.subscribe(() => {});
        const stopDemand = catalog.demand();
        await all.load();
        const searched = catalog.read('old search', undefined);
        const stopSearch = searched.subscribe(() => {});
        await searched.load('old search');
        stopSearch();
        expect(searched.getSnapshot().rows).toEqual([]);
        requested.length = 0;
        publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.waitFor(() => expect(requested).toEqual(['']));
        stopAll(); stopDemand();
        expect(catalog.read('', undefined).getSnapshot().rows).toBe(all.getSnapshot().rows);
        expect(all.getSnapshot().rows.map(row => row.id)).toEqual(['source-a']);
        catalog.dispose();
    });
    it('coalesces simultaneous demand for the same catalog instead of aborting the first reader', async () => {
        let finish!: (value: Response) => void;
        let started!: () => void;
        const ready = new Promise<void>(done => { started = done; });
        let aborted = false;
        const controller = harness(async (_path, init) => {
            init?.signal?.addEventListener('abort', () => { aborted = true; });
            return new Promise<Response>(done => { finish = done; started(); });
        });
        const first = controller.load();
        await ready;
        const second = controller.load();
        finish(answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await Promise.all([first, second]);
        expect(aborted).toBe(false);
        expect(controller.getSnapshot()).toMatchObject({ status: 'ready', rows: [{ id: 'source-a' }] });
        controller.dispose();
    });
    it('isolates filtered catalog queries, shares acknowledgements, and clears authorized rows on Account retirement', async () => {
        let current = true;
        let retire = () => {};
        let pending = false;
        let visible = true;
        let finish!: (response: Response) => void;
        let started!: () => void;
        const ready = new Promise<void>(done => { started = done; });
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {},
                workflowArtifacts: { read: async () => null }, request: async path => {
                    if (pending) return new Promise<Response>(done => { finish = done; started(); });
                    return answer({ ok: true, sources: !visible || path.includes('query=other') ? [] : [source()], coverage: { complete: true, nextCursor: null } });
                } }),
        }));
        const catalog = createProjectSourcesCatalog({ scope, isCurrent: () => current,
            onRetire: callback => { retire = callback; return { dispose() {} }; } },
            (id, input, context) => execute.execute(id, input, { ...context, authority: 'present_user', bypassApprovals: true }));
        const all = catalog.read('', undefined);
        await all.load();
        const editor = createProjectSourcesController(scope, (id, input, context) => execute.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }), undefined, catalog.read);
        const stopEditor = editor.subscribe(() => {});
        editor.beginCreate({ name: 'Private unsaved draft', repository });
        const filtered = catalog.read('other', undefined);
        await filtered.load('other');
        expect(filtered.getSnapshot().rows).toEqual([]);
        expect(all.getSnapshot().rows.map(row => row.id)).toEqual(['source-a']);
        pending = true;
        const refresh = all.load();
        await ready;
        all.acknowledgeCatalog({ ...source(2), name: 'Acknowledged edit' });
        finish(answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await refresh;
        expect(all.getSnapshot().rows[0]).toMatchObject({ revision: 2, name: 'Acknowledged edit' });
        expect(filtered.getSnapshot().rows).toEqual([]);
        pending = false;
        const matching = catalog.read('Repository', undefined);
        await matching.load('Repository');
        expect(matching.getSnapshot().rows.map(row => row.id)).toEqual(['source-a']);
        visible = false;
        await all.load();
        expect(matching.getSnapshot().rows).toEqual([]);
        current = false; retire();
        expect(all.getSnapshot().rows).toEqual([]);
        expect(all.getSnapshot().status).toBe('refused');
        expect(editor.getSnapshot().creationDraft).toBeNull();
        expect(editor.getSnapshot().rows).toEqual([]);
        stopEditor(); editor.dispose();
        catalog.dispose();
    });
    it('shares hydrated catalog rows across mounts while keeping editor drafts independent', async () => {
        const catalog = harness(async () => answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await catalog.load();
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {},
                workflowArtifacts: { read: async () => null }, request: async () => answer({ ok: true, source: source() }) }),
        }));
        const mount = () => createProjectSourcesController(scope, (id, input, context) => execute.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }), undefined, () => catalog);
        const first = mount();
        expect(first.getSnapshot().rows).toBe(catalog.getSnapshot().rows);
        await first.select('source-a');
        first.edit({ name: 'Private draft' });
        first.dispose();
        const second = mount();
        expect(second.getSnapshot().rows).toBe(catalog.getSnapshot().rows);
        expect(second.getSnapshot().draft).toBeNull();
        expect(second.getSnapshot().selectedId).toBeNull();
        second.dispose(); catalog.dispose();
    });
    it('finishes a mismatched Source read as unavailable instead of following a different Source or remaining loading', async () => {
        let mismatched = false;
        const controller = harness(async () => answer({ ok: true, source: { ...source(), id: mismatched ? 'source-b' : 'source-a' } }));
        await controller.select('source-a');
        mismatched = true;
        await controller.select('source-a');
        expect(controller.getSnapshot()).toMatchObject({ detailStatus: 'refused', issue: 'source_invalid' });
        expect(controller.getSnapshot().current?.id).not.toBe('source-b');
    });

    it('retains a draft across offline and conflict outcomes until an acknowledged save', async () => {
        let mode = 'read';
        const controller = harness(async () => {
            if (mode === 'offline') throw new Error('network disconnected');
            if (mode === 'conflict') return answer({ ok: false, error: 'source_conflict', current: source(2) }, 409);
            return answer({ ok: true, source: source(mode === 'save' ? 3 : 1) });
        });
        await controller.select('source-a');
        controller.edit({ name: 'Edited locally' });
        await controller.resolveAddress('github.com/owner/repo', { machines: [] });
        expect(controller.getSnapshot().addressSaveDisabledReason).toBeNull();
        mode = 'offline';
        await controller.save();
        expect(controller.getSnapshot().draft?.name).toBe('Edited locally');
        mode = 'conflict';
        await controller.save();
        expect(controller.getSnapshot().draft?.name).toBe('Edited locally');
        expect(controller.getSnapshot().conflict?.revision).toBe(2);
        expect(controller.getSnapshot().current?.revision).toBe(1);
        controller.acceptCurrentRevision();
        mode = 'save';
        await controller.save();
        expect(controller.getSnapshot().draft).toBeNull();
        expect(controller.getSnapshot().current?.revision).toBe(3);
    });

    it('discards retired Home responses and keeps catalog coverage from the authenticated answer', async () => {
        let resolve!: (value: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        const controller = harness(async () => new Promise<Response>((done) => { resolve = done; issued(); }));
        const load = controller.load('owner');
        await ready;
        controller.dispose();
        resolve(answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await load;
        expect(controller.getSnapshot().rows).toEqual([]);
        const current = harness(async () => answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await current.load('owner');
        expect(current.getSnapshot().coverage).toEqual({ complete: true, nextCursor: null });
        expect(current.getSnapshot().query).toBe('owner');
    });

    it('drops revoked Source metadata and its draft while leaving other catalog rows intact', async () => {
        let revoked = false;
        const controller = harness(async () => revoked
            ? answer({ ok: false, error: 'source_unavailable' }, 404)
            : answer({ ok: true, source: source() }));
        await controller.select('source-a');
        controller.edit({ name: 'Private edit' });
        revoked = true;
        await controller.select('source-a');
        expect(controller.getSnapshot().current).toBeNull();
        expect(controller.getSnapshot().draft).toBeNull();
        expect(controller.getSnapshot().issue).toBe('source_unavailable');
    });

    it.each([
        { query: '', complete: true, drops: true },
        { query: 'other', complete: true, drops: false },
        { query: '', complete: false, drops: false },
    ])('uses only complete unfiltered catalog absence to drop an unselected cached Source ($query/$complete)', async ({ query, complete, drops }) => {
        let resolve!: (response: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>(done => { issued = done; });
        let retired = false;
        const controller = harness(async (path) => {
            if (path.includes('/source-a?')) return retired
                ? new Promise<Response>(done => { resolve = done; issued(); })
                : answer({ ok: true, source: source() });
            if (path.includes('/source-b?')) return answer({ ok: true, source: { ...source(), id: 'source-b' } });
            return answer({ ok: true, sources: [{ ...source(), id: 'source-b' }], coverage: { complete, nextCursor: complete ? null : 'next' } });
        });
        await controller.select('source-a');
        controller.edit({ name: 'Private A draft' });
        await controller.select('source-b');
        retired = true;
        await controller.load(query);
        const read = controller.select('source-a');
        await ready;
        expect(controller.getSnapshot().current?.id ?? null).toBe(drops ? null : 'source-a');
        expect(controller.getSnapshot().draft?.name ?? null).toBe(drops ? null : 'Private A draft');
        resolve(answer({ ok: false, error: drops ? 'source_unavailable' : 'source_backend_unavailable' }, drops ? 404 : 503));
        await read;
    });

    it('preserves edits typed after a save was dispatched and uses the acknowledged revision next time', async () => {
        let resolve!: (value: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        let pending = false;
        const writes: unknown[] = [];
        const controller = harness(async (_path, init) => {
            if (init?.method !== 'PATCH') return answer({ ok: true, source: source() });
            writes.push(JSON.parse(String(init.body)));
            if (!pending) { pending = true; return new Promise<Response>((done) => { resolve = done; issued(); }); }
            return answer({ ok: true, source: source(3) });
        });
        await controller.select('source-a');
        controller.edit({ name: 'First edit' });
        const save = controller.save();
        await ready;
        controller.edit({ name: 'Newer edit' });
        resolve(answer({ ok: true, source: source(2) }));
        await save;
        expect(controller.getSnapshot().draft?.name).toBe('Newer edit');
        await controller.save();
        expect(writes).toMatchObject([{ expectedRevision: 1 }, { expectedRevision: 2 }]);
    });

    it('retains a newer explicit revert to the pre-save value while acknowledging an earlier save', async () => {
        let resolve!: (response: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>(done => { issued = done; });
        const controller = harness(async (_path, init) => init?.method !== 'PATCH'
            ? answer({ ok: true, source: source() })
            : new Promise<Response>(done => { resolve = done; issued(); }));
        await controller.select('source-a');
        controller.edit({ name: 'Earlier title' });
        const save = controller.save();
        await ready;
        controller.edit({ name: source().name });
        resolve(answer({ ok: true, source: { ...source(2), name: 'Earlier title' } }));
        await save;
        expect(controller.getSnapshot().current?.name).toBe('Earlier title');
        expect(controller.getSnapshot().draft?.name).toBe(source().name);
    });

    it('does not carry an edit into another Source and restores it when selected again', async () => {
        const controller = harness(async (path) => answer({ ok: true,
            source: { ...source(), id: path.includes('source-b') ? 'source-b' : 'source-a' } }));
        await controller.select('source-a');
        controller.edit({ name: 'Unsaved A' });
        await controller.select('source-b');
        expect(controller.getSnapshot().draft).toBeNull();
        await controller.select('source-a');
        expect(controller.getSnapshot().draft?.name).toBe('Unsaved A');
    });

    it('keeps the earlier page and reports the current query coverage while paging', async () => {
        const controller = harness(async (path) => answer(path.includes('cursor=next')
            ? { ok: true, sources: [{ ...source(), id: 'source-b' }], coverage: { complete: true, nextCursor: null } }
            : { ok: true, sources: [source()], coverage: { complete: false, nextCursor: 'next' } }));
        await controller.load('owner');
        expect(controller.getSnapshot().coverage).toEqual({ complete: false, nextCursor: 'next' });
        const first = controller.getSnapshot().rows[0];
        await controller.load('owner', 'next');
        expect(controller.getSnapshot().rows.map((row) => row.id)).toEqual(['source-a', 'source-b']);
        expect(controller.getSnapshot().rows[0]).toBe(first);
        expect(controller.getSnapshot().coverage.complete).toBe(true);
    });

    it('ignores an earlier search response after a newer authenticated query completed', async () => {
        let resolve!: (value: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        const controller = harness(async (path) => path.includes('query=first')
            ? new Promise<Response>((done) => { resolve = done; issued(); })
            : answer({ ok: true, sources: [{ ...source(), id: 'second' }], coverage: { complete: true, nextCursor: null } }));
        const earlier = controller.load('first');
        await ready;
        await controller.load('second');
        resolve(answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await earlier;
        expect(controller.getSnapshot().rows.map((row) => row.id)).toEqual(['second']);
        expect(controller.getSnapshot().query).toBe('second');
    });

    it('keeps an uncertain create until catalog absence was observed and the user deliberately retries', async () => {
        let creates = 0;
        const writes: Record<string, unknown>[] = [];
        const actionKeys: (string | undefined)[] = [];
        const controller = harness(async (_path, init, options) => {
            if (init?.method === 'GET') return answer({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } });
            creates += 1;
            writes.push(JSON.parse(String(init?.body)));
            options?.onIssued?.();
            if (creates === 1) throw new Error('response lost');
            return answer({ ok: true, source: source() });
        }, (context) => { if (context?.actionRequestId) actionKeys.push(context.actionRequestId); });
        controller.beginCreate({ name: 'Repository', repository });
        await controller.save();
        expect(controller.getSnapshot().issue).toBe('outcome_unknown');
        expect(controller.getSnapshot().creationDraft).not.toBeNull();
        await controller.save();
        expect(creates).toBe(1);
        expect(controller.confirmCreateRetryAfterInspection()).toBe(false);
        await controller.load('');
        expect(controller.confirmCreateRetryAfterInspection()).toBe(true);
        await controller.save();
        expect(creates).toBe(2);
        expect(controller.getSnapshot().draft).toBeNull();
        expect(writes[0].requestKey).toEqual(expect.any(String));
        expect(writes[1]).toEqual(writes[0]);
        expect(actionKeys).toEqual([writes[0].requestKey, writes[0].requestKey]);
        controller.beginCreate({ name: 'Another Source', repository });
        await controller.save();
        expect(writes[2].requestKey).not.toBe(writes[0].requestKey);
    });

    it('acknowledges a dispatched create while preserving newer invalid folder typing as a saved-Source edit', async () => {
        let finish!: (response: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>(done => { issued = done; });
        let creates = 0;
        const controller = harness(async (_path, init) => {
            if (init?.method !== 'POST') return answer({ ok: true, source: source() });
            creates += 1;
            return new Promise<Response>(done => { finish = done; issued(); });
        });
        controller.beginCreate({ name: 'Repository', repository });
        const pending = controller.save();
        await ready;
        controller.editCreation({ subdir: '../still-typing' });
        finish(answer({ ok: true, source: source() }));
        await pending;
        expect(controller.getSnapshot().current?.id).toBe('source-a');
        expect(controller.getSnapshot().draft?.subdir).toBe('../still-typing');
        expect(controller.getSnapshot().creationDraft).toBeNull();
        await controller.save();
        expect(creates).toBe(1);
    });

    it('does not retry an uncertain create when inspection finds matching metadata, even with a retained request key', async () => {
        let creates = 0;
        const controller = harness(async (_path, init, options) => {
            if (init?.method === 'GET') return answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } });
            creates += 1;
            options?.onIssued?.();
            throw new Error('response lost');
        });
        controller.beginCreate({ name: 'Repository', repository });
        await controller.save();
        await controller.load('');
        expect(controller.confirmCreateRetryAfterInspection()).toBe(false);
        await controller.save();
        expect(creates).toBe(1);
    });

    it('replays the sealed create payload and retains newer typing as an edit after acknowledgement', async () => {
        const writes: Record<string, unknown>[] = [];
        const controller = harness(async (_path, init, options) => {
            if (init?.method === 'GET') return answer({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } });
            writes.push(JSON.parse(String(init?.body)));
            if (writes.length === 1) { options?.onIssued?.(); throw new Error('response lost'); }
            return answer({ ok: true, source: source() });
        });
        controller.beginCreate({ name: 'Repository', repository });
        await controller.save();
        controller.edit({ name: 'Newer local title' });
        await controller.load('');
        expect(controller.confirmCreateRetryAfterInspection()).toBe(true);
        controller.discard();
        controller.beginCreate({ name: 'Newer local title', repository });
        await controller.save();
        expect(writes[1]).toEqual(writes[0]);
        expect(controller.getSnapshot().draft?.name).toBe('Newer local title');
        expect(controller.getSnapshot().current?.name).toBe('Repository');
    });

    it('saves only edited metadata fields after an independent audience acknowledgement', async () => {
        const bodies: Record<string, unknown>[] = [];
        const audience = [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }];
        const controller = harness(async (_path, init) => {
            if (init?.method !== 'PATCH') return answer({ ok: true, source: source() });
            bodies.push(JSON.parse(String(init.body)));
            return answer({ ok: true, source: { ...source(bodies.length + 1), audience,
                ...(bodies.length === 2 ? { name: 'New name' } : {}) } });
        });
        await controller.select('source-a');
        controller.edit({ name: 'New name' });
        await controller.updateSource({ audience: [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }] });
        await controller.save();
        expect(bodies[1]).toMatchObject({ expectedRevision: 2, patch: { name: 'New name' } });
        expect(bodies[1].patch).not.toHaveProperty('audience');
        expect(controller.getSnapshot().current?.audience).toEqual(audience);
    });

    it('does not turn carried newer metadata typing into an audience revocation', async () => {
        const writes: Record<string, unknown>[] = [];
        const audience = [{ principal: { kind: 'team' as const, teamId: 'team-a' }, level: 'view' as const }];
        let resolve!: (response: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>(done => { issued = done; });
        const controller = harness(async (_path, init) => {
            if (init?.method !== 'PATCH') return answer({ ok: true, source: source() });
            writes.push(JSON.parse(String(init.body)));
            if (writes.length === 2) return new Promise<Response>(done => { resolve = done; issued(); });
            return answer({ ok: true, source: { ...source(writes.length + 1), audience } });
        });
        await controller.select('source-a');
        controller.edit({ name: 'First title' });
        await controller.updateSource({ audience });
        const save = controller.save();
        await ready;
        controller.edit({ name: 'Newer title' });
        resolve(answer({ ok: true, source: { ...source(3), name: 'First title', audience } }));
        await save;
        await controller.save();
        expect(writes[2]).toMatchObject({ expectedRevision: 3, patch: { name: 'Newer title' } });
        expect(writes[2].patch).not.toHaveProperty('audience');
    });

    it('retains a creation draft when a malformed catalog query is refused', async () => {
        const controller = harness(async () => answer({ ok: false, error: 'source_invalid' }, 400));
        controller.beginCreate({ name: 'Unsent source', repository });
        await controller.load('invalid query');
        expect(controller.getSnapshot().creationDraft?.name).toBe('Unsent source');
        expect(controller.getSnapshot().status).toBe('refused');
    });

    it('drops catalog and selected private metadata on an authenticated catalog refusal', async () => {
        let refused = false;
        const controller = harness(async (_path, init) => refused ? answer({ error: 'Forbidden' }, 403)
            : init?.method === 'GET' && _path.includes('/source-a?') ? answer({ ok: true, source: source() })
                : answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } }));
        await controller.load('');
        await controller.select('source-a');
        controller.edit({ name: 'Private draft' });
        refused = true;
        await controller.load('');
        expect(controller.getSnapshot()).toMatchObject({ rows: [], current: null, draft: null, canManage: false, status: 'refused', issue: 'action_forbidden' });
    });

    it('shows an acknowledged creation in the current unfiltered catalog', async () => {
        const controller = harness(async (_path, init) => init?.method === 'POST'
            ? answer({ ok: true, source: source() })
            : answer({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } }));
        await controller.load('');
        controller.beginCreate({ name: 'Repository', repository });
        await controller.save();
        expect(controller.getSnapshot().rows.map((row) => row.id)).toEqual(['source-a']);
        expect(controller.getSnapshot().selectedId).toBe('source-a');
    });

    it('does not revoke an acknowledged creation using a catalog read issued before that creation', async () => {
        let resolve!: (response: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>(done => { issued = done; });
        let reads = 0;
        const controller = harness(async (_path, init) => {
            if (init?.method === 'POST') return answer({ ok: true, source: source() });
            if (++reads === 1) return new Promise<Response>(done => { resolve = done; issued(); });
            return answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } });
        });
        const oldCatalog = controller.load('');
        await ready;
        controller.beginCreate({ name: 'Repository', repository });
        await controller.save();
        resolve(answer({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } }));
        await oldCatalog;
        expect(controller.getSnapshot().current?.id).toBe('source-a');
        expect(controller.getSnapshot().rows.map(row => row.id)).toEqual(['source-a']);
    });

    it('does not publish an older Source save failure onto a newly selected Source', async () => {
        let fail!: (reason: Error) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        const controller = harness(async (path, init) => {
            if (init?.method === 'PATCH') return new Promise<Response>((_done, reject) => { fail = reject; issued(); });
            return answer({ ok: true, source: { ...source(), id: path.includes('/source-b?') ? 'source-b' : 'source-a' } });
        });
        await controller.select('source-a');
        controller.edit({ name: 'Edited A' });
        const save = controller.save();
        await ready;
        await controller.select('source-b');
        fail(new Error('offline'));
        await save;
        expect(controller.getSnapshot()).toMatchObject({ selectedId: 'source-b', detailStatus: 'ready', issue: null });
        await controller.select('source-a');
        expect(controller.getSnapshot().draft?.name).toBe('Edited A');
    });

    it('resumes the same Home after effect replay without admitting a retired read', async () => {
        let resolve!: (value: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        let calls = 0;
        const controller = harness(async () => ++calls === 1
            ? new Promise<Response>((done) => { resolve = done; issued(); })
            : answer({ ok: true, sources: [source(2)], coverage: { complete: true, nextCursor: null } }));
        const retired = controller.load();
        await ready;
        controller.dispose();
        controller.resume();
        await controller.load();
        resolve(answer({ ok: true, sources: [source(1)], coverage: { complete: true, nextCursor: null } }));
        await retired;
        expect(controller.getSnapshot().rows[0].revision).toBe(2);
    });

    it('ends detail loading truthfully when the Source backend is unavailable', async () => {
        let offline = false;
        const controller = harness(async () => offline
            ? answer({ ok: false, error: 'source_backend_unavailable' }, 503)
            : answer({ ok: true, source: source() }));
        await controller.select('source-a');
        controller.edit({ name: 'Still local' });
        offline = true;
        await controller.select('source-a');
        expect(controller.getSnapshot()).toMatchObject({ detailStatus: 'offline', issue: 'source_backend_unavailable' });
        expect(controller.getSnapshot().draft?.name).toBe('Still local');
    });

    it('does not advertise old-filter coverage while loading a different audience', async () => {
        let resolve!: (value: Response) => void;
        let issued!: () => void;
        const ready = new Promise<void>((done) => { issued = done; });
        let calls = 0;
        const controller = harness(async () => ++calls === 1
            ? answer({ ok: true, sources: [source()], coverage: { complete: true, nextCursor: null } })
            : new Promise<Response>((done) => { resolve = done; issued(); }));
        await controller.load('');
        const pending = controller.load('', undefined, { kind: 'team', teamId: 'team-a' });
        await ready;
        expect(controller.getSnapshot().coverage.complete).toBe(false);
        resolve(answer({ ok: true, sources: [], coverage: { complete: true, nextCursor: null } }));
        await pending;
        expect(controller.getSnapshot().catalogAudience).toEqual({ kind: 'team', teamId: 'team-a' });
    });

    it('refreshes the demanded catalog and selected Source without discarding an unsaved draft', async () => {
        let revoked = false;
        const controller = harness(async (path) => path.includes('/source-a?')
            ? revoked ? answer({ ok: false, error: 'source_unavailable' }, 404) : answer({ ok: true, source: source() })
            : answer({ ok: true, sources: revoked ? [] : [source()], coverage: { complete: true, nextCursor: null } }));
        await controller.load('');
        await controller.select('source-a');
        controller.edit({ name: 'Local' });
        await controller.refresh();
        expect(controller.getSnapshot().draft?.name).toBe('Local');
        revoked = true;
        await controller.refresh();
        expect(controller.getSnapshot().rows).toEqual([]);
        expect(controller.getSnapshot().current).toBeNull();
        expect(controller.getSnapshot().draft).toBeNull();
    });

    it('drops revoked Source metadata on its Home wake but ignores another Home', async () => {
        let revoked = false;
        const controller = harness(async (path) => path.includes('/source-a?')
            ? revoked ? answer({ ok: false, error: 'source_unavailable' }, 404) : answer({ ok: true, source: source() })
            : answer({ ok: true, sources: revoked ? [] : [source()], coverage: { complete: true, nextCursor: null } }));
        await controller.load('');
        await controller.select('source-a');
        const release = observeProjectSources(controller);
        try {
            revoked = true;
            publishHomeAccountChange('home-b', [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            expect(controller.getSnapshot().current?.id).toBe('source-a');
            publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.waitFor(() => expect(controller.getSnapshot().current).toBeNull());
            expect(controller.getSnapshot().rows).toEqual([]);
        } finally { release(); controller.dispose(); }
    });

    it('keeps unchanged Source object identity while accepting refreshed management facts', async () => {
        let canManage = true;
        const controller = harness(async () => new Response(JSON.stringify({ ok: true, source: source(), canManage })));
        await controller.select('source-a');
        const current = controller.getSnapshot().current;
        canManage = false;
        await controller.select('source-a');
        expect(controller.getSnapshot().current).toBe(current);
        expect(controller.getSnapshot().canManage).toBe(false);
    });

    it('drops cached Source disclosure when the authenticated detail endpoint refuses the Account', async () => {
        let refused = false;
        const controller = harness(async () => refused
            ? new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
            : answer({ ok: true, source: source() }));
        await controller.select('source-a');
        controller.edit({ name: 'Private draft' });
        refused = true;
        await controller.select('source-a');
        expect(controller.getSnapshot()).toMatchObject({ current: null, draft: null, canManage: false, detailStatus: 'refused' });
    });
});
