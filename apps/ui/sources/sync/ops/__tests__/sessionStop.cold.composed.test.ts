import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountScopedCryptoMaterialSnapshotV1, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import tweetnacl from 'tweetnacl';

// Native dialog boundary: the person confirms Delete; Action admission stays real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { show: config => {
    const props = config.props as { onAnswer(confirmed: boolean): void };
    queueMicrotask(() => props.onAnswer(true));
    return 'stop-delete-review';
} } }).module);

// Keep Account admission, key hydration, Sync, store and Stop real below HTTP/Socket.IO.
const boundary = await (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')).installSessionOpsNetworkBoundary();
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { createDefaultActionExecutor } = await import('../actions/defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const initial = storage.getState();
beforeEach(async () => { boundary.resetRequests(); await loadSyncSingletonForTests(); });
afterEach(() => { storage.setState(initial, true); });
afterAll(async () => { await resetServerReachabilitySupervisors(); await boundary.dispose(); });

describe('cold Workflow Session Stop composition', () => {
    it.each((['plain', 'legacy', 'dataKey'] as const).flatMap(kind => [
        { kind, unavailable: false }, { kind, unavailable: true },
    ]))('settles an unopened Workflow Session ($kind, unavailable=$unavailable)', async ({ kind, unavailable }) => {
        const mode = kind === 'plain' ? 'plain' : 'e2ee';
        const sessionId = `cold-workflow-${kind}`;
        const accountId = `cold-stop-${kind}`;
        const secret = new Uint8Array(32).fill(17);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
        const material: AccountScopedCryptoMaterial = kind === 'dataKey'
            ? { type: 'dataKey', machineKey: secret } : { type: 'legacy', secret };
        const token = createAccountTokenForTests(accountId);
        const credentials: AuthCredentials = kind === 'plain' ? { token } : kind === 'legacy'
            ? { token, secret: encodeBase64(secret, 'base64url') }
            : { token, encryption: { publicKey: encodeBase64(publicKey, 'base64'), machineKey: encodeBase64(secret, 'base64') } };
        const home = await boundary.addHome(`https://cold-stop-${kind}.example`, accountId, {
            credentials, encryptionMode: mode, serverIdentityId: `cold-stop-home-${kind}`,
        });
        const persistence = createSessionMetadataHttpBoundary(() => ({}));
        const sourceMetadata = createSessionFixture().metadata!;
        const agentState = { controlledByUser: true, requests: {}, completedRequests: {} };
        const plain = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true, metadata: sourceMetadata });
        const record = { ...plain, agentState: JSON.stringify(agentState), origin: { kind: 'run_step' as const, runId: 'cold-workflow-run' } };
        const author = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : null;
        const dataKey = new Uint8Array(32).fill(23);
        if (author) {
            author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
            await author.initializeSessions(new Map([[sessionId, dataKey]]));
            await author.initializeMachines(new Map([['machine-1', dataKey]]));
            const owner = createSessionOwnerMetadataV1({ metadata: sourceMetadata });
            if (!owner.ok) throw new Error('Expected canonical owner metadata');
            const encrypted = SessionCurrentProjectionRecordV1Schema.parse({ ...record, encryptionMode: mode,
                metadata: await author.getSessionEncryption(sessionId)!.encryptRaw(projectSessionSharedMetadataV1({ metadata: sourceMetadata, agentState })),
                agentState: await author.getSessionEncryption(sessionId)!.encryptRaw(agentState),
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material,
                    ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(3) }),
                dataEncryptionKey: encodeBase64(await author.encryptEncryptionKey(dataKey), 'base64'),
            });
            persistence.replaceSession(sessionId, encrypted);
        } else persistence.replaceSession(sessionId, record);
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
            ...(kind === 'dataKey' ? { dataKeyPublicKey: publicKey } : {}) });
        const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId });
        const machineCipher = author?.getMachineEncryption('machine-1');
        const encryptedMachine = author && machineCipher ? {
            ...machine,
            metadata: await machineCipher.encryptMetadata(createMachineFixture().metadata!),
            dataEncryptionKey: encodeBase64(await author.encryptEncryptionKey(dataKey), 'base64'),
            access: { ...machine.access, resourceMode: 'e2ee' as const },
        } : machine;
        boundary.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (init?.method === 'DELETE') return Response.json({ error: 'Session is active' }, { status: 409 });
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, () => encryptedMachine);
            }
            if (path === '/v1/machines/machine-1') return Response.json({ machine: encryptedMachine });
            if (mode === 'e2ee' && new URL(String(input)).pathname === '/v1/account/encryption/currentness') {
                return Response.json({ mode, version: 1, signingKeyFingerprint: 'signing',
                    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            }
            return persistence.handle(input, init);
        });
        if (!unavailable) boundary.setRpcAckResponder(async request => {
            expect(request).toMatchObject({ targetId: 'machine-1', method: 'stop-session' });
            const transport = machineCipher ? { mode: 'e2ee' as const, cipher: machineCipher } : { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(transport, request.payload, `${request.targetId}:${request.method}`);
            return { ok: true, result: await socketRpcCodec.encodeResponse(transport, { status: 'stopped' }, decoded.callId) };
        });
        const foreign = createSessionFixture({ id: 'foreign-session', serverId: 'foreign-home',
            metadata: { path: '/foreign', host: 'foreign', machineId: 'foreign-machine' } });
        storage.setState({ sessions: { [foreign.id]: foreign }, sessionListRowsByServerId: { [home.id]: { [sessionId]: createSessionListRenderableSessionFixture({
            id: sessionId, serverId: home.id, active: true, encryptionMode: mode, metadataLayoutVersion: 1, metadata: null,
        }) } } });
        expect(storage.getState().sessions[sessionId]).toBeUndefined();

        const result = await createDefaultActionExecutor().execute(unavailable ? 'session.delete' : 'session.stop', { sessionId }, {
            serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        if (unavailable) {
            expect(result).toMatchObject({ ok: false, errorCode: 'session_stop_control_unavailable',
                details: { sessionId, recovery: 'retry_when_runtime_available' } });
            expect(boundary.httpRequests.filter(request => request.method === 'DELETE')).toHaveLength(1);
        } else expect(result, JSON.stringify({ result, rpc: boundary.requests.map(({ method, targetId }) => ({ method, targetId })) }))
            .toMatchObject({ ok: true, result: { sessionId, stopped: true } });
        expect(persistence.writes).toEqual([sessionId]);
        if (!unavailable) expect(boundary.requests.filter(request => request.method === 'stop-session').map(request => request.targetId)).toEqual(['machine-1']);
        // The operation's hydrated snapshot must not open or retain a detail view.
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessions[foreign.id]).toBe(foreign);
        const stored = await persistence.handle(`https://cold-stop-${kind}.example/v2/sessions/${sessionId}`)!.json();
        const persisted = SessionCurrentProjectionRecordV1Schema.parse(stored.session);
        const opened = openSessionOwnerMetadataEnvelopeV1({ envelope: persisted.ownerMetadata,
            accountMode: mode, material: mode === 'e2ee' ? material : null });
        expect(opened).toMatchObject({ ok: true, ownerMetadata: { runtime: {
            sessionExplicitStopV1: { v: 1, cause: 'explicit_stop' },
        } } });
    });
});
