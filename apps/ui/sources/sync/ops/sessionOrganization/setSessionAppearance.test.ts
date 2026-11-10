import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture } from '@/dev/testkit';
import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol';
import type { ServerScopedSessionSendMessageResult } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';

const http = vi.hoisted(() => ({ serverFetch: vi.fn(), runtimeFetchWithServerReachability: vi.fn() }));
const delivery = vi.hoisted(() => ({
    send: vi.fn<(request: unknown) => Promise<ServerScopedSessionSendMessageResult>>(async () => ({ ok: true })),
}));
// HTTP is the boundary; encryption, protocol parsing, operations and the real store run unchanged.
vi.mock('@/sync/http/client', () => ({ serverFetch: http.serverFetch }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({ runtimeFetchWithServerReachability: http.runtimeFetchWithServerReachability }));
// The persistent pending outbox is the delivery boundary; its persistence and de-duplication are owned by its tests.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
    sendSessionMessageWithServerScope: delivery.send,
}));

const credentials = { token: 'appearance-test', secret: Buffer.alloc(32, 7).toString('base64url') };
const context = { credentials, serverId: 'appearance-server', sessionId: 's1' };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('setSessionAppearance', () => {
    it.each(['plain', 'e2ee'] as const)('persists protected placement and identity through %s reload without changing legacy color', async mode => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const color = { kind: 'accent', key: 'green' } as const;
        const store = getStorage();
        store.setState({ sessionListViewDataByServerId: {
            [context.serverId]: ['s1', 'planner'].map(id => ({ type: 'session', serverId: context.serverId,
                session: buildSessionListRenderableFromSession(createSessionFixture({ id })) })),
        } });
        let savedDisplay: SessionOrganizationContentEnvelope | null = null;
        let savedPresentation: SessionOrganizationContentEnvelope | null = null;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode, updatedAt: 0 });
            if (path.endsWith('/appearance-presentations/s1') && init?.method === 'PUT') {
                savedPresentation = JSON.parse(String(init.body)).presentation;
                return json({ presentation: savedPresentation
                    ? { sessionId: 's1', presentation: savedPresentation, updatedAt: 4 }
                    : null });
            }
            if (path.endsWith('/appearance-presentations')) return json({ presentations: savedPresentation
                ? [{ sessionId: 's1', presentation: savedPresentation, updatedAt: 4 }]
                : [] });
            if (path.endsWith('/appearances/s1') && init?.method === 'PUT') {
                savedDisplay = JSON.parse(String(init.body)).display;
                return json({ appearance: savedDisplay ? { sessionId: 's1', display: savedDisplay, updatedAt: 3 } : null });
            }
            return json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
                tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: savedDisplay
                    ? [{ sessionId: 's1', display: savedDisplay, updatedAt: 3 }]
                    : [] } });
        });
        store.setState({ sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true } });
        await setSessionAppearance({ ...context, color });
        await setSessionAppearance({ ...context, placement: { kind: 'session', parentSessionId: 'planner' } });
        await setSessionAppearance({ ...context, identity: 'independent' });
        store.getState().clearSessionOrganizationForServer(context.serverId);
        await fetchAndApplySessionOrganizationSnapshot({
            credentials,
            serverId: context.serverId,
            request: { includeSessionAppearances: true },
            shouldContinue: () => true,
        });
        const display = () => store.getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display;
        const presentation = () => store.getState().sessionOrganizationAppearancePresentationsBySessionKey['appearance-server:s1']?.presentation;
        expect(display()).toEqual({ t: 'plain', v: { color } });
        expect(presentation()).toEqual({ t: 'plain', v: {
            v: 1,
            placement: { kind: 'session', parentSessionId: 'planner' },
            identity: 'independent',
        } });
        await expect(setSessionAppearance({ ...context, sessionId: 'planner', placement: { kind: 'session', parentSessionId: 's1' } })).rejects.toThrow('invalid-session-parent');
        await expect(setSessionAppearance({ ...context, placement: { kind: 'session', parentSessionId: 'missing' } })).rejects.toThrow('invalid-session-parent');
        await setSessionAppearance({ ...context, placement: null, identity: null });
        expect(display()).toEqual({ t: 'plain', v: { color } });
        expect(presentation()).toEqual({ t: 'plain', v: { v: 1 } });
    });

    it('persists a hydrated parent outside the list projection and moves the existing subtree intact', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { applySessionParentPlacementToSessionListViewData } = await import('@/sync/domains/session/listing/sessionParentPlacement');
        const { setSessionAppearance, setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const source = createSessionFixture({
            id: 'project-lead',
            serverId: context.serverId,
            permissionMode: 'yolo',
            metadata: { path: '/work/project-lead', host: 'host', sessionRoleV1: { v: 1, role: 'project_lead' } },
        });
        const child = createSessionFixture({
            id: 'reviewer',
            serverId: context.serverId,
            permissionMode: 'read-only',
            metadata: { path: '/work/reviewer', host: 'host', sessionRoleV1: { v: 1, role: 'reviewer' }, sessionOriginV1: {
                v: 1, kind: 'agent', creatorSessionId: source.id,
            } },
        });
        const grandchild = createSessionFixture({
            id: 'worker',
            serverId: context.serverId,
            permissionMode: 'acceptEdits',
            metadata: { path: '/work/worker', host: 'host', sessionRoleV1: { v: 1, role: 'worker' }, sessionOriginV1: {
                v: 1, kind: 'agent', creatorSessionId: child.id,
            } },
        });
        const target = createSessionFixture({
            id: 'product-lead',
            serverId: context.serverId,
            metadata: { path: '/work/product-lead', host: 'host' },
        });
        const foreignTarget = createSessionFixture({
            id: 'foreign-product-lead',
            serverId: 'foreign-server',
            metadata: { path: '/work/foreign-product-lead', host: 'host' },
        });
        const renderRow = (session: typeof source) => ({
            type: 'session' as const,
            serverId: session.serverId,
            session: buildSessionListRenderableFromSession(session),
        });
        const sourceRow = { ...renderRow(source), hasChildren: true };
        const childRow = renderRow(child);
        const grandchildRow = renderRow(grandchild);
        const store = getStorage();
        store.setState({
            sessions: Object.fromEntries([source, child, grandchild, target, foreignTarget].map(session => [session.id, session])),
            sessionListViewDataByServerId: {
                [context.serverId]: [sourceRow, childRow, grandchildRow],
                'foreign-server': [renderRow(foreignTarget)],
            },
            sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true },
        });
        let savedPresentation: SessionOrganizationContentEnvelope | null = null;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            if (path.endsWith('/appearance-presentations/project-lead') && init?.method === 'PUT') {
                savedPresentation = JSON.parse(String(init.body)).presentation;
                return json({ presentation: savedPresentation
                    ? { sessionId: source.id, presentation: savedPresentation, updatedAt: 4 }
                    : null });
            }
            if (path.endsWith('/appearance-presentations')) return json({ presentations: savedPresentation
                ? [{ sessionId: source.id, presentation: savedPresentation, updatedAt: 4 }]
                : [] });
            return json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
                tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: [] } });
        });

        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: source.id,
            placement: { kind: 'session', parentSessionId: child.id }, localId: 'placement-cycle' }))
            .resolves.toMatchObject({ ok: false, stage: 'placement' });
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: source.id,
            placement: { kind: 'session', parentSessionId: foreignTarget.id }, localId: 'placement-foreign' }))
            .resolves.toMatchObject({ ok: false, stage: 'placement' });
        expect(delivery.send).not.toHaveBeenCalled();
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: source.id,
            placement: { kind: 'session', parentSessionId: target.id }, localId: 'placement-product-lead' }))
            .resolves.toEqual({ ok: true, placement: 'session', instructionLocalId: 'placement-product-lead' });
        expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: source.id,
            serverId: context.serverId,
            localId: 'placement-product-lead',
            requestedAction: { v: 1, kind: 'enqueue' },
            message: expect.stringContaining(`reporting parent for this session's work`),
        }));
        expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(target.id) }));

        store.getState().clearSessionOrganizationForServer(context.serverId);
        await fetchAndApplySessionOrganizationSnapshot({
            credentials,
            serverId: context.serverId,
            request: { includeSessionAppearances: true },
            shouldContinue: () => true,
        });
        const projected = applySessionParentPlacementToSessionListViewData(
            [sourceRow, childRow, grandchildRow, renderRow(target)],
            store.getState().sessionOrganizationAppearancesBySessionKey,
            {},
            {},
            store.getState().sessionOrganizationAppearancePresentationsBySessionKey,
        ).filter(item => item.type === 'session');

        expect(projected.map(row => ({
            id: row.session.id,
            parent: row.parentSessionId ?? null,
        }))).toEqual([
            { id: target.id, parent: null },
            { id: source.id, parent: target.id },
            { id: child.id, parent: source.id },
            { id: grandchild.id, parent: child.id },
        ]);
        expect(projected[1]?.hasChildren).toBe(true);
        expect(projected[1]?.session).toBe(sourceRow.session);
        expect(projected[2]?.session).toBe(childRow.session);
        expect(projected[3]?.session).toBe(grandchildRow.session);
        expect(store.getState().sessions[source.id]).toBe(source);
        expect(store.getState().sessions[child.id]).toBe(child);
        expect(store.getState().sessions[grandchild.id]).toBe(grandchild);
    });

    it('persists before delivery, reuses one local id on retry, and re-nests only the moved root', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
        const store = getStorage();
        const child = createSessionFixture({ id: 'child', serverId: context.serverId });
        const firstParent = createSessionFixture({ id: 'first-parent', serverId: context.serverId });
        const nextParent = createSessionFixture({ id: 'next-parent', serverId: context.serverId });
        const descendant = createSessionFixture({ id: 'descendant', serverId: context.serverId, metadata: {
            path: '/repo/descendant', host: 'host', sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: child.id },
        } });
        const rows = [child, firstParent, nextParent, descendant].map(session => ({
            type: 'session' as const,
            serverId: context.serverId,
            session: buildSessionListRenderableFromSession(session),
        }));
        store.setState({
            sessions: Object.fromEntries([child, firstParent, nextParent, descendant].map(session => [session.id, session])),
            sessionListViewDataByServerId: { [context.serverId]: rows },
            sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true },
        });
        let savedPresentation: SessionOrganizationContentEnvelope | null = null;
        let writes = 0;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            if (path.endsWith('/appearance-presentations/child') && init?.method === 'PUT') {
                writes += 1;
                savedPresentation = JSON.parse(String(init.body)).presentation;
                return json({ presentation: { sessionId: child.id, presentation: savedPresentation, updatedAt: writes } });
            }
            throw new Error(`unexpected request: ${path}`);
        });
        delivery.send.mockImplementationOnce(async () => {
            expect(store.getState().sessionOrganizationAppearancePresentationsBySessionKey[`${context.serverId}:${child.id}`]?.presentation)
                .toEqual({ t: 'plain', v: { v: 1, placement: { kind: 'session', parentSessionId: firstParent.id } } });
            return { ok: false as const, errorCode: 'session_not_found', error: 'session_not_found' };
        });
        const first = await setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'session', parentSessionId: firstParent.id }, localId: 'placement-attempt-1' });
        expect(first).toMatchObject({ ok: false, stage: 'delivery', placement: 'session',
            instruction: { localId: 'placement-attempt-1', message: expect.stringContaining(firstParent.id) } });
        if (first.ok || first.stage !== 'delivery') throw new Error('Expected retryable delivery failure');
        const presentationKey = `${context.serverId}:${child.id}`;
        const appliedPresentation = store.getState().sessionOrganizationAppearancePresentationsBySessionKey[presentationKey]!;
        store.setState({
            sessionOrganizationAppearancePresentationsBySessionKey: {
                ...store.getState().sessionOrganizationAppearancePresentationsBySessionKey,
                [presentationKey]: { ...appliedPresentation, updatedAt: appliedPresentation.updatedAt + 1 },
            },
        });
        expect(store.getState().sessionOrganizationAppearancePresentationsBySessionKey[presentationKey])
            .not.toBe(appliedPresentation);
        delivery.send.mockResolvedValueOnce({ ok: true });
        await expect(first.retry()).resolves.toEqual({ ok: true, placement: 'session', instructionLocalId: 'placement-attempt-1' });
        expect(writes).toBe(1);
        expect(delivery.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
            sessionId: child.id, serverId: context.serverId, localId: 'placement-attempt-1',
            message: first.instruction.message,
        }));

        delivery.send.mockClear();
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'session', parentSessionId: firstParent.id }, localId: 'same-parent-no-op' }))
            .resolves.toEqual({ ok: true, placement: 'session', instructionLocalId: null });
        expect(writes).toBe(1);
        expect(delivery.send).not.toHaveBeenCalled();

        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'session', parentSessionId: nextParent.id }, localId: 'placement-attempt-2' }))
            .resolves.toEqual({ ok: true, placement: 'session', instructionLocalId: 'placement-attempt-2' });
        expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: child.id, serverId: context.serverId, localId: 'placement-attempt-2',
            message: expect.stringContaining(nextParent.id),
        }));
        expect((delivery.send.mock.calls[0]?.[0] as { message?: string } | undefined)?.message).not.toContain(firstParent.id);
        expect(rows.find(row => row.session.id === descendant.id)?.session.metadata?.sessionOriginV1)
            .toEqual({ v: 1, kind: 'agent', creatorSessionId: child.id });

        delivery.send.mockClear();
        await expect(first.retry()).resolves.toMatchObject({
            ok: false,
            stage: 'not_current',
            placement: 'session',
        });
        expect(delivery.send).not.toHaveBeenCalled();

        delivery.send.mockRejectedValueOnce(new Error('connection outcome unknown'));
        const uncertain = await setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'session', parentSessionId: firstParent.id }, localId: 'placement-attempt-3' });
        expect(uncertain).toEqual({
            ok: false,
            stage: 'delivery_uncertain',
            placement: 'session',
            error: 'connection outcome unknown',
            instruction: { localId: 'placement-attempt-3', message: expect.stringContaining(firstParent.id) },
        });
        expect(delivery.send).toHaveBeenCalledOnce();
    });

    it('refuses initial reporting when a newer parent is published before the save continuation', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
        const store = getStorage();
        const sessions = ['child', 'saved-parent', 'newer-parent'].map(id => createSessionFixture({ id, serverId: context.serverId }));
        const key = `${context.serverId}:child`;
        store.setState({
            sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
            sessionListViewDataByServerId: { [context.serverId]: sessions.map(session => ({
                type: 'session' as const, serverId: context.serverId, session: buildSessionListRenderableFromSession(session),
            })) },
            sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true },
        });
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            return json({ presentation: { sessionId: 'child', presentation: JSON.parse(String(init?.body)).presentation, updatedAt: 1 } });
        });
        const newerPresentation = { sessionId: 'child', updatedAt: 2, presentation: {
            t: 'plain' as const, v: { v: 1, placement: { kind: 'session', parentSessionId: 'newer-parent' } },
        } };
        let published = false;
        const unsubscribe = store.subscribe(state => {
            if (published || !state.sessionOrganizationAppearancePresentationsBySessionKey[key]) return;
            published = true;
            queueMicrotask(() => store.getState().applySessionAppearancePresentation(context.serverId, 'child', newerPresentation));
        });
        try {
            const result = await setSessionParentPlacementWithDelivery({ ...context, sessionId: 'child',
                placement: { kind: 'session', parentSessionId: 'saved-parent' }, localId: 'initial-parent-race' });
            expect(published).toBe(true);
            expect(store.getState().sessionOrganizationAppearancePresentationsBySessionKey[key]).toEqual(newerPresentation);
            expect(result).toMatchObject({ ok: false, stage: 'not_current', error: 'placement_superseded' });
            expect(delivery.send).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });

    it.each(['null', 'missing-placement', 'different-parent', 'different-session'] as const)(
        'never queues requested-parent guidance from a %s save response', async responseKind => {
            const { getStorage } = await import('@/sync/domains/state/storageStore');
            const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
            const { setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
            const sessions = [context.sessionId, 'requested-parent', 'other-parent'].map(id => createSessionFixture({ id, serverId: context.serverId }));
            getStorage().setState({
                sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
                sessionListViewDataByServerId: { [context.serverId]: sessions.map(session => ({
                    type: 'session' as const, serverId: context.serverId, session: buildSessionListRenderableFromSession(session),
                })) },
                sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true },
            });
            http.serverFetch.mockImplementation(async (path: string) => {
                if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
                return json({ presentation: responseKind === 'null' ? null : {
                    sessionId: responseKind === 'different-session' ? 'unrelated-session' : context.sessionId,
                    presentation: { t: 'plain', v: { v: 1, ...(responseKind === 'missing-placement' ? {} : {
                        placement: { kind: 'session', parentSessionId: responseKind === 'different-parent' ? 'other-parent' : 'requested-parent' },
                    }) } },
                    updatedAt: 1,
                } });
            });
            await expect(setSessionParentPlacementWithDelivery({ ...context,
                placement: { kind: 'session', parentSessionId: 'requested-parent' }, localId: 'unconfirmed-parent' }))
                .resolves.toMatchObject({ ok: false, stage: 'placement', error: 'session_placement_not_confirmed' });
            expect(delivery.send).not.toHaveBeenCalled();
        },
    );

    it('queues standalone guidance only for a real former parent and never sends after a failed write', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { setSessionAppearance, setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
        const store = getStorage();
        const child = createSessionFixture({ id: 'child', serverId: context.serverId });
        const parent = createSessionFixture({ id: 'parent', serverId: context.serverId });
        const topLevel = createSessionFixture({ id: 'top-level', serverId: context.serverId });
        const unlistedParentChild = createSessionFixture({ id: 'unlisted-parent-child', serverId: context.serverId });
        store.setState({
            sessions: { [child.id]: child, [parent.id]: parent, [topLevel.id]: topLevel, [unlistedParentChild.id]: unlistedParentChild },
            sessionListViewDataByServerId: { [context.serverId]: [child, parent, topLevel, unlistedParentChild].map(session => ({
                type: 'session' as const, serverId: context.serverId, session: buildSessionListRenderableFromSession(session),
            })) },
            sessionOrganizationAppearancePresentationsSupportedByServerId: { [context.serverId]: true },
            sessionOrganizationAppearancePresentationsBySessionKey: {
                [`${context.serverId}:${child.id}`]: { sessionId: child.id, updatedAt: 1, presentation: { t: 'plain', v: {
                    v: 1, placement: { kind: 'session', parentSessionId: parent.id },
                } } },
                [`${context.serverId}:${unlistedParentChild.id}`]: { sessionId: unlistedParentChild.id, updatedAt: 1, presentation: { t: 'plain', v: {
                    v: 1, placement: { kind: 'session', parentSessionId: 'temporarily-unlisted-parent' },
                } } },
            },
        });
        let failNext = false;
        let appearanceWrites = 0;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            if (failNext) return json({ error: 'write_failed' }, 500);
            appearanceWrites += 1;
            const presentation = JSON.parse(String(init?.body)).presentation;
            const sessionId = path.split('/').at(-1)!;
            return json({ presentation: { sessionId, presentation, updatedAt: 2 } });
        });
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'topLevel' }, localId: 'standalone-child' }))
            .resolves.toEqual({ ok: true, placement: 'topLevel', instructionLocalId: 'standalone-child' });
        expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: child.id, serverId: context.serverId, localId: 'standalone-child',
            message: expect.stringContaining(parent.id),
        }));
        expect((delivery.send.mock.calls[0]?.[0] as { message?: string } | undefined)?.message).toContain('Stop treating');

        delivery.send.mockClear();
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: topLevel.id,
            placement: { kind: 'topLevel' }, localId: 'standalone-no-parent' }))
            .resolves.toEqual({ ok: true, placement: 'topLevel', instructionLocalId: null });
        expect(appearanceWrites).toBe(1);
        expect(delivery.send).not.toHaveBeenCalled();

        delivery.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        const staleStandalone = await setSessionParentPlacementWithDelivery({ ...context, sessionId: unlistedParentChild.id,
            placement: { kind: 'topLevel' }, localId: 'standalone-unlisted-parent' });
        expect(staleStandalone).toMatchObject({ ok: false, stage: 'delivery', placement: 'topLevel',
            instruction: { localId: 'standalone-unlisted-parent', message: expect.stringContaining('temporarily-unlisted-parent') } });
        expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: unlistedParentChild.id,
            localId: 'standalone-unlisted-parent',
            message: expect.stringContaining('temporarily-unlisted-parent'),
        }));

        if (staleStandalone.ok || staleStandalone.stage !== 'delivery') throw new Error('Expected retryable standalone delivery failure');
        delivery.send.mockResolvedValueOnce({ ok: true });
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: unlistedParentChild.id,
            placement: { kind: 'session', parentSessionId: parent.id }, localId: 'renest-after-standalone' }))
            .resolves.toEqual({ ok: true, placement: 'session', instructionLocalId: 'renest-after-standalone' });
        delivery.send.mockClear();
        await expect(staleStandalone.retry()).resolves.toMatchObject({ ok: false, stage: 'not_current', placement: 'topLevel' });
        expect(delivery.send).not.toHaveBeenCalled();

        delivery.send.mockClear();
        failNext = true;
        await expect(setSessionParentPlacementWithDelivery({ ...context, sessionId: child.id,
            placement: { kind: 'session', parentSessionId: parent.id }, localId: 'failed-write' }))
            .resolves.toMatchObject({ ok: false, stage: 'placement' });
        expect(delivery.send).not.toHaveBeenCalled();

        await setSessionAppearance({ ...context, sessionId: child.id, color: { kind: 'accent', key: 'green' } }).catch(() => undefined);
        expect(delivery.send).not.toHaveBeenCalled();
    });

    it('marks the protected presentation carrier unsupported on an older server and fails placement visibly', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { setSessionAppearance, setSessionParentPlacementWithDelivery } = await import('./setSessionAppearance');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        http.serverFetch.mockImplementation(async (path: string) => {
            if (path.endsWith('/appearance-presentations')) return json({ error: 'Not found' }, 404);
            return json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
                tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: [] } });
        });
        await fetchAndApplySessionOrganizationSnapshot({
            credentials,
            serverId: context.serverId,
            request: { includeSessionAppearances: true },
            shouldContinue: () => true,
        });
        expect(getStorage().getState().sessionOrganizationAppearancePresentationsSupportedByServerId[context.serverId]).toBe(false);
        await expect(setSessionAppearance({ ...context, placement: { kind: 'topLevel' } }))
            .rejects.toThrow('session-appearance-presentation-unsupported');
        const child = createSessionFixture({ id: context.sessionId, serverId: context.serverId });
        const parent = createSessionFixture({ id: 'unsupported-parent', serverId: context.serverId });
        getStorage().setState({
            sessions: { [child.id]: child, [parent.id]: parent },
            sessionListViewDataByServerId: { [context.serverId]: [child, parent].map(session => ({
                type: 'session' as const, serverId: context.serverId, session: buildSessionListRenderableFromSession(session),
            })) },
        });
        await expect(setSessionParentPlacementWithDelivery({ ...context,
            placement: { kind: 'session', parentSessionId: parent.id }, localId: 'unsupported' }))
            .resolves.toMatchObject({ ok: false, stage: 'placement', error: 'session-appearance-presentation-unsupported' });
        expect(delivery.send).not.toHaveBeenCalled();
    });
    it('changes and clears only color while preserving presentation and unknown display fields', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const retained = { placement: { kind: 'topLevel' }, identity: 'independent', futureField: { enabled: true } };
        getStorage().setState({ sessionOrganizationAppearancesBySessionKey: {
            'appearance-server:s1': { sessionId: 's1', display: { t: 'plain', v: retained }, updatedAt: 1 },
        } });
        const sent: unknown[] = [];
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            const { display } = JSON.parse(String(init?.body));
            sent.push(display);
            return json({ appearance: display ? { sessionId: 's1', display, updatedAt: 2 } : null });
        });
        const color = { kind: 'accent', key: 'green' } as const;
        await setSessionAppearance({ ...context, color });
        await setSessionAppearance({ ...context, color: null });
        expect(sent).toEqual([{ t: 'plain', v: { ...retained, color } }, { t: 'plain', v: retained }]);
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display)
            .toEqual({ t: 'plain', v: retained });
    });

    it('opens a snapshot containing only encrypted appearance displays and records server support', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        http.serverFetch.mockResolvedValueOnce(json({ mode: 'e2ee', updatedAt: 0 }));
        const color = { kind: 'custom', hex: '#123456' };
        const display = await prepareSessionOrganizationDisplayEnvelope({ credentials, value: { color } });
        http.serverFetch.mockResolvedValueOnce(json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: [{ sessionId: 's1', display, updatedAt: 9 }] } }));
        http.serverFetch.mockResolvedValueOnce(json({ presentations: [] }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: context.serverId, request: { includeSessionAppearances: true }, shouldContinue: () => true });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display).toEqual({ t: 'plain', v: { color } });
        expect(getStorage().getState().sessionOrganizationSessionAppearancesSupportedByServerId[context.serverId]).toBe(true);
    });
    beforeEach(async () => {
        http.serverFetch.mockReset();
        http.runtimeFetchWithServerReachability.mockReset();
        delivery.send.mockReset();
        delivery.send.mockResolvedValue({ ok: true });
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        invalidateAccountEncryptionModeCache();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer(context.serverId);
    });

    it('seals according to the destination server account mode when editing a row from another server', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const serverUrl = 'https://appearance-server.example';
        http.serverFetch.mockImplementation(async (path: string) => json({ mode: path.startsWith(serverUrl) ? 'plain' : 'e2ee', updatedAt: 0 }));
        let sentDisplay: unknown;
        http.runtimeFetchWithServerReachability.mockImplementation(async ({ init }) => {
            const { display } = JSON.parse(String(init.body));
            sentDisplay = display;
            return json({ appearance: { sessionId: 's1', display, updatedAt: 10 } });
        });
        const color = { kind: 'accent', key: 'green' } as const;
        await setSessionAppearance({ ...context, serverUrl, color });
        expect(sentDisplay).toEqual({ t: 'plain', v: { color } });
    });

    it.each(['plain', 'e2ee'] as const)('optimistically applies, seals, reconciles and clears an override for %s accounts', async (mode) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { openSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        let sentDisplay: SessionOrganizationContentEnvelope | null = null;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode, updatedAt: 0 });
            expect(path).toBe('/v2/session-organization/appearances/s1');
            const body = JSON.parse(String(init?.body));
            sentDisplay = body.display;
            return json({ appearance: body.display ? { sessionId: 's1', display: body.display, updatedAt: 99 } : null });
        });
        const color = { kind: 'custom', hex: '#AABBCC' } as const;
        const pending = setSessionAppearance({ ...context, color: { kind: 'custom', hex: '#abc' } });
        const optimisticDisplay = getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display;
        await pending;
        expect(optimisticDisplay).toEqual({ t: 'plain', v: { color } });
        expect(sentDisplay).toMatchObject({ t: mode === 'e2ee' ? 'encrypted' : 'plain' });
        await expect(openSessionOrganizationDisplayEnvelope({ credentials, envelope: sentDisplay })).resolves.toEqual({ t: 'plain', v: { color } });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']).toMatchObject({ updatedAt: 99, display: { t: 'plain', v: { color } } });
        await setSessionAppearance({ ...context, color: null });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']).toBeUndefined();
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('surfaces a write rejection and restores the previous override without touching a later confirmed write', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const firstResponse = createDeferred<Response>();
        const firstRequest = createDeferred<void>();
        let requests = 0;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            requests += 1;
            if (requests === 1) { firstRequest.resolve(); return firstResponse.promise; }
            const { display } = JSON.parse(String(init?.body));
            return json({ appearance: { sessionId: 's1', display, updatedAt: 101 } });
        });
        const first = setSessionAppearance({ ...context, color: { kind: 'accent', key: 'blue' } });
        const rejected = expect(first).rejects.toThrow('session-appearance-limit-exceeded');
        await firstRequest.promise;
        await setSessionAppearance({ ...context, color: { kind: 'accent', key: 'green' } });
        firstResponse.resolve(json({ error: 'session-appearance-limit-exceeded' }, 409));
        await rejected;
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display).toEqual({ t: 'plain', v: { color: { kind: 'accent', key: 'green' } } });
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });
});
