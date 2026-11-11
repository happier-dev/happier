import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema, encodePlainMachineStoredContent } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '../testkit/socketHarness';
import { machineUpdateHandler } from './machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from './machineSocketInstallationProof';

const options = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
};

describe('machine Session Pending enqueue through real admission owners', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-pending-handler-', initAuth: true });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    async function fixture() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'source' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const target = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'target' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            active: true, lastActiveAt: new Date(1), publisherGeneration: 1n,
        } });
        await db.accessKey.create({ data: {
            accountId: account.id, machineId: source.id, sessionId: session.id, data: 'opaque',
        } });
        await db.session.update({ where: { id: session.id }, data: {
            runtimeMachineTarget: {
                homeId: await getOrCreateServerIdentityId(), accountId: account.id, sessionId: session.id,
                machineId: source.id, installationId: source.installationId!,
            },
        } });
        return { account, source, target, session };
    }

    function request(sessionId: string, targetMachineId: string, localId = `plugin-input-v1:${randomUUID()}`) {
        return SessionPendingEnqueueByMachineRequestV1Schema.parse({
            v: 1, sessionId, targetMachineId, localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    }

    async function invoke(f: Awaited<ReturnType<typeof fixture>>, payload = request(f.session.id, f.source.id)) {
        const socket = createFakeSocket({
            nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
            data: {
                clientType: 'machine-scoped', machineId: f.source.id,
                authAuthority: 'present_user',
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: f.source.installationId,
            },
        });
        machineUpdateHandler(f.account.id, socket as unknown as Socket, options);
        let response: unknown;
        await getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)(payload, (value: unknown) => {
            response = value;
        });
        return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
    }

    it('admits the real source Machine and persists the pending message', async () => {
        const f = await fixture();
        const localId = `accepted-${randomUUID()}`;
        await expect(invoke(f, request(f.session.id, f.source.id, localId))).resolves.toEqual({ status: 'accepted', localId });
        await expect(db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: f.session.id, localId } } }))
            .resolves.toMatchObject({ sessionId: f.session.id, localId, content: { t: 'plain' } });
    });

    it('rejects a revoked source Machine before enqueue admission', async () => {
        const f = await fixture();
        await db.machine.update({ where: { id: f.source.id }, data: { revokedAt: new Date() } });
        await expect(invoke(f)).resolves.toEqual({ status: 'rejected', code: 'session_input_unauthorized' });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: f.session.id } })).resolves.toBe(0);
    });

    it('rejects an unavailable source Machine before enqueue admission', async () => {
        const f = await fixture();
        await db.machine.update({ where: { id: f.source.id }, data: { replacedByMachineId: f.target.id } });
        await expect(invoke(f)).resolves.toEqual({ status: 'rejected', code: 'session_input_unauthorized' });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: f.session.id } })).resolves.toBe(0);
    });
});
