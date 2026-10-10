import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { eventRouter } from '@/app/events/connectionEventRouter';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
import { removeMachineAccessGrantInTx, setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from './machineSocketInstallationProof';
import { machineUpdateHandler } from './machineUpdateHandler';

describe('Machine presence through current C41 recipients (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-presence-audience-', initAuth: true,
            env: { HANDY_MASTER_SECRET: 'machine-presence-audience-secret', AUTH_REQUIRED_LOGIN_PROVIDERS: '', SERVER_ROLE: 'all' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function createMachine(accountId: string) {
        return await db.machine.create({ data: {
            id: randomUUID(), accountId, installationId: 'presence-installation', active: false,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
    }

    it.each(['installation', 'credential', 'custodian', 'revoked', 'scope', 'private_payload'] as const)(
        'admits content-free usage source settlement only while publisher authority is current (%s)', async loss => {
            const owner = await db.account.create({ data: { publicKey: `usage-${randomUUID()}`, encryptionMode: 'plain' } });
            const machine = await createMachine(owner.id);
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const reader = Object.assign(createFakeSocket({ id: `usage-reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
                { disconnect: vi.fn() });
            const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
            eventRouter.addConnection(owner.id, connection);
            const publisher = Object.assign(createFakeSocket({ data: {
                clientType: 'machine-scoped', machineId: machine.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
            } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
            machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            const payload = { type: 'usage-sources-invalidated', machineId: machine.id, installationId: machine.installationId };
            const wakes = () => reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral' && value?.type === payload.type)
                .map(([, value]) => value);
            try {
                const invalidate = getSocketHandler(publisher, payload.type);
                await invalidate(payload);
                expect(wakes()).toEqual([payload]);
                reader.emit.mockClear();
                if (loss === 'installation') await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement' } });
                if (loss === 'credential') await db.account.update({ where: { id: owner.id }, data: { tokenEpoch: { increment: 1 } } });
                if (loss === 'custodian') {
                    const next = await db.account.create({ data: { publicKey: `usage-next-${randomUUID()}`, encryptionMode: 'plain' } });
                    await db.machine.update({ where: { id: machine.id }, data: { accountId: next.id } });
                }
                if (loss === 'revoked') await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
                if (loss === 'scope') publisher.data!.clientType = 'user-scoped';
                await invalidate(loss === 'private_payload' ? { ...payload, root: '/private/source' } : payload);
                expect(wakes()).toEqual([]);
            } finally { eventRouter.removeConnection(owner.id, connection); }
        },
    );

    it('publishes only safe Machine liveness to owner, Manage and Use, excluding outsiders and retired grants', async () => {
        const account = () => db.account.create({ data: { publicKey: `presence-${randomUUID()}`, encryptionMode: 'plain' } });
        const [owner, manager, user, outsider] = await Promise.all([account(), account(), account(), account()]);
        const machine = await createMachine(owner.id);
        for (const [recipient, level] of [[manager, 'admin'], [user, 'view']] as const) {
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: recipient.id }, level }))).toMatchObject({ kind: 'saved' });
        }
        await db.session.create({ data: { accountId: user.id, tag: randomUUID(), metadata: 'private-requester-title-and-content' } });
        const connections: ClientConnection[] = [];
        // Only the Socket.IO adapter is replaced. EventRouter, authentication,
        // C41 grants/membership and the presence cache execute their real owners.
        const recipients = [owner, manager, user, outsider].map(account => {
            const socket = Object.assign(createFakeSocket({ id: `presence-${account.id}`, data: { clientType: 'user-scoped' } }),
                { disconnect: vi.fn() });
            const connection: ClientConnection = { userId: account.id, connectionType: 'user-scoped', socket: socket as unknown as Socket };
            eventRouter.addConnection(account.id, connection);
            connections.push(connection);
            return { accountId: account.id, socket, activities: () => socket.emit.mock.calls
                .filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')
                .map(([, payload]) => payload) };
        });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = Object.assign(createFakeSocket({ id: `publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        const publisherConnection: ClientConnection = { userId: owner.id, connectionType: 'machine-scoped', machineId: machine.id,
            socket: publisher as unknown as Socket };
        eventRouter.addConnection(owner.id, publisherConnection);
        connections.push(publisherConnection);
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            const timestamp = Date.now();
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: timestamp });
            const expected = { type: 'machine-activity', id: machine.id, active: true, activeAt: timestamp };
            for (const recipient of recipients.slice(0, 3)) expect(recipient.activities()).toEqual([expected]);
            expect(recipients[3].activities()).toEqual([]);
            expect(publisher.emit.mock.calls.filter(([event]) => event === 'ephemeral')).toEqual([]);
            for (const recipient of recipients.slice(0, 3)) {
                expect(Object.keys(recipient.activities()[0]).sort()).toEqual(['active', 'activeAt', 'id', 'type']);
                expect(JSON.stringify(recipient.activities())).not.toContain('private-requester-title-and-content');
            }
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: manager.id } }))).toMatchObject({ kind: 'removed' });
            await db.account.update({ where: { id: user.id }, data: { status: 'suspended' } });
            for (const recipient of recipients) recipient.socket.emit.mockClear();
            const nextTimestamp = Date.now();
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: nextTimestamp });
            expect(recipients[0].activities()).toEqual([{ ...expected, activeAt: nextTimestamp }]);
            for (const recipient of recipients.slice(1)) expect(recipient.activities()).toEqual([]);
        } finally {
            for (const connection of connections) eventRouter.removeConnection(connection.userId, connection);
            activityCache.invalidateMachine(machine.id);
        }
    });

    it.each(['epoch', 'installation'] as const)('does not publish online presence after the authenticated Machine publisher loses its %s', async loss => {
        const owner = await db.account.create({ data: { publicKey: `publisher-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const reader = Object.assign(createFakeSocket({ id: `reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
            { disconnect: vi.fn() });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const publisher = Object.assign(createFakeSocket({ id: `publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: Date.now() });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity'))
                .toHaveLength(1);
            reader.emit.mockClear();
            if (loss === 'epoch') {
                await db.account.update({ where: { id: owner.id }, data: { tokenEpoch: { increment: 1 } } });
            } else {
                await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement-installation' } });
            }
            // A surviving transport models missed eager eviction; authentication
            // and installation are re-derived from the actual retained authorities.
            expect(publisher.connected).toBe(true);
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: Date.now() });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity'))
                .toEqual([]);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            activityCache.invalidateMachine(machine.id);
        }
    });

    it('preserves an authenticated custodian heartbeat for a genuinely uninstalled predecessor Machine', async () => {
        const owner = await db.account.create({ data: { publicKey: `legacy-presence-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        await db.machine.update({ where: { id: machine.id }, data: { installationId: null } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const reader = Object.assign(createFakeSocket({ id: `legacy-reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
            { disconnect: vi.fn() });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const publisher = Object.assign(createFakeSocket({ id: `legacy-publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            const timestamp = Date.now();
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: timestamp });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')
                .map(([, payload]) => payload))
                .toEqual([{ type: 'machine-activity', id: machine.id, active: true, activeAt: timestamp }]);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            activityCache.invalidateMachine(machine.id);
        }
    });
});
