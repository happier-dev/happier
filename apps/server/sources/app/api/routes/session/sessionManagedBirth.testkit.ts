import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import nacl from 'tweetnacl';
import { buildManagedSessionBirthProofPayloadV1, MANAGED_SESSION_BIRTH_HEADER_V1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerSessionCreateOrLoadRoute } from './registerSessionCreateOrLoadRoute';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { getMachinePreset, listMachinePresets } from '@/app/machines/managed/machinePresetService';

/** Same real HTTP → Session commit → exact lookup journey on each database provider. */
export async function exerciseManagedSessionBirth(options: Readonly<{
    measureLookup?: (read: () => Promise<void>) => Promise<void>;
}> = {}) {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
        installationId: randomUUID(), metadata: '{}' } });
    const keys = nacl.sign.keyPair();
    const guestInstallationId = randomUUID();
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}',
        installationId: guestInstallationId, installationPublicKey: Buffer.from(keys.publicKey) } });
    const homeId = await getOrCreateServerIdentityId();
    const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: account.id,
        name: 'Managed Session fixture', setup: { scripts: [{ body: 'echo setup' }] } } });
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
        admittedActionRequestId: randomUUID(), admittedInput: {}, launch: {}, retention: {}, wakeOnAcceptedMessage: false,
        allocation: 'bound', enrolledMachineId: guest.id, presetId: preset.id } });
    const managedCreation = { homeId, managedId: managed.id,
        controller: { machineId: controller.id, installationId: controller.installationId! } };
    const body = { tag: randomUUID(), metadataLayoutVersion: 1, encryptionMode: 'plain',
        sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) }, ownerMetadata: { t: 'plain', v: { v: 1 } },
        dataEncryptionKey: null, managedCreation };
    await withAuthenticatedTestApp(app => {
        registerSessionCreateOrLoadRoute(app);
        registerManagedMachineRoutes(app);
    }, async app => {
        const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
        const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
        expect(created.statusCode, created.body).toBe(200);
        const sessionId: string = created.json().session.id;
        const freshBirth = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        const readPreset = () => getMachinePreset({ accountId: account.id, input: { homeId, id: preset.id } });
        expect(await readPreset()).toMatchObject({ kind: 'found', preset: { lastUsedAt: freshBirth.createdAt.getTime() } });
        const rejoined = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
        expect(rejoined.statusCode, rejoined.body).toBe(200);
        expect(rejoined.json().session.id).toBe(sessionId);
        expect(await readPreset()).toMatchObject({ kind: 'found', preset: { lastUsedAt: freshBirth.createdAt.getTime() } });
        const unauthorized = await app.inject({ method: 'POST', url: '/v1/sessions',
            headers: { ...headers, 'x-test-user-id': outsider.id }, payload: { ...body, tag: randomUUID() } });
        expect(unauthorized.statusCode).toBe(403);
        expect(await db.session.count({ where: { accountId: outsider.id } })).toBe(0);
        // A later controller Move must not change immutable birth provenance.
        await db.managedMachine.update({ where: { id: managed.id }, data: { controllerInstallationId: randomUUID() } });
        const movedRejoin = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
        expect(movedRejoin.statusCode, movedRejoin.body).toBe(200);
        expect(movedRejoin.json().session.id).toBe(sessionId);
        await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });
        await db.session.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({
            accountId: account.id, tag: randomUUID(), metadata: 'unopenable unrelated ciphertext',
            ...(index % 2 ? { archivedAt: new Date() } : {}),
        })) });
        const lookup = (actor = account.id, home = homeId) => app.inject({ method: 'POST', url: '/v1/machines/managed/actions/birth.get',
            headers: { ...headers, 'x-test-user-id': actor }, payload: { homeId: home, managedId: managed.id } });
        const checkLookup = async () => {
            const found = await lookup();
            expect(found.statusCode, found.body).toBe(200);
            expect(found.json()).toEqual({ source: { kind: 'session', sessionId } });
        };
        if (options.measureLookup) await options.measureLookup(checkLookup);
        else await checkLookup();
        expect((await lookup(outsider.id)).json()).toEqual({ source: null });
        expect((await lookup(account.id, randomUUID())).json()).toEqual({ source: null });
        const mismatch = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
            payload: { ...body, managedCreation: { ...managedCreation, managedId: 'unrelated-resource' } } });
        expect(mismatch.statusCode).toBe(403);
        const refused = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
            payload: { ...body, tag: randomUUID() } });
        expect(refused.statusCode).toBe(403);
        const ordinary = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
            payload: { ...body, tag: randomUUID(), managedCreation: undefined } });
        expect(ordinary.statusCode, ordinary.body).toBe(200);
        const stored = await db.session.findUniqueOrThrow({ where: { id: ordinary.json().session.id } });
        expect(stored.managedCreationId).toBeNull();
        expect(await readPreset()).toMatchObject({ kind: 'found', preset: { lastUsedAt: freshBirth.createdAt.getTime() } });

        const ordinaryBody = { tag: randomUUID(), metadataLayoutVersion: 1, encryptionMode: 'plain',
            sharedMetadata: body.sharedMetadata, ownerMetadata: body.ownerMetadata, dataEncryptionKey: null };
        const proof = signMachineInstallationProof({ privateKey: keys.secretKey,
            payload: buildManagedSessionBirthProofPayloadV1({ accountId: account.id, machineId: guest.id,
                installationId: guestInstallationId, body: ordinaryBody }) });
        const signedHeaders = { ...headers, [MANAGED_SESSION_BIRTH_HEADER_V1]: JSON.stringify({ machineId: guest.id, proof }) };
        const misattributed = await app.inject({ method: 'POST', url: '/v1/sessions', headers: signedHeaders,
            payload: { ...ordinaryBody, tag: randomUUID() } });
        expect(misattributed.statusCode, misattributed.body).toBe(200);
        expect(await readPreset()).toMatchObject({ kind: 'found', preset: { lastUsedAt: freshBirth.createdAt.getTime() } });
        const admitted = await app.inject({ method: 'POST', url: '/v1/sessions', headers: signedHeaders, payload: ordinaryBody });
        expect(admitted.statusCode, admitted.body).toBe(200);
        const ordinaryBirth = await db.session.findUniqueOrThrow({ where: { id: admitted.json().session.id } });
        const latest = { id: preset.id, lastUsedAt: ordinaryBirth.createdAt.getTime() };
        expect(await readPreset()).toMatchObject({ kind: 'found', preset: latest });
        expect(await listMachinePresets({ accountId: account.id, input: { homeId } })).toMatchObject({
            kind: 'listed', presets: [latest],
        });
        expect(await listMachinePresets({ accountId: outsider.id, input: { homeId } })).toEqual({ kind: 'listed', presets: [] });
        // Multiple births retain the old recognizer's ambiguity semantics.
        await db.managedMachine.update({ where: { id: managed.id },
            data: { controllerInstallationId: managedCreation.controller.installationId } });
        const second = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
            payload: { ...body, tag: randomUUID() } });
        expect(second.statusCode, second.body).toBe(200);
        expect((await lookup()).json()).toEqual({ source: null });
    });
    await db.session.deleteMany({ where: { accountId: account.id } });
    await db.managedMachine.delete({ where: { id: managed.id } });
    await db.managedMachinePreset.delete({ where: { id: preset.id } });
    await db.machine.deleteMany({ where: { accountId: account.id } });
    await db.account.deleteMany({ where: { id: { in: [account.id, outsider.id] } } });
}
