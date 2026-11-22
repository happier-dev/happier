import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './syncEngine';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import type { Socket } from 'socket.io-client';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storageStore';
import { createWorkflowAutomationDetailFixture, createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; });

describe('First-use Automation catalog and retained managed targets', () => {
    it.each(['missing', 'disabled', 'complete-known'] as const)('does no migration work for %s first-read admission', async admission => {
        let selections = 0;
        let definitionReads = 0;
        let listReads = 0;
        const automations = createWorkflowAutomationHttpBoundary();
        const known = createWorkflowAutomationDetailFixture({ id: 'known-catalog-row', revision: 1 });
        automations.rows.set(known.id, { ...known, managedTarget: null });
        const home = await restoreServerAccountForTest({
            serverUrl: `https://automation-backfill-${admission}.example.test`, accountId: `backfill-${admission}`,
            configureSocket: configureConnectedServerSocketBoundary,
            request: async (input, init) => {
                const url = new URL(String(input));
                const path = url.pathname;
                if (path.startsWith('/v1/features')) {
                    const response = createRootLayoutFeaturesResponse({ features: { workflows: { enabled: admission === 'complete-known' } } });
                    if (admission !== 'missing') return Response.json(response);
                    const { workflows: _omitted, ...features } = response.features;
                    return Response.json({ ...response, features });
                }
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: `backfill-${admission}` });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v3/automations/query') selections++;
                else if (path === '/v3/automations') listReads++;
                else if (path.startsWith('/v3/automations/')) definitionReads++;
                const reply = await automations.handle(url, init);
                return reply ?? createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        const { sync } = await import('@/sync/sync');
        // Settle the real reader, not an empty default store or a guessed delay.
        await sync.ensureAutomationsRead();
        await sync.resumeSync('manual');
        expect(selections).toBe(0);
        expect(definitionReads).toBe(0);
        expect(automations.patches).toHaveLength(0);
        if (admission !== 'complete-known') expect(listReads).toBe(0);
        else expect(listReads).toBeGreaterThan(0);
    });

    it('leaves the Automation catalog unread without a consumer and shares its first read', async () => {
        const catalogRequests: string[] = [];
        const automations = createWorkflowAutomationHttpBoundary();
        const definition = createWorkflowAutomationDetailFixture({ id: 'presented-automation', revision: 1 });
        automations.rows.set(definition.id, { ...definition, managedTarget: null });
        const home = await restoreServerAccountForTest({
            serverUrl: 'https://automation-read-once.example.test', accountId: 'read-once',
            configureSocket: configureConnectedServerSocketBoundary,
            request: async (input, init) => {
                const url = new URL(String(input));
                const path = url.pathname;
                if (path.startsWith('/v1/features')) {
                    return Response.json(createRootLayoutFeaturesResponse());
                }
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'read-once' });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v3/automations' || path === '/v3/automations/query') {
                    catalogRequests.push(`${init?.method ?? 'GET'} ${path}`);
                }
                const reply = await automations.handle(url, init);
                return reply ?? createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        const { sync } = await import('@/sync/sync');
        // Drive the authenticated shell's startup and recovery with no mounted
        // Automation catalog consumer, as on a cold Services or Overview page.
        await sync.resumeSync('manual');
        expect(catalogRequests).toEqual([]);

        const { useAutomations } = await import('@/sync/store/hooks');
        // The picker and an explicit widget read can overlap on first use.
        const [picker] = await Promise.all([
            renderHook(() => useAutomations({ read: true })),
            sync.ensureAutomationsRead(),
            sync.ensureAutomationsRead(),
        ]);
        try {
            await vi.waitFor(() => expect(picker.getCurrent().map(row => row.id)).toEqual([definition.id]));
            expect(catalogRequests).toEqual(['GET /v3/automations']);
            expect(storage.getState().automations[definition.id]?.id).toBe(definition.id);
            await sync.ensureAutomationsRead();
            expect(catalogRequests).toEqual(['GET /v3/automations']);
        } finally {
            await picker.unmount();
        }
    });

    it('uses the exact selector when an all-known first page hides an unknown later row', async () => {
        const automations = createWorkflowAutomationHttpBoundary();
        for (let index = 0; index < 100; index++) {
            const row = createWorkflowAutomationDetailFixture({ id: `known-${index}`, revision: 1 });
            automations.rows.set(row.id, { ...row, managedTarget: null });
        }
        const unknown = createWorkflowAutomationDetailFixture({ id: 'unknown-after-page-one', revision: 1,
            workflowDefinitionId: formatWorkflowDefinitionRefV1({ kind: 'artifact', artifactId: '00000000-0000-4000-8000-000000000032' }) });
        automations.rows.set(unknown.id, unknown);
        const selected: unknown[] = [];
        const detailIds: string[] = [];
        let ordinaryPages = 0;
        const home = await restoreServerAccountForTest({
            serverUrl: 'https://automation-backfill-incomplete.example.test', accountId: 'backfill-incomplete',
            configureSocket: configureConnectedServerSocketBoundary,
            request: async (input, init) => {
                const url = new URL(String(input));
                const path = url.pathname;
                if (path.startsWith('/v1/features')) return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'backfill-incomplete' });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v3/automations/query') {
                    selected.push(JSON.parse(String(init?.body)));
                }
                else if (path === '/v3/automations') {
                    ordinaryPages++;
                    expect(url.searchParams.has('cursor')).toBe(false);
                } else if (path.startsWith('/v3/automations/') && (init?.method ?? 'GET') === 'GET') detailIds.push(path.split('/').at(-1)!);
                const reply = await automations.handle(url, init);
                return reply ?? createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        expect(ordinaryPages).toBe(0);
        expect(selected).toHaveLength(0);
        await sync.ensureAutomationsRead();
        await vi.waitFor(() => expect(automations.patches).toHaveLength(1));
        expect(selected.filter(query => typeof query === 'object' && query !== null && 'managedTargetUnindexed' in query))
            .toEqual([expect.objectContaining({ managedTargetUnindexed: true })]);
        const initialSelections = selected.length;
        expect(detailIds).toEqual([]);
        // A committed PATCH may legitimately refresh the ordinary projection;
        // it must never traverse that inventory or repeat the migration query.
        expect(ordinaryPages).toBeGreaterThan(0);
        expect(automations.rows.get(unknown.id)?.managedTarget).toBeNull();
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        for (let index = 0; index < 12; index++) publishHomeAccountChange(home.serverId);
        await sync.resumeSync('manual');
        expect(selected).toHaveLength(initialSelections);
        expect(automations.patches).toHaveLength(1);
    });

    it('selects unindexed rows once and does not repeat after reconnects or unrelated arrivals', async () => {
        let selections = 0;
        const selectionEntered = createDeferred<void>();
        const automations = createWorkflowAutomationHttpBoundary();
        const retained = createWorkflowAutomationDetailFixture({ id: 'retained-library-automation', revision: 1,
            workflowDefinitionId: formatWorkflowDefinitionRefV1({ kind: 'artifact', artifactId: '00000000-0000-4000-8000-000000000031' }) });
        automations.rows.set(retained.id, retained);
        const sockets: Socket[] = [];
        const home = await restoreServerAccountForTest({
            serverUrl: 'https://automation-backfill.example.test', accountId: 'backfill-account',
            configureSocket: socket => { sockets.push(socket); configureConnectedServerSocketBoundary(socket); },
            request: async (input, init) => {
                const url = new URL(String(input));
                const path = url.pathname;
                if (path.startsWith('/v1/features')) return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'backfill-account' });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v3/automations/query') {
                    if (JSON.parse(String(init?.body)).managedTargetUnindexed === true) { selections++; selectionEntered.resolve(); }
                } else if (path === '/v3/automations') {
                    if (url.searchParams.get('managedTargetUnindexed') === 'true') { selections++; selectionEntered.resolve(); }
                }
                if (path === `/v3/automations/${retained.id}` && init?.method === 'PATCH') {
                    const current = automations.rows.get(retained.id);
                    if (!current) throw new Error('Expected retained server definition');
                    automations.rows.set(retained.id, { ...current, name: 'Concurrent rename', enabled: false,
                        assignments: current.assignments.map(row => ({ ...row, priority: 7 })) });
                }
                const automationReply = await automations.handle(url, init);
                if (automationReply) return automationReply;
                if (path === '/v1/machines') return Response.json([]);
                return createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        const { sync } = await import('@/sync/sync');
        await sync.ensureAutomationsRead();
        await selectionEntered.promise;
        expect(selections).toBe(1);
        await vi.waitFor(() => expect(automations.patches).toHaveLength(1));
        expect(automations.rows.get(retained.id)?.managedTarget).toBeNull();
        expect(automations.rows.get(retained.id)).toMatchObject({ name: 'Concurrent rename', enabled: false,
            assignments: [{ machineId: 'machine-1', priority: 7 }] });
        const socket = sockets.find(candidate => typeof candidate.auth === 'object'
            && 'clientPurpose' in candidate.auth && candidate.auth.clientPurpose === 'sync');
        if (!socket) throw new Error('Expected connected Account socket');
        socket.connected = false;
        socket.emitReserved('disconnect', 'transport close');
        socket.connect();
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        for (let index = 0; index < 12; index++) publishHomeAccountChange(home.serverId);
        await sync.resumeSync('manual');
        expect(selections).toBe(1);
        expect(automations.patches).toHaveLength(1);
        expect(automations.reconciles).toHaveLength(0);
    });

    it('cancels a held first-use migration select when its credentials retire', async () => {
        const release = createDeferred<void>();
        let selectionSignal: AbortSignal | null | undefined;
        let detailReads = 0;
        const home = await restoreServerAccountForTest({
            serverUrl: 'https://automation-backfill-retire.example.test', accountId: 'backfill-retiring-account',
            configureSocket: configureConnectedServerSocketBoundary,
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path.startsWith('/v1/features')) return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'backfill-retiring-account' });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v3/automations/query') {
                    if (JSON.parse(String(init?.body)).managedTargetUnindexed === true) {
                        selectionSignal = init?.signal;
                        await release.promise;
                    }
                    return Response.json({ automations: [], nextCursor: null });
                }
                if (path.startsWith('/v3/automations/')) detailReads++;
                if (path === '/v3/automations') return Response.json({ automations: [], nextCursor: 'unknown-remainder' });
                if (path === '/v1/machines') return Response.json([]);
                return createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        try {
            const { sync } = await import('@/sync/sync');
            await sync.resumeSync('manual');
            await sync.ensureAutomationsRead();
            await vi.waitFor(() => expect(selectionSignal).toBeDefined());
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await TokenStorage.removeCredentialsForServerUrl(home.home.serverUrl, { serverId: home.serverId });
            await disconnectActiveServerConnection();
            await vi.waitFor(() => expect(selectionSignal?.aborted).toBe(true));
        } finally { release.resolve(); }
        expect(detailReads).toBe(0);
    });
});
