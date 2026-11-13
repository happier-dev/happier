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

    it.each(['account', 'team'] as const)('issues export TCP grants as the real %s requester and refuses access loss on either Machine', async (sharing) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machines = await Promise.all(['a', 'b'].map(endpoint => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, active: true, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'export-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/peer', happyHomeDir: '/home/peer/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                irohMachineEndpoint: { protocolVersions: [1], endpointId: endpoint.repeat(64) },
            },
        } })));
        const source = machines[0]!;
        const target = machines[1]!;
        const team = await db.team.create({ data: { name: 'Export users' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
        if (sharing === 'team') await db.machineGrant.createMany({ data: machines.map(machine => ({ principalKind: 'team',
            machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id,
        })) });
        else await db.machineGrant.createMany({ data: machines.map(machine => ({ principalKind: 'account',
            machineId: machine.id, accountId: actor.id, accessLevel: 'view', createdByAccountId: owner.id,
        })) });
        const key = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({ method: 'POST', path: '/v1/machines/peer/mediation/route-grants',
            registerRoutes: app => registerPeerMediationGrantRoutes(app, { env: {
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'export-admission',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(key.secretKey).toString('base64url'),
            } }),
        });
        const body = { v: 2, kind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
            machineId: target.id, flowKind: 'tcp_tunnel', routeKind: 'iroh_peer', endpointFingerprint: 'b'.repeat(64), ttlMs: 60_000,
            iroh: { operationKind: 'tcp_tunnel', initiator: { kind: 'machine', machineId: source.id, endpointId: 'a'.repeat(64) },
                target: { machineId: target.id, endpointId: 'b'.repeat(64) } },
            scope: { kind: 'tcp_tunnel', tunnelId: randomUUID(), allowedPorts: [5432], serviceExport: {
                commitment: `sha256:${'a'.repeat(64)}`,
            } } };
        const issue = async (userId: string) => (await route.invoke({ userId, body })).response;
        expect(await issue(actor.id)).toMatchObject({ ok: true, grant: { payload: { accountId: actor.id, machineId: target.id } } });
        expect(await issue(outsider.id)).toMatchObject({ ok: false, reasonCode: 'access_denied' });
        // docs/teams.md Guest: only direct Account or explicit Group grants authorize a guest.
        expect(await issue(guest.id)).toMatchObject({ ok: false, reasonCode: 'access_denied' });
        await db.machineGrant.createMany({ data: machines.map(machine => ({ principalKind: 'account',
            machineId: machine.id, accountId: guest.id, accessLevel: 'view', createdByAccountId: owner.id,
        })) });
        expect(await issue(guest.id)).toMatchObject({ ok: true, grant: { payload: { accountId: guest.id } } });
        // Access to A alone cannot authorize a target B export.
        if (sharing === 'team') {
            await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: target.id, teamId: team.id } });
            expect(await issue(actor.id)).toMatchObject({ ok: false, reasonCode: 'access_denied' });
            await db.machineGrant.create({ data: { principalKind: 'team', machineId: target.id, teamId: team.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
        } else {
            await db.machineGrant.deleteMany({ where: { principalKind: 'account', machineId: target.id, accountId: actor.id } });
            expect(await issue(actor.id)).toMatchObject({ ok: false, reasonCode: 'access_denied' });
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: target.id, accountId: actor.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
        }
        expect(await issue(actor.id)).toMatchObject({ ok: true, grant: { payload: { accountId: actor.id } } });
        if (sharing === 'team') await db.teamMembership.delete({ where: { id: member.id } });
        else await db.machineGrant.deleteMany({ where: { principalKind: 'account', machineId: source.id, accountId: actor.id } });
        expect(await issue(actor.id)).toMatchObject({ ok: false, reasonCode: 'access_denied' });
        expect(await db.machine.findUnique({ where: { id: target.id } })).toEqual(target);
        const { serviceExport: _export, ...genericScope } = body.scope;
        expect((await route.invoke({ userId: guest.id, body: { ...body, scope: genericScope } })).response)
            .toMatchObject({ ok: false, reasonCode: 'route_unavailable' });
    });

    it.each(['machine_rpc', 'bounded_transfer'] as const)('keeps an admitted shared %s target server-required and rejects the next request after revoke', async (flowKind) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: encodePlainMachineStoredContent({
                host: 'peer-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/peer', happyHomeDir: '/home/peer/.happier',
            }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            active: true, installationId: randomUUID(),
        } });
        await db.machineGrant.create({ data: { principalKind: 'account',
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
                    ? { kind: 'machine_rpc', rpcScopeId: randomUUID(), allowedMethods: ['daemon.memory.status'], maxIdleMs: 1000 }
                    : { kind: 'bounded_transfer', mode: 'single', transferId: randomUUID(), maxBytes: 1024 } },
        };
        expect((await route.invoke(request)).response).toMatchObject({ ok: false,
            reasonCode: flowKind === 'machine_rpc' ? 'machine_rpc_method_server_required' : 'route_unavailable' });
        await db.machineGrant.deleteMany({ where: { principalKind: 'account', machineId: machine.id, accountId: actor.id } });
        expect((await route.invoke(request)).response).toMatchObject({ ok: false, reasonCode: 'access_denied' });
    });
});
