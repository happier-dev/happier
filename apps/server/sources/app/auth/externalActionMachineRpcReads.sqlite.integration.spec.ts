import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createSignedDiscussionHttpFixture } from '@/app/api/routes/actions/discussionExecutionAuthorization.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from './auth';
import { verifyExternalActionMachineRpcExecution } from './externalActionExecutionAuthorization';

describe('Session-source Machine RPC identity reads', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-rpc-identity-reads-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([false, true])('reads each signing installation once and overlaps distinct source/target reads (distinct=%s)', async distinct => {
        const f = await createSignedDiscussionHttpFixture();
        try {
            const targetKeys = nacl.sign.keyPair();
            const target = distinct ? await db.machine.create({ data: {
                id: randomUUID(), accountId: f.account.id, metadata: f.machine.metadata,
                dataEncryptionKey: f.machine.dataEncryptionKey, metadataVersion: 1,
                installationId: randomUUID(), installationPublicKey: new Uint8Array(targetKeys.publicKey),
            } }) : f.machine;
            await db.machine.update({ where: { id: target.id }, data: { active: true, lastActiveAt: new Date(),
                operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
            const session = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            await db.accessKey.create({ data: { accountId: f.account.id, machineId: f.machine.id,
                sessionId: session.id, data: 'opaque-key' } });
            const serverIdentityId = await getOrCreateServerIdentityId();
            const envelope = { v: 1 as const, requestId: randomUUID(), target: { kind: 'machine' as const, machineId: target.id },
                input: {} };
            const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, requestId: envelope.requestId,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
                sourceTurnId: randomUUID(), callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
            const resolveCurrentSessionMachine = async () => f.machine.id;
            const authorization = await auth.mintExternalActionExecutionAuthorization({
                accountId: f.account.id, serverIdentityId, machineId: target.id, actionId: 'agents.models.list',
                target: envelope.target, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch }, sessionActionOrigin,
                sessionActionSource: { machineId: f.machine.id, installationId: f.machine.installationId! },
            }, { resolveCurrentSessionMachine });
            const request = { method: `${target.id}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`, requestId: randomUUID(), params: 'opaque-child-input' };
            const signed = { authorizationToken: authorization.token, effectActionId: 'agents.models.list' as const,
                target: envelope.target, installationId: target.installationId!, ...request };
            const execution = { v: 1 as const, authorization, effectActionId: signed.effectActionId,
                target: signed.target, installationId: signed.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) };
            // Observe the real database boundary: all authorization and storage behavior remains real.
            const readSource = db.machine.findUnique;
            const readTarget = db.machine.findFirst;
            let signingReads = 0;
            let targetStarted = false;
            let targetStartedBeforeSourceSettled = false;
            db.machine.findUnique = new Proxy(readSource, { apply(target, thisArg, args) {
                const result = Reflect.apply(target, thisArg, args);
                if (!args[0]?.select?.installationPublicKey) return result;
                signingReads += 1;
                return Promise.resolve(result).then(value => {
                    targetStartedBeforeSourceSettled = targetStarted;
                    return value;
                });
            } });
            db.machine.findFirst = new Proxy(readTarget, { apply(target, thisArg, args) {
                if (args[0]?.select?.installationPublicKey) { signingReads += 1; targetStarted = true; }
                return Reflect.apply(target, thisArg, args);
            } });
            try {
                const refusals: string[] = [];
                const result = await verifyExternalActionMachineRpcExecution(execution, { ...request, resolveCurrentSessionMachine,
                    onRefusal: phase => { refusals.push(phase); } });
                expect(result, JSON.stringify(refusals))
                    .toMatchObject({ binding: { machineId: target.id }, principal: { accountId: f.account.id } });
                expect(signingReads).toBe(distinct ? 2 : 1);
                if (distinct) expect(targetStartedBeforeSourceSettled).toBe(true);
            } finally { db.machine.findUnique = readSource; db.machine.findFirst = readTarget; }
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { ...request, resolveCurrentSessionMachine })).toBeNull();
        } finally { await f.app.close(); }
    });
});
