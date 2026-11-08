import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import {
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
    EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
    encodeExternalActionHttpBodyV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { auth } from '@/app/auth/auth';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from './enableAuthentication';
import { enableSchemaValidation } from './enableSchemaValidation';
import { enableErrorHandlers } from './enableErrorHandlers';

async function startActionBodyReceiver() {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'action-body-receiver-', initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_SERVER_IDENTITY_ID: `srv_${randomUUID().replaceAll('-', '')}`,
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    try {
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        registerExternalActionRoutes(app);
        // The verification endpoint validates inside its handler; this probe also
        // exercises Fastify's earlier schema-validation boundary.
        app.post('/body-schema', { schema: { body: ExternalActionExecutionAuthorizationVerifyRequestV1Schema } },
            async request => request.body);
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const installationId = randomUUID();
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'receiver', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/receiver', happyHomeDir: '/home/receiver/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true,
            installationId, installationPublicKey: Uint8Array.from(keys.publicKey), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'machines.services.list';
        const target = { kind: 'machine' as const, machineId };
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId,
                envelope: { v: 1, requestId: randomUUID(), target, input: { serverId: process.env.HAPPIER_SERVER_IDENTITY_ID, machineId } } } });
        expect(minted.statusCode, minted.body).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
        const body = { v: 1, ...('admittedMachineRole' in root.binding ? { admittedMachineRole: root.binding.admittedMachineRole } : {}) };
        const authorization = {
            executionAuthorization: root.token,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target, installationId, requestId: root.binding.requestId,
                privateKey: keys.secretKey, method: 'POST', path, body }),
            effectActionId: actionId,
            target: encodeExternalActionResolvedTargetV1(target),
        };
        const legacyHeaders = {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.executionAuthorization,
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: authorization.machineSignature,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: authorization.effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: authorization.target,
        };
        // Fixture control: real minting and signing must already work on the existing receiver.
        const legacy = await app.inject({ method: 'POST', url: path, headers: legacyHeaders, payload: body });
        expect(legacy.statusCode, legacy.body).toBe(200);
        const encodedFrame = encodeExternalActionHttpBodyV1(legacyHeaders, body);
        if (encodedFrame === null) throw new Error('Expected valid signed carrier');
        return { app, path, body, authorization, legacyHeaders, token,
            encodedFrame,
            frame: { v: 1, authorization, body },
            close: async () => { try { await app.close(); } finally { await harness.close(); } } };
    } catch (error) {
        try { await app.close(); } finally { await harness.close(); }
        throw error;
    }
}

let receiver: Awaited<ReturnType<typeof startActionBodyReceiver>>;
beforeAll(async () => { receiver = await startActionBodyReceiver(); }, 120_000);
afterAll(async () => { if (receiver) await receiver.close(); });

it('unwraps a signed body carrier before route schema validation and verifies the original body', async () => {
    const response = await receiver.app.inject({ method: 'POST', url: receiver.path,
        headers: { 'x-happier-action-body': 'v1' }, payload: receiver.encodedFrame });
    expect(response.statusCode, response.body).toBe(200);
});

it('gives Fastify route schema validation the original body rather than the frame', async () => {
    const response = await receiver.app.inject({ method: 'POST', url: '/body-schema',
        headers: { 'x-happier-action-body': 'v1' }, payload: receiver.encodedFrame });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(receiver.body);
});

it('rejects malformed carrier versions and unknown frame members before authentication', async () => {
    for (const [marker, payload] of [
        ['v2', receiver.frame],
        ['v1', { ...receiver.frame, unexpected: true }],
        ['v1', { ...receiver.frame, authorization: { ...receiver.authorization, unexpected: true } }],
        ['v1', { ...receiver.frame, authorization: { ...receiver.authorization, machineSignature: '' } }],
    ] as const) {
        const response = await receiver.app.inject({ method: 'POST', url: receiver.path,
            headers: { 'x-happier-action-body': marker }, payload });
        expect(response.statusCode, response.body).toBe(400);
    }
});

it('refuses simultaneous header and body proof carriers without shadowing either', async () => {
    for (const [header, value] of Object.entries({ ...receiver.legacyHeaders,
        [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: 'duplicate-child',
        [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: 'duplicate-reviewed-child',
    })) {
        const response = await receiver.app.inject({ method: 'POST', url: receiver.path,
            headers: { 'x-happier-action-body': 'v1', [header]: value }, payload: receiver.frame });
        expect(response.statusCode, response.body).toBe(400);
    }
});

it('keeps signature refusal and bearer collision policy at the existing authentication owner', async () => {
    const tampered = await receiver.app.inject({ method: 'POST', url: receiver.path,
        headers: { 'x-happier-action-body': 'v1' },
        payload: { ...receiver.frame, body: { ...receiver.body, nativePurpose: 'machine_npm_profile_acquisition' } } });
    expect(tampered.statusCode, tampered.body).toBe(401);
    expect(tampered.json()).toMatchObject({ authorizationRefusal: 'machine_signature' });
    const forged = await receiver.app.inject({ method: 'POST', url: receiver.path,
        headers: { 'x-happier-action-body': 'v1' }, payload: { ...receiver.frame,
            authorization: { ...receiver.authorization, machineSignature:
                `${receiver.authorization.machineSignature.startsWith('A') ? 'B' : 'A'}${receiver.authorization.machineSignature.slice(1)}` } } });
    expect(forged.statusCode, forged.body).toBe(401);
    expect(forged.json()).toMatchObject({ authorizationRefusal: 'machine_signature' });
    const bearerCollision = await receiver.app.inject({ method: 'POST', url: receiver.path,
        headers: { 'x-happier-action-body': 'v1', authorization: `Bearer ${receiver.token}` }, payload: receiver.frame });
    expect(bearerCollision.statusCode, bearerCollision.body).toBe(403);
    expect(bearerCollision.json()).toMatchObject({ error: 'credential_scope_denied' });
});
