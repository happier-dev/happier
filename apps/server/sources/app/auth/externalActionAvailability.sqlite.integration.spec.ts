import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { auth, type ExternalActionExecutionAuthorizationMintInput } from './auth';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('external Action mint availability classification', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-action-availability-', initAuth: true });
    }, 120_000);
    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { await harness.close(); });

    async function fixture() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'availability', platform: 'linux' }),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: crypto.randomUUID(), installationPublicKey: Uint8Array.from(tweetnacl.sign.keyPair().publicKey),
            active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: machine.id }, input: {} };
        const input = { accountId: account.id, serverIdentityId: await getOrCreateServerIdentityId(),
            machineId: machine.id, actionId: 'settings.list', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch } } satisfies ExternalActionExecutionAuthorizationMintInput;
        return { account, machine, envelope, input };
    }

    it('classifies missing and uninstalled Machines as target unavailable while retaining valid minting', async () => {
        const { machine, input } = await fixture();
        expect(await auth.mintExternalActionExecutionAuthorization(input)).toMatchObject({ binding: { machineId: machine.id } });
        await db.machine.update({ where: { id: machine.id }, data: { installationId: null } });
        await expect(auth.mintExternalActionExecutionAuthorization(input)).rejects.toMatchObject({ code: 'target_unavailable' });
        await db.machine.delete({ where: { id: machine.id } });
        await expect(auth.mintExternalActionExecutionAuthorization(input)).rejects.toMatchObject({ code: 'target_unavailable' });
    });

    it('classifies a lost original Session target as target unavailable', async () => {
        const { account, machine, input } = await fixture();
        const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const key = await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-key' } });
        const sessionInput = { ...input, actionId: 'session.mode.set', target: { kind: 'session' as const, sessionId: session.id } };
        expect(await auth.mintExternalActionExecutionAuthorization(sessionInput)).toMatchObject({ binding: { target: sessionInput.target } });
        await db.accessKey.delete({ where: { id: key.id } });
        await expect(auth.mintExternalActionExecutionAuthorization(sessionInput)).rejects.toMatchObject({ code: 'target_unavailable' });
    });

    it('classifies a non-current Session source as target unavailable without weakening credential checks', async () => {
        const { account, machine, input } = await fixture();
        const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'opaque-key' } });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'availability-turn', callerPermissionMode: 'default', requestId: input.requestId,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
        const sourced = { ...input, sessionActionOrigin: origin,
            sessionActionSource: { machineId: machine.id, installationId: machine.installationId! } };
        // Publisher discovery is a socket transport boundary; mint and SQLite stay real.
        let publisher: string | null = machine.id;
        const context = { resolveCurrentSessionMachine: async () => publisher };
        expect(await auth.mintExternalActionExecutionAuthorization(sourced, context)).toMatchObject({ binding: { sessionActionOrigin: origin } });
        publisher = null;
        await expect(auth.mintExternalActionExecutionAuthorization(sourced, context)).rejects.toMatchObject({ code: 'target_unavailable' });
        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(auth.mintExternalActionExecutionAuthorization(sourced, context)).rejects.toMatchObject({ code: 'invalid_token' });
    });

    it('preserves retryable daemon placement when an installation disappears between admission and mint', async () => {
        const { account, machine, envelope } = await fixture();
        const io = new Server(createServer());
        const dispatch = createExternalActionDaemonDispatcher({ io,
            mintExecutionAuthorization: async (input, context) => {
                // Reproduce the concurrent database change at the existing mint seam;
                // no authorization result or internal classification is substituted.
                await db.machine.update({ where: { id: machine.id }, data: { installationId: null } });
                return auth.mintExternalActionExecutionAuthorization(input, context);
            } });
        try {
            expect(await dispatch({ actionId: 'settings.list', envelope, principal: { accountId: account.id,
                authority: 'present_user', authentication: { kind: 'account', tokenEpoch: account.tokenEpoch } } }))
                .toMatchObject({ kind: 'placement_error', code: 'target_unavailable' });
            expect(await db.machine.findUnique({ where: { id: machine.id }, select: { installationId: true } }))
                .toEqual({ installationId: null });
        } finally { await new Promise<void>(resolve => { io.close(() => resolve()); }); }
    });
});
