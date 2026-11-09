import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { acquireSpawnAttemptCustody, markSpawnAttemptCreated, readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import { createSpawnAttemptKeyForSessionSpawnNewInput } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

const http = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(http);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { buildManualSessionCreationKey, executeManualSessionSpawnNewAction } = await import('./sessionSpawnNewAction');
const { disconnectActiveServerConnection, switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');

let serverId: string;
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
const userAttemptId = 'attempt-with-lost-ack';
const creationKey = buildManualSessionCreationKey(userAttemptId);
const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
const firstTurnLocalId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: tag });
const failure = { ok: false as const, errorCode: 'action_failed', error: 'Action acknowledgement unavailable' };

async function installCreationCandidates(ids: readonly string[], archivedAt: number | null = null, onLookup?: () => void) {
    const sessions = Object.fromEntries(ids.map(id => [id, createSessionFixture({ id, serverId })]));
    const boundary = createSessionMetadataHttpBoundary(() => sessions);
    const rows = await Promise.all(ids.map(async id => {
        const response = boundary.handle(`https://start-reconcile.test/v2/sessions/${id}`);
        if (!response) throw new Error('Canonical Session fixture unavailable');
        const body = V2SessionByIdResponseSchema.parse(await response.json());
        return { ...body.session, archivedAt };
    }));
    http.answer(serverId, '/v2/sessions/lookup-by-tags', { select: input => {
        expect(SessionLookupByTagsRequestV2Schema.parse(input)).toEqual({ tags: [tag] });
        onLookup?.();
        return { body: SessionLookupByTagsResponseV2Schema.parse({ sessions: rows }) };
    } });
}

function authoredInput(): Parameters<typeof executeManualSessionSpawnNewAction>[0] {
    return {
        creationKey, executionTarget: { serverId, machineId: 'selected-machine' },
        directory: { kind: 'path', path: '/work/project' }, organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        initialInput: { text: 'Please inspect this project' },
    };
}

function start(executeAction: NonNullable<Parameters<typeof executeManualSessionSpawnNewAction>[2]['executeAction']>,
    observation?: Parameters<typeof executeManualSessionSpawnNewAction>[2]['observation'],
    directory = authoredInput().directory) {
    return executeManualSessionSpawnNewAction({ ...authoredInput(), directory }, { surface: 'ui', actionRequestId: userAttemptId }, {
        scope: { serverId, accountId: 'original-account' }, machineHomeDir: '/home/tester', userAttemptId,
        seedNonce: 'original-spawn-nonce', sourceAccountLifetime: account!.accountLifetime, executeAction, observation,
    });
}

beforeEach(async () => {
    actionOperationStore.reset();
    getPersistenceStorage().clearAll();
    await http.reset();
    installHomeGovernanceBoundaries(http);
    serverId = await http.addHome({ name: 'Start Home', serverUrl: 'https://start-reconcile.test', accountId: 'original-account', currentAccount: true });
    setRuntimeFetch(http.request);
    http.answer(serverId, '/v1/auth/ping', { body: {} });
    await switchConnectionToActiveServer();
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => {
    actionOperationStore.reset();
    account?.dispose(); account = undefined;
    await disconnectActiveServerConnection();
    resetRuntimeFetch();
    await http.reset();
    getPersistenceStorage().clearAll();
});

describe('manual Start acknowledgement reconciliation', () => {
    it.each(['MACHINE_RPC_TIMEOUT', RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'outcome_unknown'])(
        'finds the created Session after a typed %s without issuing another launch', async errorCode => {
        await installCreationCandidates(['created-before-timeout']);
        http.answer(serverId, `/v2/sessions/created-before-timeout/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`,
            { status: 404, body: {} });
        const execute = vi.fn(async () => ({ ok: false as const, errorCode, error: errorCode }));
        await expect(start(execute, undefined, { kind: 'managed' })).resolves.toMatchObject({ status: 'executed',
            action: { ok: true, result: { type: 'success', sessionId: 'created-before-timeout',
                initialInput: { status: 'outcomeUnknown', localId: firstTurnLocalId } } },
            custody: { createdSessionId: 'created-before-timeout' } });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it.each(['returned', 'thrown'] as const)('retains an unconfirmed %s timeout as a saved launch when no Session can be found', async kind => {
        await installCreationCandidates([]);
        const execute = vi.fn(async () => {
            if (kind === 'thrown') throw Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' });
            return { ok: false as const, errorCode: 'MACHINE_RPC_TIMEOUT', error: 'Machine RPC call timeout' };
        });
        await expect(start(execute, undefined, { kind: 'managed' })).resolves.toMatchObject({ status: 'executed',
            action: { ok: true, result: { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true } },
            custody: { createdSessionId: null, nonce: 'original-spawn-nonce', submissionState: 'submitted' } });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(1);
    });

    it('keeps a proven pre-effect timeout definitive instead of finding an unrelated later creation', async () => {
        await installCreationCandidates(['created-session']);
        const notIssued = { ok: false as const, errorCode: 'MACHINE_RPC_TIMEOUT', error: 'Machine RPC call timeout', effectAttempted: false };
        await expect(start(async () => notIssued)).resolves.toMatchObject({ status: 'executed', action: notIssued });
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('keeps a committed receipt unknown until same-key native settlement, including the later typed refusal', async () => {
        await installCreationCandidates(['committed-before-native']);
        const pending = { ok: true as const, result: { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'unknown' as const } };
        const refused = { ok: true as const, result: { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
            launchError: { kind: 'launch_error' as const, code: 'connected_service_credential_reconnect_required', message: 'connected_service_credential_reconnect_required' } } };
        const execute = vi.fn<NonNullable<Parameters<typeof start>[0]>>().mockImplementationOnce(async (_input, _context, observation) => {
            await observation?.onCommitted?.({ sessionId: 'committed-before-native', executionTarget: authoredInput().executionTarget });
            return pending;
        }).mockResolvedValueOnce(refused);
        const observation = { operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted: () => {} };
        const first = await start(execute, observation);
        expect(first).toMatchObject({ status: 'executed', action: pending, custody: { createdSessionId: 'committed-before-native' } });
        const retried = await start(execute);
        expect(retried).toMatchObject({ status: 'executed', action: refused, custody: { createdSessionId: 'committed-before-native' } });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls.map(([input]) => input.creationKey)).toEqual([creationKey, creationKey]);
        const retained = readSpawnAttemptCustodyState({ serverId, accountId: 'original-account' });
        expect(retained.status === 'valid' && Object.values(retained.attempts)).toEqual([
            expect.objectContaining({ createdSessionId: 'committed-before-native', nonce: 'original-spawn-nonce', firstTurnLocalId }),
        ]);
    });

    it('does not replace a retained committed receipt\'s canonical failure with a matching inventory row', async () => {
        const scope = { serverId, accountId: 'original-account' };
        const acquired = await acquireSpawnAttemptCustody({ scope, machineId: 'selected-machine', userAttemptId,
            targetFingerprint: createSpawnAttemptKeyForSessionSpawnNewInput(authoredInput(), '/home/tester'),
            seedNonce: 'original-spawn-nonce', submissionState: 'submitted' });
        if (acquired.status !== 'acquired') throw new Error('Expected manual custody');
        await markSpawnAttemptCreated({ ...acquired.record, createdSessionId: 'committed-before-native' });
        await installCreationCandidates(['committed-before-native']);
        const refused = { ok: false as const, errorCode: 'native_startup_refused', error: 'native_startup_refused' };
        const execute = vi.fn(async () => refused);
        await expect(start(execute)).resolves.toMatchObject({ status: 'executed', action: refused,
            custody: { createdSessionId: 'committed-before-native', nonce: 'original-spawn-nonce' } });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('dispatches recovered prepared custody without treating it as an already-submitted creation', async () => {
        const scope = { serverId, accountId: 'original-account' };
        await acquireSpawnAttemptCustody({ scope, machineId: 'selected-machine', userAttemptId,
            targetFingerprint: createSpawnAttemptKeyForSessionSpawnNewInput(authoredInput(), '/home/tester'),
            seedNonce: 'prepared-before-reload' });
        // If promotion loses the previous phase, this real lookup would suppress
        // dispatch by reconciling a creation that the prepared attempt never sent.
        await installCreationCandidates(['created-session']);
        const accepted = { ok: true as const, result: {
            type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const,
        } };
        const execute = vi.fn(async () => accepted);
        expect(await start(execute)).toMatchObject({ status: 'executed', action: accepted,
            custody: { nonce: 'prepared-before-reload', submissionState: 'submitted' } });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('rejoins an accepted operation from submitted custody without reading Session existence or spawning again', async () => {
        const accepted = { ok: true as const, result: {
            type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const,
        } };
        const execute = vi.fn(async () => accepted);
        await start(execute);
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1,
            operationId: 'running-start', revision: 1, actionId: 'session.spawn_new', state: 'running',
            requestId: creationKey, scope: { accountId: 'original-account', machineId: 'selected-machine' },
            title: 'Create session', createdAt: 1, startedAt: 2, cancellation: 'supported',
        }] });
        await installCreationCandidates(['created-session']);
        expect(await start(execute)).toMatchObject({ status: 'executed', action: accepted });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('keeps an accepted start pending while its Session exists but first-input admission is still running', async () => {
        await installCreationCandidates(['created-session']);
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { status: 404, body: {} });
        const accepted = { ok: true as const, result: {
            type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const,
        } };

        const settled = await start(async () => accepted);

        expect(settled).toMatchObject({ status: 'executed', action: accepted });
        // The live start owner still holds admission. A committed Session row
        // alone cannot turn that pending work into a first-input warning.
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('recovers an unknown legacy acknowledgement once and then follows canonical settlement for the known creation', async () => {
        await installCreationCandidates(['created-session']);
        const message = SessionMessageV1Schema.parse({ id: 'first-message', seq: 1, localId: firstTurnLocalId,
            messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Please inspect this project' } } },
            createdAt: 1, updatedAt: 1 });
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { body: { message } });
        // The presentation host's execution boundary loses its acknowledgement;
        // Account capture, HTTP reads, schemas and durable custody stay real.
        const executeAction = vi.fn<NonNullable<Parameters<typeof start>[0]>>(async () => failure);
        const settled = await start(executeAction);
        expect(settled).toMatchObject({ status: 'executed', custody: { createdSessionId: 'created-session' },
            action: { ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'created-session',
                initialInput: { status: 'alreadyAccepted', localId: firstTurnLocalId } } } });
        if (settled.status !== 'executed' || !settled.action.ok) throw new Error('Expected reconciled creation');
        expect(SessionSpawnNewResultV1Schema.parse(settled.action.result)).toEqual(settled.action.result);
        // After creation is known, even this legacy recovery returns to the
        // same owner instead of substituting inventory for its terminal result.
        executeAction.mockResolvedValueOnce(settled.action);
        expect(await start(executeAction)).toMatchObject({ status: 'executed',
            action: { ok: true, result: { sessionId: 'created-session' } } });
        expect(executeAction).toHaveBeenCalledTimes(2);
        expect(executeAction.mock.calls.map(([input]) => input.creationKey)).toEqual([creationKey, creationKey]);
        const persisted = readSpawnAttemptCustodyState({ serverId, accountId: 'original-account' });
        expect(persisted.status === 'valid' ? Object.values(persisted.attempts)[0]?.createdSessionId : null).toBe('created-session');
    });

    it('preserves created-session custody without claiming that a missing first-input receipt was accepted', async () => {
        await installCreationCandidates(['created-session']);
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { status: 404, body: {} });
        expect(await start(async () => failure)).toMatchObject({ status: 'executed', custody: { createdSessionId: 'created-session' },
            action: { ok: true, result: { sessionId: 'created-session', initialInput: { status: 'outcomeUnknown', localId: firstTurnLocalId } } } });
    });

    it.each(['missing', 'archived', 'ambiguous'] as const)('keeps the original failure when lookup is %s', async kind => {
        await installCreationCandidates(kind === 'missing' ? [] : kind === 'ambiguous' ? ['first', 'second'] : ['archived'], kind === 'archived' ? 2 : null);
        expect(await start(async () => failure)).toMatchObject({ status: 'executed', action: failure, custody: { createdSessionId: null } });
    });

    it('never reconciles a definitive authorization refusal into success', async () => {
        await installCreationCandidates(['created-session']);
        const denied = { ok: false as const, errorCode: 'permission_denied', error: 'Not permitted' };
        expect(await start(async () => denied)).toMatchObject({ status: 'executed', action: denied });
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('does not read or disclose a reconciliation after the originating Account lifetime retires', async () => {
        await installCreationCandidates(['created-session']);
        account!.dispose();
        const cancellation = new AbortController();
        account = await captureLazyActionAccountContext(serverId, cancellation.signal);
        expect(await start(async () => { cancellation.abort(); return failure; })).toMatchObject({ status: 'executed', action: failure });
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('rechecks originating Account admission after the submitted-attempt lookup before issuing another Action', async () => {
        account!.dispose();
        const cancellation = new AbortController();
        account = await captureLazyActionAccountContext(serverId, cancellation.signal);
        await installCreationCandidates([]);
        const executeAction = vi.fn(async () => failure);
        expect(await start(executeAction)).toMatchObject({ status: 'executed', action: failure });
        await installCreationCandidates(['created-session'], null, () => cancellation.abort());
        expect(await start(executeAction)).toMatchObject({ status: 'executed',
            action: { ok: false, errorCode: 'action_account_scope_changed' } });
        expect(executeAction).toHaveBeenCalledTimes(1);
    });
});
