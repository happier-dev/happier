import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage, useMachinePresenceCounts } from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { createMachinePresenceDeadlineOwner, resolvePresenceTimeoutConfig } from '../../../../server/sources/app/presence/timeout';
import { eventRouter, type ClientConnection } from '../../../../server/sources/app/events/eventRouter';
import { createFakeSocket } from '../../../../server/sources/app/api/testkit/socketHarness';
import { inTx } from '../../../../server/sources/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'machine-expiry-client-', initAuth: false });
    await loadSyncSingletonForTests();
}, 120_000);
afterAll(async () => { try { await standardCleanup(); } finally { await database?.close(); } });

it('consumes the server deadline push as offline and transport withdrawal as unknown without client expiry timers', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const activeAt = Date.now();
    const row = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        active: true, lastActiveAt: new Date(activeAt) } });
    await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: row.id,
        principal: { kind: 'account', accountId: viewer.id }, level: 'view' }));
    const sockets: Socket[] = [];
    const home = await restoreServerAccountForTest({ serverUrl: 'https://machine-expiry.example.test',
        serverIdentityId: 'srv_machine_expiry', accountId: owner.id,
        configureSocket: socket => { sockets.push(socket); configureConnectedServerSocketBoundary(socket); },
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return createEmptyAccountBootstrapHttpResponse(path, init);
        } });
    await vi.waitFor(() => expect(storage.getState().socketStatus).toBe('connected'));
    const client = sockets.find(socket => typeof socket.auth === 'object' && socket.auth.clientPurpose === 'sync');
    if (!client) throw new Error('Restored Account has no Sync socket');
    const deliveries: Array<{ accountId: string; payload: unknown }> = [];
    const connections: ClientConnection[] = [owner, viewer].map(account => {
        // Replace only the network hop: server routing and the registered client listeners remain real.
        const socket = createFakeSocket({ emit: vi.fn((event: string, payload: unknown) => {
            if (event !== 'ephemeral') return;
            deliveries.push({ accountId: account.id, payload });
            if (account.id === owner.id) {
                for (const listener of client.listenersAny()) listener(event, payload);
                for (const listener of client.listeners(event)) listener(payload);
            }
        }) });
        const connection: ClientConnection = { connectionType: 'user-scoped', userId: account.id,
            socket: socket as unknown as ClientConnection['socket'] };
        eventRouter.addConnection(account.id, connection);
        return connection;
    });
    const options = { sourceServerId: home.serverId, sourceAccountId: owner.id };
    storage.setState({ profileScope: { serverId: home.serverId, accountId: owner.id } });
    storage.getState().applyMachines([createMachineFixture({ id: row.id, active: true, activeAt, presenceProtocolVersion: 1 })], true, options);
    storage.getState().markMachineListSettled(home.serverId);
    const onlineControlId = 'online-through-transport-loss';
    const hook = await renderHook(() => ({ counts: useMachinePresenceCounts(),
        summary: useMachinePresenceSummary(home.serverId, row.id),
        onlineControl: useMachinePresenceSummary(home.serverId, onlineControlId) }));
    const deadlines = createMachinePresenceDeadlineOwner();
    try {
        expect(hook.getCurrent().counts).toEqual({ online: 1, offline: 0, unknown: 0 });
        expect(hook.getCurrent().summary.reachability).toBe('reachable');
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        await deadlines.start();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(resolvePresenceTimeoutConfig().machineTimeoutMs - 1);
        });
        expect(hook.getCurrent().summary.reachability).toBe('reachable');
        expect(deliveries).toHaveLength(0);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
            await deadlines.stop();
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect((await db.machine.findUniqueOrThrow({ where: { id: row.id } })).active).toBe(false);
        expect(deliveries).toHaveLength(2);
        expect(deliveries).toEqual(expect.arrayContaining([owner, viewer].map(account => ({ accountId: account.id,
            payload: { type: 'machine-activity', id: row.id, active: false, activeAt } }))));
        expect(hook.getCurrent().counts).toEqual({ online: 0, offline: 1, unknown: 0 });
        expect(hook.getCurrent().summary).toMatchObject({ reachability: 'unreachable', lastSeenAt: activeAt });
        const offline = hook.getCurrent();
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(hook.getCurrent()).toBe(offline);
        expect(deliveries).toHaveLength(2);
        await act(async () => { storage.getState().applyMachines([
            createMachineFixture({ id: onlineControlId, active: true, activeAt: Date.now(), presenceProtocolVersion: 1 }),
        ], false, options); });
        expect(hook.getCurrent().counts).toEqual({ online: 1, offline: 1, unknown: 0 });
        expect(hook.getCurrent().onlineControl.reachability).toBe('reachable');
        await act(async () => { client.connected = false; client.emitReserved('disconnect', 'transport close'); });
        expect(hook.getCurrent().counts).toEqual({ online: 0, offline: 0, unknown: 2 });
        expect(hook.getCurrent().summary.reachability).toBe('unknown');
        expect(hook.getCurrent().onlineControl.reachability).toBe('unknown');
    } finally {
        await deadlines.stop();
        await hook.unmount();
        for (const connection of connections) eventRouter.removeConnection(connection.userId, connection);
        vi.useRealTimers();
        await home.dispose();
    }
});
