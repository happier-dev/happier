import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { socketRpcCodec } from '@happier-dev/sync-client';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { sendPendingMessageWithIntent } from '@/components/sessions/pending/pendingMessageSendActions';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPendingMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodeBase64 } from '@/encryption/base64';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';

vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const boundary = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

beforeEach(() => {
    boundary.resetRequests();
    vi.mocked(Modal.alert).mockClear();
    vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => boundary.dispose());

describe('Send now on an inactive shared Session', () => {
    it.each(['guest-sent', 'owner-sent', 'view-only', 'wake-refused'] as const)('settles Send now for %s', async (outcome) => {
        const owner = outcome === 'owner-sent';
        const sent = outcome === 'guest-sent' || owner;
        const level = owner ? 'owner' : outcome === 'view-only' ? 'view' : 'edit';
        const serverUrl = 'https://guest-pending-wake.example.test';
        const serverIdentityId = 'srv_guest_pending_wake';
        const accountId = owner ? 'session-owner' : 'pending-recipient';
        const machineId = 'owner-machine';
        const sessionId = 'shared-session';
        const credentials = {
            token: createAccountTokenForTests(accountId, { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url'),
        };
        const author = await createEncryptionFromAuthCredentials(credentials);
        const sessionKey = new Uint8Array(32).fill(23);
        await author.initializeSessions(new Map([[sessionId, sessionKey]]));
        const cipher = author.getSessionEncryption(sessionId);
        if (!cipher) throw new Error('Expected recipient Session reader');
        const access = createSessionAccessFixture(level);
        const session = createSessionFixture({
            id: sessionId, encryptionMode: 'e2ee', access, pendingVersion: 2, pendingCount: 1,
            metadata: { machineId, host: 'owner-host', path: '/project', flavor: 'claude', claudeSessionId: 'native-session' },
        });
        const wireSession = SessionCurrentProjectionRecordV1Schema.parse({
            ...session,
            metadataLayoutVersion: 0, metadata: await cipher.encryptMetadata(session.metadata!),
            dataEncryptionKey: encodeBase64(await author.encryptEncryptionKey(sessionKey)),
            share: level === 'owner' ? null : { accessLevel: level, canApprovePermissions: false },
            effectiveAccess: { v: 1, level, capabilities: access.capabilities,
                sources: owner ? [{ kind: 'owner' }] : [{ kind: 'direct', shareId: 'session-share' }] },
            responsibleAccountId: null, responsibleAccount: null,
        });
        const localId = 'queued-original';
        const original = createPendingMessageFixture({ localId, source: 'server_pending', deliveryStatus: 'accepted' });
        let acceptedOriginal: string | undefined;
        const delivered: string[] = [];
        const guestWakes: string[] = [];
        if (owner) {
            await author.initializeMachines(new Map([[machineId, null]]));
            const machineCipher = author.getMachineEncryption(machineId);
            if (!machineCipher) throw new Error('Expected owner Machine cipher');
            const codec = { mode: 'e2ee' as const, cipher: machineCipher };
            boundary.setRpcResponder(async request => {
                expect(request.targetId).toBe(machineId);
                const decoded = await socketRpcCodec.decodeRequestParams(codec, request.payload, `${request.targetId}:${request.method}`);
                expect(decoded.params).toMatchObject({ sessionId, executionAuthorization: { requestId: localId } });
                expect(acceptedOriginal).toBe(localId);
                delivered.push(localId);
                return socketRpcCodec.encodeResponse(codec, { type: 'success', sessionId }, decoded.callId);
            });
        }
        const resume = await createExternalActionAccountHttpBoundary({
            serverUrl, serverIdentityId, accountId, machineId,
            ...(owner ? {} : { custodian: { accountId: 'session-owner', displayName: 'Owner' } }),
            actionId: 'session.open', tokenEpoch: 0, encryption: author, requesterInvocation: 'credentials',
            execute(input, context) {
                expect(input).toMatchObject({ sessionId, intent: 'resume' });
                expect(context.requestId).toBe(localId);
                expect(acceptedOriginal).toBe(localId);
                guestWakes.push(localId);
                if (outcome === 'wake-refused') return null;
                delivered.push(localId);
                return { status: 'opened', sessionId, serverId: serverIdentityId };
            },
            failure: () => outcome === 'wake-refused'
                ? { errorCode: 'content_unavailable', error: 'The receiving Machine could not open the session content' }
                : null,
        });
        const connection = await restoreServerAccountForTest({
            serverUrl, serverIdentityId, accountId, credentials,
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') {
                    return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
                }
                if (url.pathname === `/v2/sessions/${sessionId}`) return Response.json({ session: wireSession });
                if (url.pathname === `/v2/sessions/${sessionId}/pending/${original.localId}/action`) {
                    if (!access.capabilities.submitAgentInput) return Response.json({ error: 'session-not-found' }, { status: 404 });
                    expect(init?.method).toBe('PATCH');
                    expect(JSON.parse(String(init?.body))).toEqual({ requestedAction: { v: 1, kind: 'send_now' } });
                    acceptedOriginal = original.localId;
                    return Response.json({ didUpdate: true, requestedAction: { v: 1, kind: 'send_now' } });
                }
                const action = await resume.handle(url, init);
                if (!owner && action && url.pathname.startsWith('/v1/machines')) {
                    // A recipient has installation routing information, but no Machine key.
                    const machine = { ...resume.machine, metadata: null, dataEncryptionKey: null };
                    if (url.pathname === '/v1/machines') return Response.json([machine]);
                    if (url.pathname === `/v1/machines/${machineId}`) return Response.json({ machine });
                }
                return action ?? createEmptyAccountBootstrapHttpResponse(url.pathname, init);
            }),
        });
        try {
            await sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, hydrateMessages: false });
            expect(storage.getState().sessions[sessionId]?.access?.level).toBe(level);
            if (!owner) expect(sync.encryption?.getMachineEncryption(machineId)).toBeFalsy();
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Expected a restored Account');
            storage.getState().upsertPendingMessage(sessionId, { ...original, pendingOutboxScope: lifetime.scope });

            const executor = createDefaultActionExecutor();
            const execute = vi.spyOn(executor, 'execute');
            await sendPendingMessageWithIntent({
                sessionId, serverId: lifetime.scope.serverId, expectedAccountId: accountId, executor,
                session: storage.getState().sessions[sessionId] ?? null, message: original, deliveryIntent: 'interrupt_and_send',
            });
            expect(execute).toHaveBeenCalledOnce();
            const result = await execute.mock.results[0]?.value;
            if (sent) {
                expect(result, result?.ok === false ? result.error : undefined).toMatchObject({ ok: true, result: { type: 'retry_scheduled' } });
                expect(Modal.alert).not.toHaveBeenCalled();
            } else {
                const errorCode = outcome === 'view-only' ? 'session-not-found' : 'content_unavailable';
                expect(result).toMatchObject({ ok: false, errorCode });
                expect(Modal.alert).toHaveBeenCalledExactlyOnceWith(expect.any(String), result?.ok === false ? result.error : undefined);
            }
            expect(guestWakes).toEqual(owner || outcome === 'view-only' ? [] : [localId]);
            expect(delivered).toEqual(sent ? [localId] : []);
            const ownerWakes = boundary.requests.filter(({ method }) =>
                method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
            expect(ownerWakes).toHaveLength(owner ? 1 : 0);
        } finally {
            await connection.dispose();
        }
    });
});
