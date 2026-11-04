import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './syncEngine';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import type { Socket } from 'socket.io-client';
import { createDeferred } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createWorkflowAutomationDetailFixture, createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; });

describe('Automation managed target migration at authenticated UI startup', () => {
    it.each(['missing', 'disabled', 'complete-known'] as const)('does no migration work for %s bootstrap admission', async admission => {
        let selections = 0;
        let definitionReads = 0;
        let listReads = 0;
        const automations = createWorkflowAutomationHttpBoundary();
        const known = createWorkflowAutomationDetailFixture({ id: 'known-bootstrap-row', revision: 1 });
        automations.rows.set(known.id, { ...known, managedTarget: null });
        const home = await restoreServerAccountForTest({
            serverUrl: `https://automation-backfill-${admission}.example.test`, accountId: `backfill-${admission}`,
            configureSocket: configureConnectedServerSocketBoundary,
            request: async (input, init) => {
                const url = new URL(String(input));
                const path = url.pathname;
                if (path.startsWith('/v1/features')) {
                    const response = createRootLayoutFeaturesResponse({ features: { automations: { enabled: admission === 'complete-known' } } });
                    if (admission !== 'missing') return Response.json(response);
                    const { automations: _omitted, ...features } = response.features;
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
        await sync.refreshAutomations();
        await sync.resumeSync('manual');
        expect(selections).toBe(0);
        expect(definitionReads).toBe(0);
        expect(automations.patches).toHaveLength(0);
        if (admission !== 'complete-known') expect(listReads).toBe(0);
        else expect(listReads).toBeGreaterThan(0);
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
                if (path === '/v3/automations/query') selected.push(JSON.parse(String(init?.body)));
                else if (path === '/v3/automations') {
                    ordinaryPages++;
                    expect(url.searchParams.has('cursor')).toBe(false);
                } else if (path.startsWith('/v3/automations/') && (init?.method ?? 'GET') === 'GET') detailIds.push(path.split('/').at(-1)!);
                const reply = await automations.handle(url, init);
                return reply ?? createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = home.dispose;
        await vi.waitFor(() => expect(automations.patches).toHaveLength(1));
        expect(selected).toEqual([expect.objectContaining({ managedTargetUnindexed: true })]);
        expect(detailIds).toEqual([]);
        // A committed PATCH may legitimately refresh the ordinary projection;
        // it must never traverse that inventory or repeat the migration query.
        expect(ordinaryPages).toBeGreaterThan(0);
        expect(automations.rows.get(unknown.id)?.managedTarget).toBeNull();
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        for (let index = 0; index < 12; index++) publishHomeAccountChange(home.serverId);
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        expect(selected).toHaveLength(1);
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
                if (path === '/v2/cursor') return Response.json({ cursor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 1 });
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
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        expect(selections).toBe(1);
        expect(automations.patches).toHaveLength(1);
        expect(automations.reconciles).toHaveLength(0);
    });

    it('cancels a held startup select when its credentials retire', async () => {
        const entered = createDeferred<void>();
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
                if (path === '/v3/automations/query' && JSON.parse(String(init?.body)).managedTargetUnindexed === true) {
                    selectionSignal = init?.signal; entered.resolve(); await release.promise;
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
            await entered.promise;
            expect(selectionSignal).toBeDefined();
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await TokenStorage.removeCredentialsForServerUrl(home.home.serverUrl, { serverId: home.serverId });
            expect(selectionSignal?.aborted).toBe(true);
        } finally { release.resolve(); }
        await entered.promise;
        expect(detailReads).toBe(0);
    });
});
