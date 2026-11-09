import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import {
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    bindExternalActionExecutionAuthorizationHttpPathV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-birth-', initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it('admits signed exact managed birth lookups without granting other workflow storage operations', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }), metadataVersion: 1,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
    } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const homeId = await getOrCreateServerIdentityId();
    const actionId = 'machines.managed.birth.get';
    const target = { homeId, managedId: 'retained-managed' };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
        target: { kind: 'machine', machineId: machine.id }, input: target });
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    registerWorkflowRunStorageRoutes(app);
    registerManagedMachineRoutes(app);
    try {
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
        expect(minted.statusCode, minted.body).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        const verify = (path: string, body: unknown, privateKey = keys.secretKey) => verifyExternalActionDomainExecutionRequest({
            authorizationToken: root.token, effectActionId: actionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method: 'POST', path, body,
            machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                target: root.binding.target, installationId: machine.installationId!, requestId: root.binding.requestId,
                method: 'POST', path, body, privateKey }),
        });
        const workflowPath = '/v3/automations/runs/workflow-storage';
        const birthPath = '/v1/machines/managed/actions/birth.get';
        expect(await verify(birthPath, target)).not.toBeNull();
        expect(await verify(workflowPath, { operation: 'get', runId: 'unrelated' })).toBeNull();
        expect(await verify(workflowPath, { operation: 'managed-birth.lookup', ...target })).toBeNull();
        expect(await verify('/v2/sessions/lookup-managed-birth', target)).toBeNull();
        expect(await verify(birthPath, target, tweetnacl.sign.keyPair().secretKey)).toBeNull();
        expect(await verify('/v2/sessions', target)).toBeNull();
        const read = (path: string, body: Readonly<Record<string, string>>) => app.inject({ method: 'POST', url: path,
            headers: { 'content-type': 'application/json',
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: machine.installationId!,
                    requestId: root.binding.requestId, method: 'POST', path, body, privateKey: keys.secretKey }),
            }, payload: JSON.stringify(body) });
        const birth = await read(birthPath, target);
        expect(birth.statusCode, birth.body).toBe(200);
        expect(birth.json()).toEqual({ source: null });
        const privateField = await read(birthPath, { ...target, privateField: 'private' });
        expect(privateField.statusCode).toBe(400);
        const run = await read(workflowPath, { operation: 'get', runId: 'unrelated' });
        expect(run.statusCode).toBe(401);
    } finally { await app.close(); }
});
