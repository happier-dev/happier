import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storage';
import { enqueuePendingMessageV2, updatePendingRequestedActionV2 } from '@/sync/engine/pending/pendingQueueV2';
import { resetPendingQueueState, currentPendingEnqueueAck } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import type { SessionSubmitPort } from '@/sync/domains/session/input/types';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ensureSessionRuntimeForPendingInput } from './sessions';
import { sync } from '@/sync/sync';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';

const daemonRpc = vi.hoisted(() => vi.fn(async (_request: unknown) => ({ type: 'success', sessionId: 'session-a' })));
// The genuine process/network boundary; all pending admission and projection logic stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
installApprovalCommonModuleMocks();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeAll(loadSyncSingletonForTests);
beforeEach(() => {
    // This public submit persists custody before its HTTP enqueue. Keep that
    // owner real beneath an explicit browser persistence boundary.
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); daemonRpc.mockClear();
});

describe('accepted managed input native prerequisite', () => {
    it.each(['stopped', 'running'] as const)('preserves accepted pending custody and admits a warm consumer only for observed %s compute', async (power) => {
        const profileId = 'server-a';
        const accountId = 'wake-owner';
        await resetPendingQueueState({ serverId: profileId, accountId });
        const controller = { machineId: 'controller-a', installationId: 'installation-a' };
        const contribution = { pluginId: 'happier.machine.lima', localId: 'lima' };
        const session = createSessionFixture({
            id: 'session-a', serverId: profileId, active: false, activeAt: 1, presence: 'offline', pendingVersion: 2,
            metadata: { machineId: 'guest-a', path: '/project', flavor: 'claude', claudeSessionId: 'claude-a', claudeTranscriptPath: '/project/transcript.jsonl', host: 'guest' },
            pendingActivationAuthorization: { status: 'waiting', requestId: 'request-a', requestedAt: 10, managedWakeTargetV1: {
                homeId: 'srv_home_a', managedId: 'managed-a', enrolledMachineId: 'guest-a', expectedIntentRevision: 1,
                controller, reason: 'admitted-work',
                origin: { kind: 'session-input', session: { homeId: 'srv_home_a', sessionId: 'session-a' }, pendingRequestId: 'request-a', requestedAt: 10 },
            } },
        });
        const wireSession = SessionCurrentProjectionRecordV1Schema.parse({
            id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
            active: session.active, activeAt: session.activeAt, encryptionMode: 'plain',
            metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
            agentState: null, agentStateVersion: session.agentStateVersion, dataEncryptionKey: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, pendingVersion: session.pendingVersion, pendingCount: 0,
        });
        const paths: string[] = [];
        let admitted = false;
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://server-a', serverIdentityId: 'srv_home_a', accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async (input, init) => {
                const url = new URL(String(input));
                expect(url.origin).toBe('https://server-a');
                if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json({
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                });
                if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active') {
                    // Keep the authoritative initial list and later refreshes on
                    // the same real Session, rather than racing a store override.
                    return Response.json(V2SessionListResponseSchema.parse({
                        sessions: url.pathname.endsWith('/active') ? [] : [{
                            ...wireSession,
                            ...(admitted ? { pendingActivationAuthorization: session.pendingActivationAuthorization } : {}),
                        }], nextCursor: null, hasNext: false,
                    }));
                }
                if (!['/v2/sessions/session-a/pending', '/v2/sessions/session-a', '/v1/machines/managed/actions/get'].includes(url.pathname)) {
                    return Response.json({ error: 'not_found' }, { status: 404 });
                }
                paths.push(url.pathname);
                if (url.pathname === '/v2/sessions/session-a/pending') { admitted = true; return currentPendingEnqueueAck(init); }
                if (url.pathname === '/v2/sessions/session-a') {
                    return Response.json({ session: {
                        ...wireSession,
                        ...(admitted ? { pendingActivationAuthorization: session.pendingActivationAuthorization } : {}),
                    } });
                }
                expect(url.pathname).toBe('/v1/machines/managed/actions/get');
                return Response.json({
                    id: 'managed-a', homeId: 'srv_home_a', custodianAccountId: accountId,
                    launch: { provider: contribution, schemaVersion: 1, name: 'Guest', choices: {} },
                    resource: { contributionRef: contribution, schemaVersion: 1, value: {} },
                    controller, allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest-a',
                    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
                    observation: { observedAt: 10, availability: 'present', power, storage: 'retained', daemon: power === 'running' ? 'connected' : 'disconnected' },
                });
            },
        });
        expect(connection.home).toMatchObject({ id: profileId, serverIdentityId: 'srv_home_a' });
        await sync.refreshSessions();
        await sync.ensureSessionVisibleForMessageRoute(session.id, { forceRefresh: true, hydrateMessages: false });
        expect(storage.getState().sessions[session.id], 'real HTTP list must hydrate the submitted Session').toMatchObject({ id: session.id });
        storage.setState({ machines: { 'guest-a': createMachineFixture({ id: 'guest-a', active: true, activeAt: Date.now() }) } });
        const account = await captureLazyActionAccountContext(profileId);
        // Public invocation custody uses the configured canonical profile key,
        // not the alias by which this Home was originally added.
        const scope = account.accountLifetime.scope;
        expect(scope.accountId).toBe(accountId);
        const beforeAdmission = storage.getState().sessions[session.id];
        if (!beforeAdmission) throw new Error('Real Session route did not hydrate the submitted Session');
        expect(beforeAdmission.serverId).toBe(scope.serverId);
        expect(beforeAdmission.pendingActivationAuthorization).toBeUndefined();
        const request = (path: string, init?: RequestInit) => account.request(path, init, { includeAuth: true });
        // The accepted-input refresh uses this real authority owner. Prove its
        // authenticated Account before attributing a failure to native wake.
        await runWithServerRequestAuthorityForServerAccountScope({ scope, activeRequest: request }, async (authority) => {
            expect(authority.scope).toEqual(scope);
            expect(account.accountLifetime.isCurrent()).toBe(true);
        });
        const port: SessionSubmitPort = {
            enqueuePendingMessage: (sessionId, text, displayText, metaOverrides, options) => enqueuePendingMessageV2({
                sessionId, session: beforeAdmission, text, displayText, metaOverrides, localId: options?.localId, encryption: null,
                outboxScope: scope, request, serverWireMode: 'pending_input_v3', requestedAction: options?.requestedAction,
                resumeWhenAvailable: options?.resumeWhenAvailable, accountLifetime: account.accountLifetime,
            }),
            sendMessage: sync.sendMessage.bind(sync),
            updatePendingRequestedAction: (sessionId, localId, requestedAction) => updatePendingRequestedActionV2({ sessionId, localId, requestedAction, outboxScope: scope, request }),
            ensureSessionRuntimeForPendingInput,
            refreshSessionForSubmit: sync.refreshSessionForSubmit.bind(sync),
            isSessionTargetRemoteToActiveServer: () => false,
            isMachineReachable: (machineId) => {
                const machine = storage.getState().machines[machineId];
                return Boolean(machine && isMachineOnline(machine));
            },
        };
        try {
            const result = await submitSessionUserMessage(port, {
                sessionId: session.id, session: beforeAdmission, serverId: scope.serverId, accountLifetime: account.accountLifetime,
                text: 'Original queued input', localId: 'request-a', configuredMode: 'agent_queue',
                sessionInactiveResumePolicy: 'online_only', resumeCapabilityOptions: {},
                resumeTargetOverride: { machineId: 'guest-a', directory: '/project' }, nowMs: 10,
            });
            expect(result.errorCode, JSON.stringify(result)).toBeUndefined();
            expect(result.errorMessage, JSON.stringify(result)).toBeUndefined();
            expect(admitted, JSON.stringify({ result, paths })).toBe(true);
            expect(result).toMatchObject(power === 'stopped'
                ? { type: 'wake_pending', persistence: 'pending', localId: 'request-a', wake: { attempted: false, state: 'pending' } }
                : { type: 'success', persistence: 'pending', localId: 'request-a', wake: { attempted: true, state: 'started' } });
            expect(storage.getState().sessionPending[session.id]?.messages).toHaveLength(1);
            expect(storage.getState().sessionPending[session.id]?.messages[0]?.source).toBe('local_outbound');
            if (power === 'stopped') expect(daemonRpc).not.toHaveBeenCalled();
            else {
                expect(daemonRpc).toHaveBeenCalled();
                // Protected native qualification belongs to the host's read;
                // the existing guest runtime RPC must not receive this carrier.
                expect(daemonRpc.mock.calls[0]?.[0]).not.toHaveProperty('payload.pendingActivationAuthorization');
                expect(daemonRpc.mock.calls[0]?.[0]).not.toHaveProperty('payload.managedWakeTargetV1');
            }
            expect(paths).toContain('/v1/machines/managed/actions/get');
            expect(paths).toContain('/v2/sessions/session-a');
            expect(paths.indexOf('/v2/sessions/session-a/pending')).toBeLessThan(paths.lastIndexOf('/v2/sessions/session-a'));
        } finally { account.dispose(); }
    });
});
