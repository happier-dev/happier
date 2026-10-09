import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createRouteTestBuilder } from '../../../../testkit/routeTestBuilder';
import { registerPeerMediationGrantRoutes } from './registerPeerMediationGrantRoutes';

describe('Peer grant current Machine admission (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-peer-machine-admission-' });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['machine_rpc', 'bounded_transfer'] as const)('keeps an admitted shared %s target server-required and rejects the next request after revoke', async (flowKind) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: encodePlainMachineStoredContent({
                host: 'peer-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/peer', happyHomeDir: '/home/peer/.happier',
            }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            active: true, installationId: randomUUID(),
        } });
        await db.machineAccountGrant.create({ data: {
            machineId: machine.id, accountId: actor.id, accessLevel: 'view', createdByAccountId: owner.id,
        } });
        const key = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: 'POST', path: '/v1/machines/peer/mediation/route-grants',
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, { env: {
                HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: 'true',
                HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: 'true',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'peer-admission',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(key.secretKey).toString('base64url'),
            } }),
        });
        const request = {
            userId: actor.id,
            body: { machineId: machine.id, flowKind, routeKind: 'loopback_direct',
                endpointFingerprint: 'current-endpoint', ttlMs: 60_000,
                scope: flowKind === 'machine_rpc'
                    ? { kind: 'machine_rpc', rpcScopeId: randomUUID(), allowedMethods: ['daemon.memory.status'], maxCalls: 1, maxIdleMs: 1000 }
                    : { kind: 'bounded_transfer', mode: 'single', transferId: randomUUID(), maxBytes: 1024 } },
        };
        expect((await route.invoke(request)).response).toMatchObject({ ok: false,
            reasonCode: flowKind === 'machine_rpc' ? 'machine_rpc_method_server_required' : 'route_unavailable' });
        await db.machineAccountGrant.deleteMany({ where: { machineId: machine.id, accountId: actor.id } });
        expect((await route.invoke(request)).response).toMatchObject({ ok: false, reasonCode: 'access_denied' });
    });
});
