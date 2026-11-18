import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import {
    ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { plainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';

// The admitted read-root rule and the one foreign-custodian read rule, at the verifier owner.
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-admitted-read-root-',
        initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' },
    });
}, 120_000);
afterAll(async () => {
    await harness?.close();
});

async function createFixture() {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keyPair = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }), metadataVersion: 1,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keyPair.publicKey),
    } });
    const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: plainPrivateLabel('ordinary') });
    const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: crypto.randomUUID(),
        target: { kind: 'machine', machineId: machine.id }, input: {} };
    return { account, machine, pat, envelope, keyPair };
}

function createApp(resolveCurrentSessionMachine: () => Promise<string | null>) {
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
    enableAuthentication(app);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    return app;
}

describe('admitted read-root requester reads', () => {
    it('lets an admitted read-only Account root make its GET reads as the requester and nothing more', async () => {
        // DBW-TELEMETRY F14: the signed machines.roles.get root reads GET /v1/machines/<id>; the Machine
        // route keeps the requester's own access, so this equals the requester's bearer read.
        const fixture = await createFixture();
        // A Team member's Machine hosts one of the requester's Sessions under a shared-Machine grant.
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const hostKeys = tweetnacl.sign.keyPair();
        const host = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(hostKeys.publicKey) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: host.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: host.id, sessionId: session.id, data: 'hosted-session-key' } });
        const app = createApp(async () => host.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const verifyAs = async (actionId: string, input: unknown, method: string, path: string, body?: unknown,
                credential = token, bound: Readonly<{ machineId: string; installationId: string; privateKey: Uint8Array }> = {
                    machineId: fixture.machine.id, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey }) => {
                const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${credential}` }, payload: { v: 1, machineId: bound.machineId,
                        envelope: { ...fixture.envelope, requestId: crypto.randomUUID(),
                        target: { kind: 'machine', machineId: bound.machineId }, input } } });
                expect(response.statusCode, response.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                const target = authorization.binding.target;
                return await verifyExternalActionDomainExecutionRequest({
                    authorizationToken: authorization.token, effectActionId: actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: bound.installationId,
                        requestId: authorization.binding.requestId, method, path, body, privateKey: bound.privateKey }),
                });
            };
            const read = { machineId: fixture.machine.id };
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`)).not.toBeNull();
            // A read root cannot mutate, and a mutating root gains no general read purpose.
            expect(await verifyAs('machines.roles.get', read, 'POST', `/v1/machines/${fixture.machine.id}/roles`, {})).toBeNull();
            expect(await verifyAs('notifications.notify_me', { message: 'done' },
                'GET', `/v1/machines/${fixture.machine.id}`)).toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.roles.get'] } } } });
            // Guard: a root bound to another person's Machine is that custodian's root, not the requester's read.
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`, undefined, token,
                { machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey })).toBeNull();
            // One foreign-custodian rule: a Team member's Machine reads a requester resource only when the
            // custodian itself holds access to it. The requester's Machine list is not; Machine admission
            // already refuses the plugin-materializations root there.
            const hostBound = { machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey };
            expect(await verifyAs('machines.list', {}, 'GET', '/v1/machines')).not.toBeNull();
            expect(await verifyAs('machines.list', {}, 'GET', '/v1/machines', undefined, token, hostBound)).toBeNull();
            const widgets = { surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                owner: { kind: 'sessionBoard', sessionId: session.id } } };
            const materializations = '/v1/plugins/availability/materializations/read';
            expect(await verifyAs('widgets.catalog.list', widgets, 'POST', materializations, {})).not.toBeNull();
            const foreignWidgets = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('widgets.catalog.list'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: host.id, envelope: { ...fixture.envelope,
                    requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: host.id }, input: widgets } } });
            expect(foreignWidgets.statusCode, foreignWidgets.body).toBe(409);
            // Guard: an API-token root keeps its grant-scoped purposes; it is not the requester's bearer.
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`, undefined, fixture.pat.token)).toBeNull();
            // Guard: the requester's own Machine must sign. A Session-origin root bound to it but signed by the
            // foreign host of the caller Session (captured source key) gains no general requester read.
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 1 }, sourceTurnId: 'read-turn',
                callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
                requestId: crypto.randomUUID() });
            const envelope = { v: 1, requestId: origin.requestId, target: fixture.envelope.target, input: read } satisfies ExternalActionRequestEnvelopeV1;
            const source = { machineId: host.id, installationId: host.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: hostKeys.secretKey, payload: { version: 1,
                accountId: fixture.account.id, ...source, externalActionOrigin: { homeId: await getOrCreateServerIdentityId(),
                    actionId: 'machines.roles.get', requestId: origin.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.roles.get'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const hosted = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(hosted.binding).toMatchObject({ custodianAccountId: fixture.account.id, sessionActionSource: source });
            const path = `/v1/machines/${fixture.machine.id}`;
            const signedBy = (privateKey: Uint8Array, installationId: string) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: hosted.token, effectActionId: 'machines.roles.get',
                encodedTarget: encodeExternalActionResolvedTargetV1(hosted.binding.target), method: 'GET', path,
                resolveCurrentSessionMachine: async () => host.id,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: hosted.token,
                    effectActionId: 'machines.roles.get', target: hosted.binding.target, installationId,
                    requestId: hosted.binding.requestId, method: 'GET', path, privateKey }) });
            expect(await signedBy(hostKeys.secretKey, fixture.machine.installationId!)).toBeNull();
        } finally { await app.close(); }
    });
});
