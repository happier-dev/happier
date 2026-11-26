import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    computeContentPublicKeyFingerprint, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    sealEncryptedDataKeyEnvelopeV1, signMachineInstallationProof } from '@happier-dev/protocol';
import { packSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { transitionMachineContentKeyInTx } from './transitionMachineContentKeyInTx';
import { createFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerMachineDaemonStateHandler } from '@/app/api/socket/machineDaemonStateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { getMachineSocketRoom } from '@/app/api/socketRooms';
import { prepareDeploymentAppMachineRevocationInTx } from '@/app/deployments/deploymentAppRevocation';

// Genuine AES-GCM fixture boundary; framing and value encoding stay protocol-owned.
function encryptFixtureContent(value: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(value), 'utf8'), cipher.final()]);
    return packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() });
}

function beforeMachineMutation(before: () => Promise<void>, boundary: 'machine-write' | 'account-serialization' = 'machine-write') {
    const transaction = db.$transaction;
    let observed = false;
    const observeBefore = (query: unknown) => observeLazyPrismaQuery(query,
        () => ({ started() {}, settled() {} }), async () => {
            if (observed) return;
            observed = true; await before();
        });
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
            get(inner, property, innerReceiver) {
                if (boundary === 'account-serialization') {
                    const member: unknown = Reflect.get(inner, property, innerReceiver);
                    if (property !== '$queryRawUnsafe' || typeof member !== 'function') return member;
                    return (query: string, ...values: unknown[]) => {
                        const pending = Reflect.apply(member, inner, [query, ...values]);
                        return query.includes('FROM "Account"') && query.endsWith('FOR NO KEY UPDATE')
                            ? observeBefore(pending) : pending;
                    };
                }
                if (property !== 'machine') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.machine, { get(model, method, modelReceiver) {
                    const member: unknown = Reflect.get(model, method, modelReceiver);
                    if (method !== 'update' && method !== 'updateMany' || typeof member !== 'function') return member;
                    return (...values: unknown[]) => observeBefore(Reflect.apply(member, model, values));
                } });
            },
        })), ...args.slice(1)]);
    } });
    return () => { db.$transaction = transaction; };
}

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Machine publication isolation (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    async function fixture() {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: 'e2ee' } });
        const dataKey = randomBytes(32);
        const old = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: encodeBase64(encryptFixtureContent({ host: 'old' }, dataKey)),
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: binding.contentPublicKey, randomBytes }),
            active: true, lastActiveAt: new Date() } });
        const replacement = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: old.metadata, dataEncryptionKey: old.dataEncryptionKey, active: true, lastActiveAt: new Date() } });
        const app = createAuthenticatedTestApp();
        app.decorate('machineDaemonPresence', createSocketRoomDiscoveryHarness(async room => [old, replacement]
            .filter(machine => room === getMachineSocketRoom(account.id, machine.id))
            .map(machine => ({ data: { clientType: 'machine-scoped', userId: account.id, machineId: machine.id } }))));
        machinesRoutes(app); await app.ready();
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        return { account, binding, old, replacement, app, headers, close: async () => {
            await app.close(); await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        } };
    }

    it.each(['revoke', 'replace', 'clear', 'presence recovery', 'automatic replacement', 'deployment revocation'] as const)(
        '%s publishes to the retained guest audience across Accounts', async operation => {
        const current = await fixture();
        const guestOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guestId = randomUUID();
        try {
            const controller = await db.machine.update({ where: { id: current.old.id }, data: {
                active: false, installationId: randomUUID(),
                ...(operation === 'clear' ? { replacedByMachineId: current.replacement.id } : {}),
            } });
            await db.machine.create({ data: { id: guestId, accountId: guestOwner.id,
                metadata: encodePlainMachineStoredContent({ host: 'guest' }),
                dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
            await db.managedMachine.create({ data: {
                homeId: `srv_${'a'.repeat(32)}`, custodianAccountId: current.account.id,
                controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
                admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'confirmed-absent',
                creationState: 'active', launch: {}, enrolledMachineId: guestId, desired: 'delete',
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } });

            let replacementId = current.replacement.id;
            if (operation === 'deployment revocation') {
                const source = await db.projectSource.create({ data: { createdByAccountId: current.account.id,
                    name: 'Controller revocation', audience: [], attachments: [] } });
                const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: current.account.id,
                    header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: controller.dataEncryptionKey! } });
                const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
                const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
                    createdByAccountId: current.account.id, controllerMachineId: current.replacement.id,
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...content } });
                const target = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                    createdByAccountId: current.account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                    targetKind: 'ownServer', state: 'configured', ...content } });
                const deployment = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: target.id,
                    requestedByAccountId: current.account.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                    operation: 'deploy', state: 'succeeded', ...content } });
                try {
                    await db.machine.update({ where: { id: controller.id }, data: { deploymentAppDeploymentId: deployment.id } });
                    await inTx(async tx => {
                        const revoke = await prepareDeploymentAppMachineRevocationInTx(tx, { environmentId: environment.id,
                            publicationAccountIds: [current.account.id] });
                        await revoke();
                    });
                } finally {
                    await db.deployment.delete({ where: { id: deployment.id } });
                    await db.deploymentTargetLink.delete({ where: { id: target.id } });
                    await db.deploymentEnvironment.delete({ where: { id: environment.id } });
                    await db.artifact.delete({ where: { id: artifact.id } });
                    await db.projectSource.delete({ where: { id: source.id } });
                }
            } else if (operation === 'automatic replacement') {
                const installation = tweetnacl.sign.keyPair();
                replacementId = randomUUID();
                const identity = { installationId: randomUUID(), replacesMachineId: controller.id, replacementReason: 'reauth' as const,
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(current.binding.contentPublicKey) };
                const response = await current.app.inject({ method: 'POST', url: '/v1/machines', headers: current.headers,
                    payload: { ...identity, id: replacementId, metadata: controller.metadata,
                        dataEncryptionKey: encodeBase64(controller.dataEncryptionKey!),
                        installationPublicKey: Buffer.from(installation.publicKey).toString('base64url'),
                        installationProof: signMachineInstallationProof({ payload: { version: 1, ...identity,
                            accountId: current.account.id, machineId: replacementId }, privateKey: installation.secretKey }) } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ machineReplacement: { status: 'applied', replacesMachineId: controller.id } });
            } else if (operation === 'presence recovery') {
                const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: controller.id,
                    [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: controller.installationId } });
                registerMachineDaemonStateHandler(current.account.id, socket as unknown as Socket);
                const handler = getSocketHandler(socket, 'machine-update-state');
                const daemonState = encodeBase64(encryptFixtureContent({ status: 'ready' }, randomBytes(32)));
                const callback = vi.fn();
                await handler({ machineId: controller.id, daemonState, expectedVersion: controller.daemonStateVersion,
                    expectedDataEncryptionKey: encodeBase64(controller.dataEncryptionKey!) }, callback);
                expect(callback).toHaveBeenCalledWith({ result: 'success', version: controller.daemonStateVersion + 1, daemonState });
            } else {
                const url = `/v1/machines/${controller.id}/${operation === 'revoke' ? 'revoke' : 'replacement'}`;
                const response = await current.app.inject({ method: operation === 'clear' ? 'DELETE' : 'POST',
                    url, headers: current.headers, ...(operation === 'replace'
                        ? { payload: { replacementMachineId: current.replacement.id } } : {}),
                });
                expect(response.statusCode, response.body).toBe(200);
            }
            const persisted = await db.machine.findUniqueOrThrow({ where: { id: controller.id } });
            if (operation === 'revoke' || operation === 'deployment revocation') expect(persisted.revokedAt).toBeInstanceOf(Date);
            else if (operation === 'presence recovery') expect(persisted.active).toBe(true);
            else expect(persisted.replacedByMachineId).toBe(operation === 'clear' ? null : replacementId);
            const recipients = await db.accountChange.findMany({ where: { kind: 'machine', entityId: guestId },
                select: { accountId: true }, orderBy: { accountId: 'asc' } });
            expect(recipients.map(recipient => recipient.accountId)).toEqual([current.account.id, guestOwner.id].sort());
        } finally {
            await db.managedMachine.deleteMany({ where: { enrolledMachineId: guestId } });
            await db.machine.deleteMany({ where: { id: guestId } });
            await db.account.delete({ where: { id: guestOwner.id } });
            await current.close();
        }
    });

    it.each(['replace', 'clear', 'revoke', 'content-key'] as const)('%s commits across a hot Account cursor', async operation => {
        const current = await fixture();
        if (operation === 'clear') await db.machine.update({ where: { id: current.old.id }, data: { replacedByMachineId: current.replacement.id } });
        const transaction = db.$transaction;
        let peerWrites = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            let advanced = false;
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return (query: string, ...values: unknown[]) => {
                        const pending = inner.$queryRawUnsafe(query, ...values);
                        if (!query.includes('FROM "Account"') || !query.includes('FOR NO KEY UPDATE')) return pending;
                        return observeLazyPrismaQuery(pending, () => ({ started() {}, settled() {} }), async () => {
                            if (advanced) return;
                            advanced = true;
                            await db.account.update({ where: { id: current.account.id }, data: { seq: { increment: 1 } } });
                            peerWrites++;
                        });
                    };
                },
            })), ...args.slice(1)]);
        } });
        try {
            const nextKey = randomBytes(32);
            const response = await current.app.inject({ method: operation === 'clear' ? 'DELETE' : 'POST',
                url: `/v1/machines/${current.old.id}/${operation === 'replace' || operation === 'clear' ? 'replacement'
                    : operation === 'content-key' ? 'content-key/transition' : 'revoke'}`, headers: current.headers,
                ...(operation === 'clear' || operation === 'revoke' ? {} : { payload: operation === 'replace'
                    ? { replacementMachineId: current.replacement.id, confirmActiveOldMachine: true }
                    : { machineId: current.old.id, expected: { dataEncryptionKey: encodeBase64(current.old.dataEncryptionKey!),
                        metadataVersion: current.old.metadataVersion, daemonStateVersion: current.old.daemonStateVersion },
                        next: { dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: nextKey,
                            recipientPublicKey: current.binding.contentPublicKey, randomBytes })),
                            metadata: encodeBase64(encryptFixtureContent({ host: 'new' }, nextKey)), daemonState: null } } }),
            });
            expect(peerWrites).toBe(1);
            expect(response.statusCode, response.body).toBe(200);
            if (operation === 'content-key') expect(response.json()).toMatchObject({ kind: 'committed' });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).toMatchObject({ seq: 2 });
        } finally { db.$transaction = transaction; await current.close(); }
    });

    it('admits only one of two reciprocal replacements', async () => {
        const current = await fixture();
        const transaction = db.$transaction;
        let release!: () => void;
        const bothAdmitted = new Promise<void>(resolve => { release = resolve; });
        let admissions = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return (query: string, ...values: unknown[]) => {
                        const pending = inner.$queryRawUnsafe(query, ...values);
                        if (!query.includes('FROM "Account"') || !query.includes('FOR ')) return pending;
                        return observeLazyPrismaQuery(pending, () => ({ started() {}, settled() {} }), async () => {
                            if (++admissions === 2) release();
                            await bothAdmitted;
                        });
                    };
                },
            })), ...args.slice(1)]);
        } });
        try {
            const responses = await Promise.all([current.old, current.replacement].map((old, index) => current.app.inject({
                method: 'POST', url: `/v1/machines/${old.id}/replacement`, headers: current.headers,
                payload: { replacementMachineId: [current.replacement, current.old][index].id, confirmActiveOldMachine: true },
            })));
            expect(admissions).toBeGreaterThanOrEqual(2);
            expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
            const rows = await db.machine.findMany({ where: { accountId: current.account.id } });
            expect(rows.filter(machine => machine.replacedByMachineId !== null)).toHaveLength(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).toMatchObject({ seq: 1 });
        } finally { release(); db.$transaction = transaction; await current.close(); }
    });

    it('requires confirmation if the old Machine becomes active before replacement writes', async () => {
        const current = await fixture();
        await db.machine.update({ where: { id: current.old.id }, data: { active: false } });
        const restore = beforeMachineMutation(async () => {
            await db.machine.update({ where: { id: current.old.id }, data: { active: true } });
        });
        try {
            const response = await current.app.inject({ method: 'POST', url: `/v1/machines/${current.old.id}/replacement`,
                headers: current.headers, payload: { replacementMachineId: current.replacement.id } });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toMatchObject({ reason: 'old_machine_active_confirmation_required' });
            expect(await db.machine.findUniqueOrThrow({ where: { id: current.old.id } })).toMatchObject({ active: true, replacedByMachineId: null });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.account.id } })).toMatchObject({ seq: 0 });
        } finally { restore(); await current.close(); }
    });

    it.each(['replace', 'revoke'] as const)('rechecks legacy-client admission when content becomes plain before %s writes', async operation => {
        const current = await fixture();
        await db.account.update({ where: { id: current.account.id }, data: { encryptionMode: 'plain' } });
        // Replacement's serializing Account lock must not be held while this
        // test awaits the peer's terminal Account publication. The route has
        // already read the encrypted basis before reaching that SQL boundary.
        const restore = beforeMachineMutation(async () => {
            expect(await inTx(tx => transitionMachineContentKeyInTx({ tx, accountId: current.account.id, input: {
                machineId: current.old.id, expected: { dataEncryptionKey: encodeBase64(current.old.dataEncryptionKey!),
                    metadataVersion: current.old.metadataVersion, daemonStateVersion: current.old.daemonStateVersion },
                next: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: encodePlainMachineStoredContent({ host: 'plain' }), daemonState: null },
            } }))).toMatchObject({ kind: 'committed' });
        }, operation === 'replace' ? 'account-serialization' : 'machine-write');
        try {
            const response = await current.app.inject({ method: 'POST',
                url: `/v1/machines/${current.old.id}/${operation === 'revoke' ? 'revoke' : 'replacement'}`,
                headers: { 'x-test-user-id': current.account.id },
                ...(operation === 'replace' ? { payload: { replacementMachineId: current.replacement.id, confirmActiveOldMachine: true } } : {}),
            });
            expect(response.statusCode, response.body).toBe(426);
            expect(await db.machine.findUniqueOrThrow({ where: { id: current.old.id } })).toMatchObject({
                revokedAt: null, replacedByMachineId: null,
            });
        } finally { restore(); await current.close(); }
    });
});
