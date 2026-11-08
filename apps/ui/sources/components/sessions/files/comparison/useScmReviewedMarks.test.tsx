import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { applyScmReviewedKeysIntent, buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderHook, act, createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { useScmReviewedMarks } = await import('./useScmReviewedMarks');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await connection?.dispose(); connection = undefined; });

describe('mounted reviewed marks Account identity', () => {
    it.each(['hostless', 'offline', 'disabled', 'keyed'] as const)('keeps pushed Account marks readable while %s, refuses writes, and fences retired callbacks', async state => {
        const source = { repositoryRootPath: '/repo', source: { kind: 'workingTree' as const }, changeKeys: ['change-a', 'change-b'] };
        const scopeId = buildScmReviewScopeId(source);
        const key = buildScmReviewedMarksKey(scopeId);
        let record = applyScmReviewedKeysIntent(scopeId, null, [], true);
        let version = 1;
        let currentnessReads = 0;
        let kvReads = 0;
        let kvWrites = 0;
        let connectedSocket: Socket | undefined;
        let releaseFirstRead!: () => void;
        const firstReadReleased = new Promise<void>(resolve => { releaseFirstRead = resolve; });
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://reviewed-marks-observation.example.test', accountId: 'reviewed-marks-account',
            configureSocket: socket => { configureConnectedServerSocketBoundary(socket); connectedSocket = socket; },
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption/currentness') {
                    currentnessReads++;
                    return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'reviewed-marks-account' });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: state === 'disabled' ? {
                    actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                        'scm.diffSummary.reviewed.mark': { disabledSurfaces: ['ui'] },
                        'scm.diffSummary.reviewed.unmark': { disabledSurfaces: ['ui'] },
                    } }),
                } : {} }, version: 1 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                    sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                });
                if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/friends') return Response.json({ friends: [] });
                if (path === '/v2/session-organization') return Response.json({ error: 'Not found' }, { status: 404 });
                if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
                if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
                if (path === '/v1/kv' && init?.method === 'POST') {
                    const mutation = JSON.parse(String(init.body)).mutations[0];
                    expect(mutation.key).toBe(key);
                    expect(mutation.version).toBe(version);
                    const envelope = JSON.parse(new TextDecoder().decode(Buffer.from(mutation.value, 'base64')));
                    expect(envelope.t).toBe('plain');
                    record = envelope.v;
                    kvWrites++;
                    return Response.json({ success: true, results: [{ key, version: ++version }] });
                }
                if (path === '/v1/kv/bulk') {
                    if (kvReads === 0) await firstReadReleased;
                    kvReads++;
                    return Response.json({ values: [{ key, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: record }), version }] });
                }
                if (path === '/v1/kv') return Response.json({ items: [] });
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
                return null;
            },
        });
        await expect.poll(() => storage.getState().isDataReady).toBe(true);
        await expect.poll(() => apiSocket.getAccountEncryptionObservationBinding(connection!.credentials)?.peek()?.mode).toBe('plain');
        const credentials = connection.credentials;
        const warmReads = currentnessReads;
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useScmReviewedMarks({ comparison: null, source, serverId: connection!.serverId,
            host: state === 'hostless' || state === 'keyed' ? null : { machineId: 'review-machine' },
            observation: state === 'keyed' ? 'keyed' : undefined,
            writeUnavailableReason: state === 'offline' ? 'Machine offline. Retry when connected.' : null });
        }, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            // Until the first read settles the marks are pending, never "unavailable": consumers reserve the fact's room.
            expect(hook.getCurrent().pending).toBe(true);
            releaseFirstRead();
            await expect.poll(() => hook.getCurrent().record).toEqual(record);
            expect(hook.getCurrent().pending).toBe(false);
            counter.reset();
            for (const changeKeys of [['change-a'], ['change-a', 'change-b']]) {
                record = applyScmReviewedKeysIntent(scopeId, null, changeKeys, true);
                version++;
                const update = UpdateContainerSchema.parse({ id: `marks-${version}`, seq: version, createdAt: version,
                    body: { t: 'kv-batch-update', changes: [{ key, value: null, version }] } });
                expect(connectedSocket!.listenersAny().length).toBeGreaterThan(0);
                await act(async () => { for (const listener of connectedSocket!.listenersAny()) listener('update', update); });
                await expect.poll(() => hook.getCurrent().record).toEqual(record);
            }
            const readOnlyCurrentness = currentnessReads - warmReads;
            if (state === 'keyed') expect(counter.read()).toEqual({ renders: 0, commits: 0 });
            expect(kvReads).toBe(3);
            expect(hook.getCurrent().unavailableReason).toBe(state === 'disabled' ? null
                : state === 'offline' ? 'Machine offline. Retry when connected.' : 'reviewed_marks_unavailable');
            const beforeWrite = currentnessReads;
            await act(async () => { hook.getCurrent().setReviewedKeys(['change-b'], false); hook.getCurrent().clear(); });
            if (state === 'disabled') await expect.poll(() => hook.getCurrent().unavailableReason).toBe('action_disabled');
            else expect(hook.getCurrent().record?.reviewedChangeKeys).toEqual(['change-a', 'change-b']);
            const writeCurrentness = currentnessReads - beforeWrite;
            expect(kvWrites).toBe(0);
            const retained = hook.getCurrent();
            await connection.dispose();
            await hook.rerender();
            expect(hook.getCurrent().record).toBeNull();
            expect(hook.getCurrent().unavailableReason).toBe('reviewed_marks_unavailable');
            const retiredCounts = { currentnessReads, kvReads, kvWrites };
            await act(async () => { retained.clear(); retained.setReviewedKeys(['change-b'], true); });
            expect({ currentnessReads, kvReads, kvWrites }).toEqual(retiredCounts);
            expect(readOnlyCurrentness).toBe(0);
            expect(writeCurrentness).toBe(0);
        } finally { await hook.unmount(); }
    });
});
