import { describe, expect, it } from 'vitest';
import { createSessionBoardActionAdapter as createAdapter } from './sessionBoardActions';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: scope.serverId, sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = {
    v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } },
} as const;
const installed = { ...item, source: { kind: 'widget', instance: {
    v: 1, id: 'status', definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'status' } }, bindings: {},
} } } as const;

function createSessionBoardActionAdapter(options: Omit<Parameters<typeof createAdapter>[0], 'repository'>) {
    return createAdapter({ ...options, repository: createSessionSystemRecordRepository(options) });
}

describe('Session Board Action adapter', () => {
    it('stores current widget references and rejects the retired installed-surface shape', async () => {
        let writes = 0;
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes += 1;
                return new Response(JSON.stringify({ operation: 'upsert_item', itemId: 'status', outcome: 'created', itemRevision: revision, layoutRevision: revision }));
            },
        });
        const input = { sessionId: session.sessionId, itemId: 'status', expectedItemRevision: null, item: installed, placement: { tabId: 'overview', tabTitle: 'Overview' } };
        await expect(execute({ actionId: 'session.board.item.upsert', context: {}, input })).resolves.toMatchObject({ result: { outcome: 'created' } });
        await expect(execute({ actionId: 'session.board.item.upsert', context: {}, input: { ...input,
            item: { ...item, source: { kind: 'installedSurface', surface: { pluginId: 'acme.widgets', localId: 'status' } } },
        } })).resolves.toMatchObject({ errorCode: 'session_board_invalid' });
        expect(writes).toBe(1);
    });
    it('updates an existing installed item without replacing its source identity', async () => {
        const writes: unknown[] = [];
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                if (init?.method === 'PUT') {
                    writes.push(JSON.parse(String(init.body)));
                    return new Response(JSON.stringify({ operation: 'upsert_item', itemId: 'status', outcome: 'updated', itemRevision: revision }));
                }
                return new Response(JSON.stringify({ record: { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'status' },
                    content: { t: 'plain', v: installed }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
            },
        });
        await expect(execute({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: session.sessionId,
            itemId: 'status', expectedItemRevision: revision, item: { ...installed, title: 'Renamed' } } })).resolves.toMatchObject({ result: { outcome: 'updated' } });
        expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: { ...installed, title: 'Renamed' } } })]);
        await expect(execute({ actionId: 'session.board.item.upsert', context: {}, input: { sessionId: session.sessionId,
            itemId: 'status', expectedItemRevision: revision, item: { ...installed, source: { ...installed.source, instance: {
                ...installed.source.instance, definition: { ...installed.source.instance.definition, surface: { ...installed.source.instance.definition.surface, localId: 'other' } },
            } } } } })).resolves.toMatchObject({ errorCode: 'session_board_source_conflict' });
        expect(writes).toHaveLength(1);
    });
    it('acknowledges the requested second view when an item already placed elsewhere gains another placement', async () => {
        const layout = { v: 1, tabs: [
            { id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] },
            { id: 'second', title: 'Second', items: [] },
        ] };
        let committedLayout: unknown;
        const request = async (path: string, init?: RequestInit) => {
            if (init?.method === 'PUT') {
                committedLayout = JSON.parse(String(init.body)).placement.layoutContent.v;
                return new Response(JSON.stringify({ operation: 'upsert_item', itemId: 'note', outcome: 'updated', itemRevision: revision, layoutRevision: revision }));
            }
            const query = new URL(path, 'https://example.invalid').searchParams;
            const address = { owner: query.get('owner'), namespace: query.get('namespace'), kind: query.get('kind'), localId: query.get('localId') };
            return new Response(JSON.stringify({ record: {
                id: address.kind === 'layout.v1' ? 'layout-row' : 'item-row', address,
                content: { t: 'plain', v: address.kind === 'layout.v1' ? layout : item }, revision,
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
            } }));
        };
        const adapter = createSessionBoardActionAdapter({ scope, session, request, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true } });
        // The real executor's strict result correspondence is the deciding consumer.
        const executor = createActionExecutor({ sessionBoardAction: adapter, isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
        const input = { sessionId: session.sessionId, itemId: 'note', expectedItemRevision: revision, item,
            placement: { tabId: 'second', width: 'wide' as const } };
        const result = await executor.execute('session.board.item.upsert', input, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, defaultSessionId: session.sessionId,
        });
        expect(committedLayout).toMatchObject({ tabs: [
            { id: 'overview', items: [{ itemId: 'note', width: 'medium' }] },
            { id: 'second', items: [{ itemId: 'note', width: 'wide' }] },
        ] });
        expect(result).toMatchObject({ ok: true, result: { destination: { tabId: 'second', width: 'wide' } } });
    });
    it('invalidates the canonical record projection after a committed mutation', async () => {
        const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
        const request = async (_path: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT'
            ? { operation: 'update_layout', outcome: 'updated', layoutRevision: revision } : { record: { id: 'layout-row',
                address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' }, content: { t: 'plain', v: layout }, revision,
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
        const repository = createSessionSystemRecordRepository({ scope, request });
        const execute = createAdapter({ scope, session, repository, request, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true } });
        await execute({ actionId: 'session.board.layout.update', context: {}, input: { sessionId: session.sessionId,
            expectedLayoutRevision: revision, operation: { op: 'tab.rename', tabId: 'overview', title: 'Renamed' } } });
        expect(repository.getSnapshot(session, { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } }).freshness).toBe('stale');
    });
    it('keeps a valid acknowledgement for another operation outcome-unknown', async () => {
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => new Response(JSON.stringify(init?.method === 'PUT'
                ? { operation: 'remove_item', itemId: 'other', outcome: 'removed', layoutRevision: revision } : { record: null })),
        });
        const input = { sessionId: session.sessionId, expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } };
        await expect(execute({ actionId: 'session.board.layout.update', input, context: {} })).resolves.toMatchObject({
            ok: false, errorCode: 'outcome_unknown', details: { recovery: { requestBody: expect.any(String), intent: input } },
        });
    });
    it('settles empty, malformed, and schema-invalid 2xx acknowledgements as outcome-unknown', async () => {
        const input = {
            sessionId: session.sessionId,
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const acknowledgements = [
            new Response(null, { status: 204 }),
            new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
            new Response(JSON.stringify({ operation: 'update_layout', outcome: 'updated' }), { status: 200 }),
        ];
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => init?.method === 'PUT'
                ? acknowledgements.shift()!
                : new Response(JSON.stringify({ record: null })),
        });

        for (let index = 0; index < 3; index += 1) {
            await expect(execute({ actionId: 'session.board.layout.update', input, context: {} })).resolves.toMatchObject({
                ok: false,
                errorCode: 'outcome_unknown',
                error: 'outcome_unknown',
                details: { recovery: { requestBody: expect.any(String), intent: input } },
            });
        }
    });
    it('preserves typed conflict details and does not call a definite malformed response outcome-unknown', async () => {
        let response: Response = new Response(JSON.stringify({
            error: 'session_board_revision_conflict',
            currentLayoutRevision: revision,
        }), { status: 409 });
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => init?.method === 'PUT'
                ? response
                : new Response(JSON.stringify({ record: null })),
        });
        const args = {
            actionId: 'session.board.layout.update' as const,
            input: {
                sessionId: session.sessionId,
                expectedLayoutRevision: null,
                operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
            },
            context: {},
        };

        await expect(execute(args)).resolves.toEqual({
            ok: false,
            errorCode: 'session_board_revision_conflict',
            error: 'session_board_revision_conflict',
            details: {
                currentLayoutRevision: revision,
            },
        });

        response = new Response(JSON.stringify({ definitely: 'not-a-board-error' }), { status: 409 });
        await expect(execute(args)).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_response',
            error: 'invalid_response',
        });

        response = new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        await expect(execute(args)).resolves.toEqual({
            ok: false,
            errorCode: 'feature_disabled',
            error: 'feature_disabled',
            details: { operation: 'session.board.layout.update' },
        });
    });
    it('preserves the current revision when the local Board read detects a conflict', async () => {
        let writes = 0;
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                if (init?.method === 'PUT') writes += 1;
                return new Response(JSON.stringify({ record: {
                    id: 'layout-row',
                    address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                    content: { t: 'plain', v: { v: 1, tabs: [] } },
                    revision,
                    createdAt: '2026-09-05T00:00:00.000Z',
                    updatedAt: '2026-09-05T00:00:00.000Z',
                } }));
            },
        });

        await expect(execute({
            actionId: 'session.board.layout.update',
            input: {
                sessionId: session.sessionId,
                expectedLayoutRevision: null,
                operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
            },
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'session_board_revision_conflict',
            error: 'session_board_revision_conflict',
            details: { currentLayoutRevision: revision },
        });
        expect(writes).toBe(0);
    });
    it('returns cancelled before dispatch when its signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        let requests = 0;
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                if (init?.method === 'PUT') requests += 1;
                return new Response(JSON.stringify({ record: null }));
            },
        });

        await expect(execute({
            actionId: 'session.board.layout.update',
            input: {
                sessionId: session.sessionId,
                expectedLayoutRevision: null,
                operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
            },
            context: {},
            signal: controller.signal,
        })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
        expect(requests).toBe(0);
    });
    it('invalidates a fresh projection after an issued mutation loses its acknowledgement', async () => {
        const query = { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } } as const;
        const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
        let repository: ReturnType<typeof createSessionSystemRecordRepository>;
        let writes = 0;
        const request = async (_path: string, init?: RequestInit, requestOptions?: Readonly<{ onIssued?: () => void }>): Promise<Response> => {
            if (init?.method === 'PUT') {
                writes += 1;
                requestOptions?.onIssued?.();
                throw new TypeError('acknowledgement lost');
            }
            return new Response(JSON.stringify({ record: { id: 'layout-row', address: query.address, content: { t: 'plain', v: layout }, revision,
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
        };
        repository = createSessionSystemRecordRepository({ scope, request });
        // Keep the projection observed: the repository deliberately retires
        // zero-observer entries, while this case verifies that an ambiguous
        // issued mutation invalidates the mounted Board without replaying it.
        const freshnessChanges: string[] = [];
        const stop = repository.subscribe(session, query, () => {
            freshnessChanges.push(repository.getSnapshot(session, query).freshness);
        });
        await repository.refresh(session, query);
        freshnessChanges.length = 0;
        const execute = createAdapter({ scope, session, repository, request, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true } });
        await expect(execute({ actionId: 'session.board.layout.update', context: {}, input: { sessionId: session.sessionId,
            expectedLayoutRevision: revision, operation: { op: 'tab.rename', tabId: 'overview', title: 'Renamed' } } })).resolves.toMatchObject({ errorCode: 'outcome_unknown' });
        await repository.refresh(session, query);
        expect(writes).toBe(1);
        expect(freshnessChanges).toContain('stale');
        expect(repository.getSnapshot(session, query).freshness).toBe('fresh');
        stop();
    });
    it('keeps exact sealed recovery evidence through the real Action executor without replaying an ambiguous mutation', async () => {
        const writes: string[] = [];
        const adapter = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init, requestOptions) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes.push(String(init.body));
                requestOptions?.onIssued?.();
                throw new TypeError('acknowledgement lost');
            },
        });
        const executor = createActionExecutor({
            sessionBoardAction: adapter,
            isActionApprovalRequired: () => false,
        } as unknown as ActionExecutorDeps);
        const input = {
            sessionId: session.sessionId,
            itemId: 'note',
            expectedItemRevision: null,
            item,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
        } as const;

        const result = await executor.execute('session.board.item.upsert', input, {
            surface: 'ui',
            authority: 'present_user',
            serverId: scope.serverId,
            defaultSessionId: session.sessionId,
        });
        expect(writes).toHaveLength(1);
        expect(result).toEqual({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'outcome_unknown',
            details: {
                recovery: {
                    v: 1,
                    actionId: 'session.board.item.upsert',
                    serverId: scope.serverId,
                    sessionId: session.sessionId,
                    requestBody: writes[0],
                    mutationRequest: JSON.parse(writes[0]!),
                    intent: input,
                },
            },
        });
    });
    it('retains exact recovery before dispatch so scope retirement cannot erase an issued mutation', async () => {
        const prepared: unknown[] = [];
        const input = {
            sessionId: session.sessionId,
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            onMutationPrepared: (details) => prepared.push(details),
            request: async (_path, init) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                expect(prepared).toHaveLength(1);
                return new Response(JSON.stringify({ operation: 'update_layout', outcome: 'created', layoutRevision: revision }));
            },
        });

        await expect(execute({ actionId: 'session.board.layout.update', input, context: {} })).resolves.toMatchObject({
            result: { operation: 'update_layout', outcome: 'created' },
        });
        expect(prepared).toEqual([{
            recovery: {
                v: 1,
                actionId: 'session.board.layout.update',
                serverId: scope.serverId,
                sessionId: session.sessionId,
                requestBody: expect.any(String),
                mutationRequest: expect.objectContaining({
                    operation: 'update_layout',
                    expectedLayoutRevision: null,
                }),
                intent: input,
            },
        }]);
        const recovery = prepared[0] as { recovery: { requestBody: string } };
        expect(JSON.parse(recovery.recovery.requestBody)).toMatchObject({
            operation: 'update_layout',
            expectedLayoutRevision: null,
        });
    });
    it('does not retarget captured Session encryption or capabilities to another Session', async () => {
        let requests = 0;
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async () => { requests += 1; return new Response(JSON.stringify({ record: null })); },
        });
        await expect(execute({ actionId: 'session.board.get', input: { sessionId: 'different-session' }, context: {} })).resolves.toMatchObject({ errorCode: 'session_board_forbidden' });
        expect(requests).toBe(0);
    });
    it('rejects an exact-Home mismatch before any record read or mutation dispatch', async () => {
        let requests = 0;
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async () => {
                requests += 1;
                return new Response(JSON.stringify({ record: null }));
            },
        });

        await expect(execute({
            actionId: 'session.board.layout.update',
            input: {
                sessionId: session.sessionId,
                expectedLayoutRevision: null,
                operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
            },
            context: { serverId: 'home-b' },
        })).resolves.toEqual({ ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' });
        expect(requests).toBe(0);
    });
    it('projects pre-dispatch record transport failures through the strict Board failure vocabulary', async () => {
        let requests = 0;
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                requests += 1;
                if (init?.method !== 'PUT') throw new Error('network unavailable');
                throw new Error('mutation must not be reached');
            },
        });

        await expect(execute({
            actionId: 'session.board.item.upsert',
            input: {
                sessionId: session.sessionId,
                itemId: 'status',
                expectedItemRevision: null,
                item: installed,
                placement: { tabId: 'overview', tabTitle: 'Overview' },
            },
            context: {},
        })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
        expect(requests).toBe(1);
    });
    it('projects a record-owner feature refusal with the exact Board operation', async () => {
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async () => new Response(JSON.stringify({
                error: 'Session System Records are disabled',
                code: 'plugin_session_record_feature_disabled',
            }), { status: 404 }),
        });

        await expect(execute({
            actionId: 'session.board.get',
            input: { sessionId: session.sessionId },
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'feature_disabled',
            error: 'feature_disabled',
            details: { operation: 'session.board.get' },
        });
    });
    it('does not replay an issued E2EE mutation whose acknowledgement is lost', async () => {
        const encryption = new SessionEncryption('session-one', new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
        const writes: string[] = [];
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'e2ee', encryption }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init, requestOptions) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes.push(String(init.body));
                requestOptions?.onIssued?.();
                throw Object.assign(new TypeError('connection lost'), { code: 'ECONNRESET' });
            },
        });
        await expect(execute({ actionId: 'session.board.item.upsert', input: { sessionId: 'session-one', itemId: 'note', item, expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' } }, context: {} })).resolves.toMatchObject({ errorCode: 'outcome_unknown' });
        expect(writes).toHaveLength(1);
        const body = JSON.parse(writes[0]);
        expect(body.itemContent.t).toBe('encrypted');
        expect(await encryption.decryptRaw(body.itemContent.c)).toEqual(item);
        expect(await encryption.decryptRaw(body.placement.layoutContent.c)).toMatchObject({ tabs: [{ id: 'overview' }] });
    });
    it('keeps a proven pre-dispatch network failure definite and does not retry it', async () => {
        let writes = 0;
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes += 1;
                throw Object.assign(new TypeError('DNS lookup failed'), { code: 'ENOTFOUND' });
            },
        });
        await expect(execute({ actionId: 'session.board.layout.update', input: { sessionId: 'session-one', expectedLayoutRevision: null,
            operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } }, context: {} })).resolves.toEqual({ ok: false, errorCode: 'offline', error: 'offline' });
        expect(writes).toBe(1);
    });
    it('preserves exact request and intent on ambiguous failure and does not replay a CAS conflict', async () => {
        let writes = 0;
        let conflict = false;
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (_path, init, requestOptions) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes += 1;
                requestOptions?.onIssued?.();
                if (!conflict) throw new TypeError('connection lost');
                return new Response(JSON.stringify({ error: 'session_board_revision_conflict', currentLayoutRevision: revision }), { status: 409 });
            },
        });
        const args = { actionId: 'session.board.layout.update' as const, input: { sessionId: 'session-one', expectedLayoutRevision: null,
            operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } }, context: {} };
        await expect(execute(args)).resolves.toMatchObject({
            ok: false,
            errorCode: 'outcome_unknown',
            details: { recovery: { requestBody: expect.any(String), intent: args.input } },
        });
        expect(writes).toBe(1);
        conflict = true;
        await expect(execute(args)).resolves.toMatchObject({
            ok: false,
            errorCode: 'session_board_revision_conflict',
            details: { currentLayoutRevision: revision },
        });
        expect(writes).toBe(2);
    });
    it('reads an inventory page without fabricating full bodies or pagination completeness', async () => {
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: false },
            request: async (path) => new Response(JSON.stringify(path.includes('/record?') ? { record: null } : {
                records: [{ id: 'row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' }, content: { t: 'plain', v: item }, revision,
                    createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }], nextCursor: 'page-two', hasNext: true,
            })),
        });
        expect(await execute({ actionId: 'session.board.get', input: { sessionId: 'session-one' }, context: {} })).toMatchObject({
            layout: null, items: [{ itemId: 'note', title: 'Note', sourceKind: 'declarative', revision }], incomplete: true, page: { cursor: 'page-two', hasNext: true },
        });
    });
    it.each([
        ['forbidden', 403, 'plugin_session_record_forbidden'],
        ['feature_disabled', 404, 'plugin_session_record_feature_disabled'],
        ['offline', 0, ''],
    ] as const)('preserves %s from an explicit item read after layout success', async (errorCode, status, code) => {
        const execute = createSessionBoardActionAdapter({
            scope, session, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            // Only HTTP is replaced; record transport, repository and failure projection remain real.
            request: async (path) => {
                const query = new URL(path, 'https://home-a').searchParams;
                if (query.get('kind') === 'layout.v1') return new Response(JSON.stringify({ record: null }));
                if (status === 0) throw new TypeError('Network request failed');
                return new Response(JSON.stringify({ error: 'Plugin Session system record operation failed', code }), { status });
            },
        });

        await expect(execute({ actionId: 'session.board.get', context: {},
            input: { sessionId: session.sessionId, itemIds: ['note'] },
        })).resolves.toEqual({
            ok: false, errorCode, error: errorCode,
            ...(errorCode === 'feature_disabled' ? { details: { operation: 'session.board.get' } } : {}),
        });
    });
    it('preserves readable explicit items while marking missing and corrupt items incomplete', async () => {
        const encryption = new SessionEncryption(session.sessionId, new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache());
        const readableContent = await encryption.encryptRaw(item);
        const malformedContent = await encryption.encryptRaw({ v: 1 });
        const execute = createSessionBoardActionAdapter({
            scope, session, contentContext: { mode: 'e2ee', encryption },
            capabilities: { readTranscript: true, editSessionRecords: false },
            request: async (path) => {
                const query = new URL(path, 'https://home-a').searchParams;
                const localId = query.get('localId');
                if (query.get('kind') === 'layout.v1' || localId === 'missing') return new Response(JSON.stringify({ record: null }));
                return new Response(JSON.stringify({ record: {
                    id: `row-${localId}`, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId }, revision,
                    content: { t: 'encrypted', c: localId === 'note' ? readableContent : localId === 'malformed' ? malformedContent : 'AAAA' },
                    createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
                } }));
            },
        });

        await expect(execute({ actionId: 'session.board.get', context: {},
            input: { sessionId: session.sessionId, itemIds: ['note', 'missing', 'corrupt', 'malformed'] },
        })).resolves.toEqual({
            v: 1, serverId: scope.serverId, sessionId: session.sessionId,
            capabilities: { readTranscript: true, editSessionRecords: false }, layout: null,
            items: [{ itemId: 'note', revision, title: item.title, sourceKind: 'declarative', item }],
            incomplete: true, page: { cursor: null, hasNext: false },
        });
    });
    it.each(['session.board.layout.update', 'session.board.item.remove'] as const)('uses the exact complete layout for %s', async (actionId) => {
        const layout = { v: 1, tabs: ['a', 'b'].map((id) => ({ id, title: id, items: [{ itemId: 'note', width: 'medium' }] })) };
        const writes: unknown[] = [];
        const execute = createSessionBoardActionAdapter({ scope, session, contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (path, init) => {
                if (init?.method === 'PUT') {
                    writes.push(JSON.parse(String(init.body)));
                    return new Response(JSON.stringify(actionId === 'session.board.item.remove'
                        ? { operation: 'remove_item', itemId: 'note', outcome: 'removed', layoutRevision: revision }
                        : { operation: 'update_layout', outcome: 'updated', layoutRevision: revision }));
                }
                expect(path).toContain('/record?');
                return new Response(JSON.stringify({ record: { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                    revision, content: { t: 'plain', v: layout }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
            },
        });
        await execute({ actionId, context: {}, input: actionId === 'session.board.item.remove'
            ? { sessionId: 'session-one', itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision }
            : { sessionId: 'session-one', expectedLayoutRevision: revision, operation: { op: 'item.resize', itemId: 'note', tabId: 'a', width: 'wide' } } });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ expectedLayoutRevision: revision, layoutContent: { t: 'plain', v: { tabs: actionId === 'session.board.item.remove'
            ? [{ id: 'a', items: [] }, { id: 'b', items: [] }]
            : [{ id: 'a', items: [{ itemId: 'note', width: 'wide' }] }, { id: 'b', items: [{ itemId: 'note', width: 'medium' }] }],
        } } });
    });
    it('carries the exact current item participant for item.place and refuses a missing item before dispatch', async () => {
        const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
        const writes: unknown[] = [];
        let itemExists = true;
        const execute = createSessionBoardActionAdapter({
            scope,
            session,
            contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (path, init) => {
                if (init?.method === 'PUT') {
                    writes.push(JSON.parse(String(init.body)));
                    return new Response(JSON.stringify({ operation: 'update_layout', outcome: 'updated', layoutRevision: revision }));
                }
                const isItem = path.includes('kind=item.v1');
                return new Response(JSON.stringify({ record: isItem
                    ? itemExists ? { id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' },
                        content: { t: 'plain', v: item }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } : null
                    : { id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                        content: { t: 'plain', v: layout }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } }));
            },
        });
        const input = { sessionId: session.sessionId, expectedLayoutRevision: revision,
            operation: { op: 'item.place' as const, itemId: 'note', tabId: 'overview', width: 'wide' as const } };
        await expect(execute({ actionId: 'session.board.layout.update', input, context: {} })).resolves.toMatchObject({
            v: 1,
            serverId: scope.serverId,
            sessionId: session.sessionId,
            result: { operation: 'update_layout' },
        });
        expect(writes).toEqual([expect.objectContaining({
            operation: 'update_layout',
            itemPlacementParticipant: { itemId: 'note', expectedItemRevision: revision },
        })]);

        itemExists = false;
        writes.length = 0;
        await expect(execute({ actionId: 'session.board.layout.update', input, context: {} })).resolves.toEqual({
            ok: false, errorCode: 'session_board_item_not_found', error: 'session_board_item_not_found',
        });
        expect(writes).toHaveLength(0);
    });
    it('creates an item and its first placement in one captured Home request', async () => {
        const writes: Array<{ path: string; body: string }> = [];
        const execute = createSessionBoardActionAdapter({
            scope, session: { ...session, sessionId: 'session/one' }, contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true },
            request: async (path, init) => {
                if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
                writes.push({ path, body: String(init.body) });
                return new Response(JSON.stringify({ operation: 'upsert_item', itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision }));
            },
        });
        const result = await execute({ actionId: 'session.board.item.upsert', context: { defaultSessionId: 'session/one' }, input: {
            itemId: 'note', item, expectedItemRevision: null, placement: { tabId: 'overview', tabTitle: 'Overview' },
        } });
        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe('/v2/sessions/session%2Fone/board');
        expect(JSON.parse(writes[0].body)).toEqual({
            operation: 'upsert_item', itemId: 'note', expectedItemRevision: null,
            itemContent: { t: 'plain', v: item }, placement: {
                expectedLayoutRevision: null, layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'medium' }] }] } },
            },
        });
        expect(result).toMatchObject({ serverId: 'home-a', sessionId: 'session/one', result: { outcome: 'created' } });
    });
});
