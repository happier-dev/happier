import { randomUUID, randomBytes } from 'node:crypto';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { sealSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { buildSessionHostOnboardingInputV1 } from '@happier-dev/protocol/sessions/creation/sessionPreparedBirthV1';
import { SESSION_INPUT_REQUEST_META_KEY, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { auth } from '@/app/auth/auth';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { createFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

describe('admitted Pending requester bootstrap custody', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-pending-requester-bootstrap-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['consume', 'discard'] as const)('retains asleep birth custody privately for only its admitted installation and clears it on %s', async ending => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installation = tweetnacl.sign.keyPair();
        const publishedMachineMetadata = encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier' });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(installation.publicKey), active: false,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
            metadata: publishedMachineMetadata,
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: requester.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved', readiness: 'ready' });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: requester.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-session-machine-binding' } });
        const homeId = await getOrCreateServerIdentityId();
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const input = SessionSpawnNewInputV2Schema.parse({ creationKey: randomUUID(),
            executionTarget: { serverId: homeId, machineId: machine.id }, directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
        const sealed = sealSessionRequesterBootstrapRpcRequestV1({ request: {
            kind: 'requester_session_bootstrap_v1', input,
            requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token },
                sessionId: session.id, sessionCreationDisposition: 'created' },
        }, installationId: machine.installationId!, installationPublicKey: installation.publicKey,
            randomBytes: length => new Uint8Array(randomBytes(length)) });
        const onboarding = buildSessionHostOnboardingInputV1({ templateName: 'Recipient Bot', templateVersion: '1.0.0' });
        const localId = `plugin-input-v1:${encodeBase64(randomBytes(32), 'base64url')}`;
        const request = { v: 1, sessionId: session.id, targetMachineId: machine.id, localId,
            requesterBootstrap: sealed.requesterBootstrap,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: onboarding.initialInput.text },
                meta: { ...onboarding.meta, source: 'ui', [SESSION_MESSAGE_PROVENANCE_META_KEY]: onboarding.inputAdmission.provenance,
                    [SESSION_INPUT_REQUEST_META_KEY]: onboarding.inputAdmission.request } } },
            requestedAction: { v: 1, kind: 'send_now' } };

        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending/template-onboarding`,
                headers: { authorization: `Bearer ${token}` }, payload: { request } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ v: 1, result: { status: 'accepted', localId } });
            const ordinary = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/pending`,
                headers: { authorization: `Bearer ${token}` } });
            expect(ordinary.statusCode).toBe(200);
            expect(ordinary.body.includes(sealed.requesterBootstrap.ciphertext)).toBe(false);

            const invoke = async (installationId: string, payload: unknown, socketMachineId = machine.id) => {
                const socket = createFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
                    data: { clientType: 'machine-scoped', machineId: socketMachineId, authAuthority: 'present_user',
                        [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId } });
                // The authenticated socket is the system boundary; admission and storage remain real.
                machineUpdateHandler(custodian.id, socket as unknown as Socket, {
                    operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
                });
                let result: unknown;
                await getSocketHandler(socket, 'session-pending-requester-bootstrap-v1')(payload,
                    (value: unknown) => { result = value; });
                return result;
            };
            const wrongInstallation = await invoke(randomUUID(), { v: 1, operation: 'list' });
            expect(wrongInstallation && typeof wrongInstallation === 'object'
                ? Reflect.get(wrongInstallation, 'ok') : undefined).toBe(false);
            expect(JSON.stringify(wrongInstallation).includes(sealed.requesterBootstrap.ciphertext)).toBe(false);
            const otherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
                installationId: randomUUID(), installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
                metadata: publishedMachineMetadata,
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
            const anotherTarget = await invoke(otherMachine.installationId!, { v: 1, operation: 'list' }, otherMachine.id);
            expect(JSON.stringify(anotherTarget).includes(sealed.requesterBootstrap.ciphertext)).toBe(false);
            const retained = await invoke(machine.installationId!, { v: 1, operation: 'list' });
            expect(JSON.stringify(retained).includes(sealed.requesterBootstrap.ciphertext)).toBe(true);
            expect(JSON.stringify(retained).includes(token)).toBe(false);
            if (ending === 'consume') {
                const acknowledged = await invoke(machine.installationId!, { v: 1, operation: 'consume', sessionId: session.id,
                    requestId: localId });
                expect(acknowledged && typeof acknowledged === 'object' ? Reflect.get(acknowledged, 'ok') : undefined).toBe(true);
            } else {
                const discarded = await app.inject({ method: 'POST',
                    url: `/v2/sessions/${session.id}/pending/${encodeURIComponent(localId)}/discard`,
                    headers: { authorization: `Bearer ${token}` }, payload: { reason: 'cancelled' } });
                expect(discarded.statusCode).toBe(200);
            }
            const consumed = await invoke(machine.installationId!, { v: 1, operation: 'list' });
            expect(JSON.stringify(consumed).includes(sealed.requesterBootstrap.ciphertext)).toBe(false);
            const retainedRow = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: session.id } });
            expect(retainedRow.status).toBe(ending === 'consume' ? 'queued' : 'discarded');
            expect(Reflect.get(retainedRow, 'requesterBootstrap')).toBeNull();
        }, { authentication: 'real' });
    });
});
