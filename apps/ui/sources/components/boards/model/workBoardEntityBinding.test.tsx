import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, buildWorkBoardArtifactHeaderV1,
    buildWorkBoardItemKeyV1, createWorkBoardV1, encodePlainArtifactStoredContent, normalizeActionsSettingsV1,
    type WorkBoardV1, type WorkBoardIntentV1 } from '@happier-dev/protocol';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkBoardEntityBinding } from './workBoardEntityBinding';
import { useAcknowledgedWorkBoard, useDispatchWorkBoardIntent, useWorkBoard, useWorkBoardSaveQueue, useWorkBoardSaveState } from './useWorkBoards';
import { projectBoardMembership } from './boardMembership';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

// HTTP, device credential storage and native theme are system boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const previousState = storage.getState();
const previousAppliedSnapshot = getAppliedActiveServerSnapshot();
const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
afterEach(async () => { await standardCleanup(); retirePresentationNotice(); storage.setState(previousState); runtimeFetch.mockReset(); vi.restoreAllMocks();
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function mountAccount(name: string, boards: readonly WorkBoardV1[], enabled = true) {
    const home = await upsertAndActivateServer({ serverUrl: `https://board-${name}.test` });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'board-account' })), 'base64url')}.signature`;
    const credentials = { token };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    storage.setState({ profileScope: { serverId: home.id, accountId: 'board-account' }, settingsScope: { serverId: home.id, accountId: 'board-account' }, isDataReady: true,
        settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { enabled } } }) } });
    const rows = new Map<string, Artifact>(boards.map(board => [board.id, { id: board.id, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]));
    let offline = false;
    let releaseWrite: (() => void) | null = null;
    let writeGate = Promise.resolve();
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return json({});
        if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1' } } });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/artifacts' && init?.method !== 'POST') return json([...rows.values()]);
        const id = path.split('/')[3];
        const row = rows.get(id!);
        if (path.endsWith('/recipients') && row) return json({ artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access,
            encryptionMode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] });
        if (init?.method === 'POST' || init?.method === 'DELETE') {
            await writeGate;
            if (offline) throw new Error('Connection lost after dispatch');
            if (path === '/v1/artifacts') {
                const request = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                rows.set(request.id, { ...request, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', headerVersion: 1,
                    bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                return json(rows.get(request.id));
            }
            if (!row) return json({ error: 'not_found' }, 404);
            if (init.method === 'DELETE') { rows.delete(row.id); return new Response(null, { status: 204 }); }
            const request = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (request.expectedHeaderVersion !== row.headerVersion || request.expectedBodyVersion !== row.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            const next = { ...row, header: request.header!, body: request.body!, headerVersion: row.headerVersion + 1, bodyVersion: (row.bodyVersion ?? 0) + 1 };
            rows.set(row.id, next);
            return json({ success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion });
        }
        return row ? json(row) : json({ error: 'not_found' }, 404);
    });
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return { home, rows, wrapper, offline(value: boolean) { offline = value; }, hold() {
        writeGate = new Promise<void>(resolve => { releaseWrite = resolve; }); return () => releaseWrite?.();
    } };
}

describe('mounted WorkBoard Action settlement', () => {
    it.each([true, false])('keeps truthful acknowledged size and reports pending approval without a failed save (approval: %s)', async approval => {
        const board = createWorkBoardV1({ id: 'board-size-pending', name: 'Size' });
        const b = await mountAccount('size-pending', [board]);
        const ref = { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard' as const, boardId: board.id } }, instanceId: 'copy' };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'inline' as const, definition: {
            v: 1 as const, id: 'checks', name: 'Checks', provenance: { source: { kind: 'authored' as const } },
            sizeDeclaration: { sizes: ['medium', 'wide'] as ('medium' | 'wide')[], defaultSize: 'medium' as const },
            inputs: { fields: [] }, inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Checks' } } },
        } }, bindings: {} };
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard(board.id), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_add', boardId: board.id, ref, instance })).toMatchObject({ status: 'applied' }); });
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'widgets.instance.size.set': { approvalRequiredSurfaces: approval ? ['ui'] : [] } } }) } });
        const before = b.rows.get(board.id);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_size', boardId: board.id, ref, size: 'wide' }))
            .toMatchObject({ status: approval ? 'pending' : 'applied' }); });
        if (approval) expect(b.rows.get(board.id)).toBe(before);
        else expect(b.rows.get(board.id)).not.toBe(before);
        expect(hook.getCurrent().board?.widgets?.[0]?.size).toBe(approval ? 'medium' : 'wide');
        expect(hook.getCurrent().save).toMatchObject({ pending: [], failure: null });
        if (approval) expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
    });
    it('admits mounted size edits through the universal widget Action rather than bypassing its disabled policy', async () => {
        const board = createWorkBoardV1({ id: 'board-size', name: 'Size' });
        const b = await mountAccount('size-policy', [board]);
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'boards.apply': { enabled: true }, 'widgets.instance.size.set': { enabled: false } } }) } });
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        const before = b.rows.get(board.id);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_size', boardId: board.id,
            ref: { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } }, instanceId: 'copy' },
            size: 'wide' })).toMatchObject({ status: 'refused', code: 'action_disabled' }); });
        expect(b.rows.get(board.id)).toBe(before);
        expect(hook.getCurrent().save.failure?.intent.kind).toBe('widget_size');
    });
    it('creates through the shared ingress and refuses an invalid widget configuration before persistence', async () => {
        const b = await mountAccount('create-widget', []);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), board: useWorkBoard('new-board'), save: useWorkBoardSaveState() }), { wrapper: b.wrapper });
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'create', board: { id: 'new-board', name: 'Created' } })).toMatchObject({ status: 'applied' }); });
        expect(hook.getCurrent().board?.name).toBe('Created');
        const before = b.rows.get('new-board');
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'widget_add', boardId: 'new-board',
            ref: { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: 'new-board' } }, instanceId: 'invalid' },
            instance: { v: 1, id: 'invalid', definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { kind: 'value', value: 'invalid-session-address' } } },
        })).toMatchObject({ status: 'refused', code: 'widget_inputs_invalid' }); });
        expect(b.rows.get('new-board')).toBe(before);
        expect(hook.getCurrent().board?.widgets ?? []).toEqual([]);
        expect(hook.getCurrent().save.failure).toMatchObject({ reason: 'invalidValue', intent: { kind: 'widget_add' } });
    });

    it('refuses create, settings, delete, widget and drop at the same disabled UI Action ingress', async () => {
        const board = createWorkBoardV1({ id: 'board-a', name: 'Original' });
        const b = await mountAccount('disabled', [board], false);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), save: useWorkBoardSaveState(), binding: useWorkBoardEntityBinding({ board,
            membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }) }), { wrapper: b.wrapper });
        const before = b.rows.get(board.id);
        const widgetRef = { surface: { serverId: b.home.id, accountId: 'board-account', owner: { kind: 'workBoard', boardId: board.id } }, instanceId: 'copy' } as const;
        for (const intent of [
            { kind: 'create', board: { id: 'new-board', name: 'New' } },
            { kind: 'update', boardId: board.id, patch: { name: 'Changed' } },
            { kind: 'delete', boardId: board.id },
            { kind: 'widget_add', boardId: board.id, ref: widgetRef, instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } },
        ] satisfies WorkBoardIntentV1[]) {
            let outcome;
            await act(async () => { outcome = await hook.getCurrent().dispatch(intent); });
            expect.soft(outcome).toMatchObject({ status: 'refused', code: 'action_disabled' });
            expect.soft(hook.getCurrent().save.failure?.intent).toEqual(intent);
        }
        let drop;
        await act(async () => { drop = await hook.getCurrent().binding!.execute({ actionId: 'boards.apply', input: { intent: { kind: 'add_items', boardId: board.id,
            refs: [{ kind: 'machine', qualifiedId: { serverId: b.home.id, id: 'm' } }] } }, preview: { verb: 'Add', target: 'Board' } }); });
        expect(drop).toMatchObject({ status: 'refused', reason: { code: 'action_disabled' } });
        expect(b.rows.size).toBe(1);
        expect(b.rows.get(board.id)).toBe(before);
        expect(hook.getCurrent().save.pending).toEqual([]);
        expect(hook.getCurrent().save.failure).not.toBeNull();
    });

    it('rechecks Action policy on save-failure retry and preserves acknowledged state', async () => {
        const board = createWorkBoardV1({ id: 'board-a', name: 'Original' });
        const b = await mountAccount('retry', [board]);
        const hook = await renderHook(() => ({ dispatch: useDispatchWorkBoardIntent(), queue: useWorkBoardSaveQueue(), board: useWorkBoard(board.id) }), { wrapper: b.wrapper });
        b.offline(true);
        await act(async () => { expect(await hook.getCurrent().dispatch({ kind: 'update', boardId: board.id, patch: { name: 'Retried' } })).toMatchObject({ status: 'unknown' }); });
        b.offline(false);
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'boards.apply': { enabled: false } } }) } }); });
        await act(async () => { expect(await hook.getCurrent().queue.retry()).toMatchObject({ status: 'refused', code: 'action_disabled' }); });
        expect(hook.getCurrent().board?.name).toBe('Original');
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1 }) } }); });
        await act(async () => { expect(await hook.getCurrent().queue.retry()).toMatchObject({ status: 'applied' }); });
        expect(hook.getCurrent().board?.name).toBe('Retried');
    });

    it('commits only the exact Board consumers for pending edits, acknowledgements and deletion', async () => {
        const b = await mountAccount('exact', [createWorkBoardV1({ id: 'a', name: 'A' }), createWorkBoardV1({ id: 'b', name: 'B' })]);
        const commits = { a: 0, b: 0, acknowledgedB: 0 };
        const a = await renderHook(() => { const board = useWorkBoard('a'); React.useLayoutEffect(() => { commits.a++; }); return board; }, { wrapper: b.wrapper });
        const other = await renderHook(() => { const board = useWorkBoard('b'); React.useLayoutEffect(() => { commits.b++; }); return board; }, { wrapper: b.wrapper });
        const acknowledged = await renderHook(() => { const board = useAcknowledgedWorkBoard('b'); React.useLayoutEffect(() => { commits.acknowledgedB++; }); return board; }, { wrapper: b.wrapper });
        const dispatch = await renderHook(useDispatchWorkBoardIntent, { wrapper: b.wrapper });
        expect(a.getCurrent()?.name).toBe('A'); expect(other.getCurrent()?.name).toBe('B');
        const before = { ...commits };
        const release = b.hold();
        let saving!: ReturnType<ReturnType<typeof useDispatchWorkBoardIntent>>;
        await act(async () => { saving = dispatch.getCurrent()({ kind: 'update', boardId: 'a', patch: { name: 'Pending A' } }); });
        expect(a.getCurrent()?.name).toBe('Pending A');
        expect.soft(commits.b).toBe(before.b); expect.soft(commits.acknowledgedB).toBe(before.acknowledgedB);
        release(); await act(async () => { expect(await saving).toMatchObject({ status: 'applied' }); });
        await act(async () => { expect(await dispatch.getCurrent()({ kind: 'delete', boardId: 'a' })).toMatchObject({ status: 'applied' }); });
        expect(a.getCurrent()).toBeNull();
        expect.soft(commits.b).toBe(before.b); expect.soft(commits.acknowledgedB).toBe(before.acknowledgedB);
        await act(async () => { expect(await dispatch.getCurrent()({ kind: 'update', boardId: 'b', patch: { name: 'Changed B' } })).toMatchObject({ status: 'applied' }); });
        expect(other.getCurrent()?.name).toBe('Changed B'); expect(acknowledged.getCurrent()?.name).toBe('Changed B');
        expect(commits.b).toBeGreaterThan(before.b); expect(commits.acknowledgedB).toBeGreaterThan(before.acknowledgedB);
    });
    it.each(['unknown', 'refused'] as const)('preserves %s through the real queue and Action executor', async disposition => {
        const home = await upsertAndActivateServer({ serverUrl: `https://board-settlement-${disposition}.test` });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'board-account' })), 'base64url')}.signature`;
        const credentials = { token };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        storage.setState({ profileScope: { serverId: home.id, accountId: 'board-account' }, settingsScope: { serverId: home.id, accountId: 'board-account' }, isDataReady: true });
        const ref = { kind: 'machine', qualifiedId: { serverId: home.id, id: 'machine-a' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Board' }), source: { picked: [ref] }, positionsByItemRef: { [key]: { x: 24, y: 24 } } };
        const row = { id: board.id, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)), body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1' } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return json([row]);
            if (path === `/v1/artifacts/${board.id}` && init?.method === 'POST') {
                if (disposition === 'unknown') throw new Error('Connection lost after dispatch');
                return json({ error: 'not_found' }, 404);
            }
            if (path === `/v1/artifacts/${board.id}`) return disposition === 'refused' ? json({ error: 'not_found' }, 404) : json(row);
            throw new Error(`Unexpected route ${path}`);
        });
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
        const hook = await renderHook(() => ({ binding: useWorkBoardEntityBinding({ board, membership: projectBoardMembership(board, {
            isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }), save: useWorkBoardSaveState() }), { wrapper });
        const binding = hook.getCurrent().binding;
        expect(binding?.isCurrent()).toBe(true);
        if (!binding) throw new Error('Expected mounted Board binding');
        let outcome;
        await act(async () => { outcome = await binding.execute({ actionId: 'boards.apply', input: { intent: { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [key]: { x: 48, y: 24 } } } }, preview: { verb: 'Move', target: 'Board' } }); });
        expect(outcome).toMatchObject({ status: disposition });
        expect(hook.getCurrent().save.failure).not.toBeNull();
    });
});
