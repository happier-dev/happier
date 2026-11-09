import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server as SocketServer } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '@/app/api/routes/account/registerAccountSettingsRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { registerMachineAccessRoutes } from './machineAccessRoutes';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { encodeStoredCredentials } from '../../../../../../cli/src/persistence';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-presence-requester-', initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_SERVER_IDENTITY_ID: `srv_${randomUUID().replaceAll('-', '')}` } });
}, 180_000);
afterAll(async () => { if (harness) await harness.close(); });

it.each([
    { actor: 'owner', kind: 'account' },
    { actor: 'manage', kind: 'account' },
    { actor: 'manage', kind: 'terminal' },
] as const)('uses the privately admitted $actor $kind requester for a contributed Action presence child', async ({ actor, kind }) => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const requester = actor === 'owner' ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const installationId = randomUUID();
    const machine = await db.machine.create({ data: {
        id: randomUUID(), accountId: owner.id, installationId, installationPublicKey: Uint8Array.from(keys.publicKey),
        metadata: encodePlainMachineStoredContent({ host: 'owner-machine', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true,
    } });
    const sibling = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        installationId: randomUUID(), metadata: machine.metadata, dataEncryptionKey: machine.dataEncryptionKey } });
    if (actor === 'manage') {
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
    }
    const ownerCredentials = { token: await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const requesterCredentials = { token: await auth.createToken(requester.id, undefined, {
        kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
    }), encryption: null };
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    enableSchemaValidation(app);
    enableErrorHandlers(app);
    enableAuthentication(app);
    registerExternalActionRoutes(app);
    registerAccountProfileRoute(app);
    registerAccountEncryptionRoutes(app);
    registerAccountSettingsRoutes(app);
    registerMachineAccessRoutes(app);
    // The currentness observer uses its actual socket transport. Only a live
    // channel is needed; every credential/profile/settings/access decision is HTTP + SQLite.
    const sockets = new SocketServer(app.server, { path: '/v1/updates' });
    let prepared: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
    try {
        const origin = await app.listen({ port: 0, host: '127.0.0.1' });
        const homeId = await getOrCreateServerIdentityId();
        const target = { kind: 'machine' as const, machineId: machine.id };
        const envelope = { v: 1, requestId: randomUUID(), target, input: {
            action: { pluginId: 'happier.machine.services', localId: 'machine-online/setup' },
            input: { v: 1, serverId: homeId, machineId: machine.id },
        } };
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('action.invoke'),
            headers: { authorization: `Bearer ${requesterCredentials.token}` }, payload: { v: 1, machineId: machine.id, envelope } });
        expect(minted.statusCode, minted.body).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        expect(root.binding).toMatchObject({ accountId: requester.id, custodianAccountId: owner.id,
            admittedMachineRole: 'manage', authentication: { kind } });
        // Deliberately give the daemon adapter A's credential. Only B's opened,
        // admitted private custody can authorize the child without leaking A's access.
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: ownerCredentials.token,
            credentials: ownerCredentials, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin,
            externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey }) });
        const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
            credentials: encodeStoredCredentials(requesterCredentials), purpose: { kind: 'external_action' },
            invocation: { caller: { kind: 'host' }, surface: 'cli', authority: kind === 'account' ? 'present_user' : 'account_automation' },
            installationPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        prepared = await prepareRequesterAccountActionContext({ authorization: sealed, purpose: { kind: 'external_action' },
            machineId: machine.id, installationId, installationPrivateKey: keys.secretKey,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin,
            isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root, effectActionId: 'action.invoke',
                target, installationId, privateKey: keys.secretKey, serverHttpBaseUrl: origin }),
            createExecutor: () => executor });
        expect(prepared, 'Requester custody must be opened and admitted against the real Home').not.toBeNull();
        if (!prepared) throw new Error('Requester custody unavailable');
        const context = { surface: 'cli' as const, authority: kind === 'account' ? 'present_user' as const : 'account_automation' as const,
            serverId: homeId, runtimeAccountId: requester.id, actionRequestId: envelope.requestId,
            externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: target };
        // Exercise the contributed handler's nested Action boundary directly;
        // plugin loading and native service setup are outside this auth regression.
        const read = (machineId: string) => executor.execute('machines.presence.read', { serverId: homeId, machineId }, context);
        const present = await read(machine.id);
        expect(present, JSON.stringify(present)).toMatchObject({ ok: true, result: { kind: 'present', machineId: machine.id } });
        if (actor === 'manage') {
            expect(await read(sibling.id)).toMatchObject({ ok: true, result: { kind: 'refused', code: 'machine_unavailable' } });
        }
    } finally {
        await prepared?.dispose();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await app.close();
    }
});
