import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { getSocketHandler } from '@/app/api/testkit/socketHarness';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { auth } from '@/app/auth/auth';
import { deletePendingMessage, enqueuePendingMessage, materializeNextPendingMessage, updatePendingRequestedAction, listPendingResetStartsForSource } from './pendingMessageService';

const authentication = createPresentUserSessionAccessAuthentication();
const reset = {
    source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } },
    recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted-history-entry', observedAtMs: 1000 },
} as const;
const held = { v: 1, kind: 'reset_start', reset } as const;

describe('Pending reset start custody (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-pending-reset-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_SERVER_IDENTITY_ID: 'srv_01234567890123456789012345678901' } }); }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture(supported = true) {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, ...(supported ? { sessionPendingResetStart: { protocolVersions: [1] } } : {}) },
            operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'key' }))).toMatchObject({ ok: true });
        const localId = randomUUID();
        const params = { actorUserId: account.id, authentication, sessionId: session.id, localId };
        expect(await enqueuePendingMessage({ ...params, targetMachineId: machine.id, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'existing input' } } } })).toMatchObject({ ok: true });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: account.id, sessionId: session.id, machineId: machine.id };
        const registration = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registration.status !== 'registered') throw new Error('Publisher not registered');
        const claim = { actorUserId: account.id, sessionId: session.id, deliveryState: 'provider', foregroundState: 'ready', deliveryTiming: 'after_foreground_ready',
            publisherAuthority: { ...binding, committedFence: registration.committedFence } } as const;
        return { params, claim, machine, session };
    }

    it('holds the exact admitted input until an exact binding release, without another enqueue', async () => {
        const f = await fixture();
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true, requestedAction: held });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ ok: true, didMaterialize: false, deferredReason: 'waiting_for_quota_reset' });
        const different = { ...held, reset: { ...reset, witness: { ...reset.witness, id: 'other-window' } } };
        const automaticResetReleaseTarget = { machineId: f.machine.id, installationId: f.machine.installationId! };
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: { v: 1, kind: 'enqueue' }, expectedRequestedAction: different })).toMatchObject({ ok: false, error: 'action-conflict' });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: { v: 1, kind: 'enqueue' }, expectedRequestedAction: held })).toMatchObject({ ok: false, error: 'action-conflict' });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: { v: 1, kind: 'enqueue' }, expectedRequestedAction: held, automaticResetReleaseTarget })).toMatchObject({ ok: true });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ ok: true, didMaterialize: true, message: { localId: f.params.localId, providerAction: 'send' } });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: false, error: 'action-conflict' });
        expect(await deletePendingMessage({ ...f.params, withdraw: true })).toMatchObject({ ok: true, outcome: 'delivery_unknown' });
    });

    it('withdraws a held input and cannot later release it', async () => {
        const f = await fixture();
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        expect(await deletePendingMessage({ ...f.params, withdraw: true })).toMatchObject({ ok: true, outcome: 'removed' });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: { v: 1, kind: 'enqueue' }, expectedRequestedAction: held })).toMatchObject({ ok: false, error: 'not-found' });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ ok: true, didMaterialize: false });
    });

    it('refuses unsupported reset admission without changing the existing input or activation', async () => {
        const f = await fixture(false);
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: false, error: 'reset-start-unsupported' });
        const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.params.localId } } });
        expect(row.requestedAction).toEqual({ v: 1, kind: 'enqueue' });
        expect(row.deliveryState).toBeNull();
        expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).pendingActivationRequestId).toBeNull();
    });

    it('refuses a lost Machine binding before changing pending intent', async () => {
        const f = await fixture();
        await db.machine.update({ where: { id: f.machine.id }, data: { installationId: randomUUID() } });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: false, error: 'reset-start-unsupported' });
    });

    it('withholds shared Session reset authority without changing ordinary shared input support', async () => {
        const f = await fixture();
        const editor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        await db.session.update({ where: { id: f.session.id }, data: { currentStorageState: 'hosted' } });
        await db.sessionShare.create({ data: { sessionId: f.session.id, sharedByUserId: f.params.actorUserId,
            sharedWithUserId: editor.id, accessLevel: 'edit' } });
        const shared = { ...f.params, actorUserId: editor.id };
        expect(await updatePendingRequestedAction({ ...shared, requestedAction: { v: 1, kind: 'steer_now' } })).toMatchObject({ ok: true });
        expect.soft(await updatePendingRequestedAction({ ...shared, requestedAction: held })).toMatchObject({ ok: false, error: 'reset-start-unsupported' });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        expect(await listPendingResetStartsForSource({ actorUserId: editor.id, authentication, source: reset.source }))
            .toMatchObject({ entries: [{ localId: f.params.localId, authorityCurrent: false }] });
    });

    it('releases a retained requester input through its current foreign custodian without inventing Account authority', async () => {
        const f = await fixture();
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        const custodian = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.machine.id }, data: { accountId: custodian.id } });
        await db.machineAccountGrant.create({ data: { machineId: f.machine.id, accountId: f.params.actorUserId, accessLevel: 'view', createdByAccountId: custodian.id } });
        expect(await enqueuePendingMessage({ ...f.params, localId: randomUUID(), targetMachineId: f.machine.id,
            requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ordinary shared Machine input' } } } }))
            .toMatchObject({ ok: true });
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        expect(await listPendingResetStartsForSource({ actorUserId: f.params.actorUserId, authentication, source: reset.source }))
            .toMatchObject({ entries: [{ localId: f.params.localId, authorityCurrent: true }] });
        const requesterToken = await auth.createToken(f.params.actorUserId, undefined, { kind: 'account', authority: 'present_user' });
        const oldCustodianSocket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: f.machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: f.machine.installationId } }),
            { handshake: { auth: { token: requesterToken } } });
        machineUpdateHandler(f.params.actorUserId, oldCustodianSocket as unknown as Socket, { operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
        let deniedOutcome: unknown;
        await getSocketHandler(oldCustodianSocket, 'session-pending-reset-start-release-v1')({ v: 1, sessionId: f.session.id,
            localId: f.params.localId, reset }, (value: unknown) => { deniedOutcome = value; });
        expect(deniedOutcome).toMatchObject({ ok: false, reason: 'authority_unavailable' });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ didMaterialize: false, deferredReason: 'waiting_for_quota_reset' });
        const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: f.machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: f.machine.installationId } }),
            { handshake: { auth: { token } } });
        machineUpdateHandler(custodian.id, socket as unknown as Socket, { operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
        const release = getSocketHandler(socket, 'session-pending-reset-start-release-v1');
        let outcome: unknown;
        await release({ v: 1, sessionId: f.session.id, localId: f.params.localId, reset }, (value: unknown) => { outcome = value; });
        expect(outcome).toMatchObject({ ok: true, didUpdate: true });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ didMaterialize: true, message: { localId: f.params.localId } });
    });

    it('releases only through the current installed Machine socket and exact held witness', async () => {
        const f = await fixture();
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        const token = await auth.createToken(f.params.actorUserId, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: f.machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: f.machine.installationId } }),
            { handshake: { auth: { token } } });
        machineUpdateHandler(f.params.actorUserId, socket as unknown as Socket, { operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
        let outcome: unknown;
        const release = getSocketHandler(socket, 'session-pending-reset-start-release-v1');
        const payload = { v: 1, sessionId: f.session.id, localId: f.params.localId, reset };
        await release({ ...payload, reset: { ...reset, witness: { ...reset.witness, id: 'changed' } } }, (result: unknown) => { outcome = result; });
        expect(outcome).toMatchObject({ ok: false, reason: 'action_conflict' });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ didMaterialize: false });
        await release(payload, (result: unknown) => { outcome = result; });
        expect(outcome).toMatchObject({ v: 1, ok: true, didUpdate: true });
        expect(await materializeNextPendingMessage(f.claim)).toMatchObject({ didMaterialize: true, message: { localId: f.params.localId } });
    });

    it('reads source-filtered waiting metadata only under current Session access and installed-target authority', async () => {
        const f = await fixture();
        expect(await updatePendingRequestedAction({ ...f.params, requestedAction: held })).toMatchObject({ ok: true });
        const read = { actorUserId: f.params.actorUserId, authentication, source: reset.source };
        expect(await listPendingResetStartsForSource(read)).toEqual({ entries: [{ sessionId: f.session.id, localId: f.params.localId, reset, authorityCurrent: true }] });
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        expect(await listPendingResetStartsForSource({ ...read, actorUserId: outsider.id })).toEqual({ entries: [] });
        expect(await listPendingResetStartsForSource({ ...read, source: { ...reset.source, ref: { ...reset.source.ref, accountId: 'different' } } })).toEqual({ entries: [] });
        await db.machine.update({ where: { id: f.machine.id }, data: { installationId: randomUUID() } });
        expect(await listPendingResetStartsForSource(read)).toMatchObject({ entries: [{ localId: f.params.localId, authorityCurrent: false }] });
        expect(await deletePendingMessage({ ...f.params, withdraw: true })).toMatchObject({ outcome: 'removed' });
        expect(await listPendingResetStartsForSource(read)).toEqual({ entries: [] });
    });
});
