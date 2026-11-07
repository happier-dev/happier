import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    RPC_ERROR_CODES} from '@happier-dev/protocol/rpcErrors';
import {
    SessionCreationKeyV1Schema} from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import {
    type SessionSpawnNewResultV1} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import {
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
    acquireSpawnAttemptCustody,
    readSpawnAttemptCustodyState,
    settleSpawnAttemptCustodyFromActionOperation,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { readNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts, clearNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveSessionSpawnNewResultFailureMessageKey } from './sessionSpawnFailurePresentation';

const frontDoorExecute = vi.fn<(...args: Parameters<import('./frontDoorRuntimeActionExecutor').FrontDoorActionExecute>) => Promise<ActionExecuteResult>>();

import {
    buildManualSessionCreationKey,
    completeManualSessionSpawnNewActionCustody,
    executeManualSessionSpawnNewAction as executeManualSessionSpawnNewActionImpl,
    executeSessionSpawnNewAction as executeSessionSpawnNewActionImpl,
    readCommittedSessionSpawnNewActionResult,
    type StrictSessionSpawnNewInput,
    type SessionSpawnNewActionResult,
} from './sessionSpawnNewAction';

// An embedding host can supply its own Action executor. Hold that public
// system boundary while the front door, strict parsing and custody stay real.
const executeSessionSpawnNewAction = (...args: Parameters<typeof executeSessionSpawnNewActionImpl>) =>
    executeSessionSpawnNewActionImpl(args[0], args[1], { execute: frontDoorExecute }, args[3]);
const executeManualSessionSpawnNewAction = (...args: Parameters<typeof executeManualSessionSpawnNewActionImpl>) =>
    executeManualSessionSpawnNewActionImpl(args[0], args[1], {
        ...args[2], executeAction: args[2].executeAction ?? ((input, context, observation) =>
            executeSessionSpawnNewAction(input, context, undefined, observation)),
    });

const input: StrictSessionSpawnNewInput = {
    creationKey: SessionCreationKeyV1Schema.parse('new-session-attempt-1'),
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: { kind: 'path', path: '/work/project' },
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
};

const result: SessionSpawnNewResultV1 = {
    type: 'success',
    disposition: 'created',
    sessionId: 'session-created',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    organizationPlacement: { folderId: null, tagIds: [] },
    initialInput: { status: 'notRequested' },
};

beforeEach(() => frontDoorExecute.mockReset());

function observeCommittedTerminal(action: ActionExecuteResult): ActionExecuteResult {
    if (!action.ok) return action;
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'commit-operation', revision: 3,
        actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: 'account-1', machineId: input.executionTarget.machineId },
        requestId: 'commit-observer', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
        cancellation: 'supported', result: action.result };
    return { ok: true, result: { kind: 'found', operation } };
}

describe('executeSessionSpawnNewAction tracking', () => {
    it.each([undefined, { sessionSpawn: { protocolVersions: [1, 2] } }, { sessionSpawn: { protocolVersions: [3] } }])(
        'keeps the terminal request unchanged without supported committed observation (%j)', async operationProtocolCapabilities => {
            const onCommitted = vi.fn();
            frontDoorExecute.mockResolvedValue({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
            await expect(executeSessionSpawnNewAction(input, { surface: 'ui' }, undefined, {
                operationProtocolCapabilities, onCommitted,
            })).resolves.toEqual({ ok: true, result });
            expect(frontDoorExecute.mock.calls.map(([actionId, value]) => ({ actionId, value })))
                .toEqual([{ actionId: 'session.spawn_new', value: projectSessionSpawnNewActionInputV2(input) }]);
            expect(onCommitted).not.toHaveBeenCalled();
        },
    );

    it('requests the committed receipt only for an explicitly opted observer of a supporting Machine', async () => {
        frontDoorExecute.mockResolvedValue({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
        const operationProtocolCapabilities = { sessionSpawn: { protocolVersions: [1, 2, 3] } };
        await executeSessionSpawnNewAction(input, { surface: 'ui' }, undefined, {
            operationProtocolCapabilities, onCommitted: () => {},
        });
        expect(frontDoorExecute.mock.calls.map(([actionId, value]) => ({ actionId, value })))
            .toEqual([{ actionId: 'session.spawn_new', value: {
                ...projectSessionSpawnNewActionInputV2(input), observeSessionCommit: true,
            } }]);
        frontDoorExecute.mockClear();
        await executeSessionSpawnNewAction(input, { surface: 'ui' }, undefined, { operationProtocolCapabilities });
        expect(frontDoorExecute.mock.calls[0]?.[1]).toEqual(projectSessionSpawnNewActionInputV2(input));
    });

    it('does not inherit another observer\'s flag or present an unsolicited committed field', async () => {
        const onCommitted = vi.fn();
        const terminal: ActionOperationSnapshotV1 = { version: 1, operationId: 'legacy-operation', revision: 3,
            actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: 'account-1', machineId: 'machine-1' },
            requestId: 'legacy-request', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            result: projectSessionSpawnNewActionResultV1(result) };
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
            sessionId: result.sessionId, operation: { ...input.executionTarget, operationId: terminal.operationId } } })
            .mockResolvedValueOnce({ ok: true, result: { kind: 'found', operation: terminal } });
        try {
            await expect(executeSessionSpawnNewAction({ ...input, observeSessionCommit: true }, { surface: 'ui', expectedAccountId: 'account-1' }, undefined, {
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2] } }, onCommitted,
            })).resolves.toEqual({ ok: true, result });
            expect(onCommitted).not.toHaveBeenCalled();
            expect(frontDoorExecute.mock.calls.map(([actionId]) => actionId)).toEqual(['session.spawn_new', 'action.operations.get']);
            expect(frontDoorExecute.mock.calls[0]?.[1]).toEqual(projectSessionSpawnNewActionInputV2(input));
        } finally {
            actionOperationStore.reset();
        }
    });

    it.each(['presented', 'unavailable'] as const)(
        'keeps one held exact-operation observation after committed presentation is %s', async presentation => {
            const committed = createDeferred<void>();
            const rejoined = createDeferred<void>();
            const terminal = createDeferred<ActionExecuteResult>();
            const context = { surface: 'ui' as const, actionRequestId: 'commit-observer', expectedAccountId: 'account-1' };
            frontDoorExecute.mockResolvedValueOnce({ ok: true, result: {
                type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true, sessionId: result.sessionId,
                operation: { ...input.executionTarget, operationId: 'commit-operation' },
            } }).mockImplementationOnce(async actionId => {
                expect(actionId).toBe('action.operations.get');
                rejoined.resolve();
                return observeCommittedTerminal(await terminal.promise);
            });
            const onCommitted = vi.fn(async (receipt: Readonly<{ sessionId: string; executionTarget: StrictSessionSpawnNewInput['executionTarget'] }>) => {
                expect(receipt).toMatchObject({ sessionId: result.sessionId, executionTarget: input.executionTarget });
                committed.resolve();
                if (presentation === 'unavailable') throw new Error('created_session_not_available_locally');
            });
            const action = executeSessionSpawnNewAction(input, context, undefined, {
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted,
            });
            let settled = false;
            void action.then(() => { settled = true; }, () => { settled = true; });
            try {
                await Promise.race([committed.promise, action.then(() => { throw new Error('Missing committed presentation'); })]);
                await rejoined.promise;
                expect(settled).toBe(false);
                expect(onCommitted).toHaveBeenCalledTimes(1);
                expect(frontDoorExecute.mock.calls).toEqual([
                    ['session.spawn_new', { ...projectSessionSpawnNewActionInputV2(input), observeSessionCommit: true }, context],
                    ['action.operations.get', { ...input.executionTarget, operationId: 'commit-operation', waitForTerminal: true }, context],
                ]);
                const failure: ActionExecuteResult = { ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false,
                    launchError: { kind: 'launch_error', code: 'connected_service_credential_reconnect_required',
                        message: 'connected_service_credential_reconnect_required' } } };
                terminal.resolve(failure);
                await expect(action).resolves.toEqual(failure);
                expect(frontDoorExecute.mock.calls).toHaveLength(2);
            } finally {
                terminal.resolve({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
                await action.catch(() => undefined);
            }
        },
    );

    it.each(['succeeded', 'failed'] as const)('observes the exact %s operation instead of reexecuting an already-settled retryable spawn', async state => {
        const address = { ...input.executionTarget, operationId: 'settled-retryable-operation' };
        const refusal: SessionSpawnNewResultV1 = { type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'broker_unavailable', message: 'broker_unavailable' } };
        const terminal: ActionOperationSnapshotV1 = { version: 1, operationId: address.operationId, revision: 3,
            actionId: 'session.spawn_new', state, scope: { accountId: 'account-1', machineId: address.machineId },
            requestId: 'settled-retryable', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
            cancellation: 'supported', result: projectSessionSpawnNewActionResultV1(refusal),
            ...(state === 'failed' ? { error: { errorCode: 'spawn_failed', error: 'spawn_failed' } } : {}) };
        let spawnRequests = 0;
        frontDoorExecute.mockImplementation(async actionId => {
            if (actionId === 'action.operations.get') return { ok: true, result: { kind: 'found', operation: terminal } };
            spawnRequests += 1;
            return spawnRequests === 1 ? { ok: true, result: { type: 'pending', outcome: 'accepted',
                retryWithSameCreationKey: true, sessionId: result.sessionId, operation: address } }
                : { ok: true, result: projectSessionSpawnNewActionResultV1(refusal) };
        });
        try {
            await expect(executeSessionSpawnNewAction(input, { surface: 'ui', actionRequestId: terminal.requestId,
                expectedAccountId: 'account-1' }, undefined, {
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted: () => {},
            })).resolves.toEqual({ ok: true, result: refusal });
            expect(frontDoorExecute.mock.calls.map(([actionId, value]) => ({ actionId, value }))).toEqual([
                { actionId: 'session.spawn_new', value: { ...projectSessionSpawnNewActionInputV2(input), observeSessionCommit: true } },
                { actionId: 'action.operations.get', value: { ...address, waitForTerminal: true } },
            ]);
            expect(spawnRequests).toBe(1);
        } finally { actionOperationStore.reset(); }
    });

    it('retains an exact-operation authorization refusal without falling back to Session creation', async () => {
        const address = { ...input.executionTarget, operationId: 'held-inaccessible-operation' };
        const denied = { ok: false as const, errorCode: 'permission_denied', error: 'permission_denied' };
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: { type: 'pending', outcome: 'accepted',
            retryWithSameCreationKey: true, sessionId: result.sessionId, operation: address } }).mockResolvedValueOnce(denied);
        await expect(executeSessionSpawnNewAction(input, { surface: 'ui', expectedAccountId: 'account-1' }, undefined, {
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted: () => {},
        })).resolves.toEqual(denied);
        expect(frontDoorExecute.mock.calls.map(([actionId, value]) => ({ actionId, value }))).toEqual([
            { actionId: 'session.spawn_new', value: { ...projectSessionSpawnNewActionInputV2(input), observeSessionCommit: true } },
            { actionId: 'action.operations.get', value: { ...address, waitForTerminal: true } },
        ]);
    });

    it('refuses a committed receipt for another Machine before presenting or rejoining', async () => {
        const onCommitted = vi.fn();
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
            sessionId: result.sessionId, operation: { ...input.executionTarget, machineId: 'another-machine', operationId: 'another-operation' } } });
        await expect(executeSessionSpawnNewAction(input, { surface: 'ui' }, undefined, {
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted,
        })).resolves.toEqual({ ok: false, errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' });
        expect(onCommitted).not.toHaveBeenCalled();
        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
    });

    it('does not present a committed receipt without an address for its terminal observer', async () => {
        const onCommitted = vi.fn();
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
            sessionId: result.sessionId } });
        await expect(executeSessionSpawnNewAction(input, { surface: 'ui' }, undefined, {
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted,
        })).resolves.toEqual({ ok: false, errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' });
        expect(onCommitted).not.toHaveBeenCalled();
        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
    });

    it('does not replace the presented committed Session with another terminal Session id', async () => {
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
            sessionId: result.sessionId, operation: { ...input.executionTarget, operationId: 'commit-operation' } } })
            .mockResolvedValueOnce(observeCommittedTerminal({ ok: true,
                result: projectSessionSpawnNewActionResultV1({ ...result, sessionId: 'different-session' }) }));
        await expect(executeSessionSpawnNewAction(input, { surface: 'ui', expectedAccountId: 'account-1' }, undefined, {
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, onCommitted: () => {},
        })).resolves.toEqual({ ok: false, errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' });
        expect(frontDoorExecute.mock.calls.map(([actionId]) => actionId)).toEqual(['session.spawn_new', 'action.operations.get']);
    });

    it.each(['rejected', 'outcomeUnknown', 'team_refusal'] as const)(
        'retains committed manual custody, text and attachments through late %s', async disposition => {
            getPersistenceStorage().clearAll();
            actionOperationStore.reset();
            const scope = { serverId: 'server-1', accountId: 'account-1' };
            const userAttemptId = `commit-${disposition}`;
            const draftId = 'd493e639-d8be-46d4-b52a-a196d433be5e';
            const values = new Map<string, string>();
            const repository = createSessionDraftRepository({ storage: {
                getString: key => values.get(key), set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); },
            }, cipher: createSessionDraftCipher({
                accountMode: 'plain', accountCryptoMaterial: null, getSessionContext: () => null,
                randomBytes: length => new Uint8Array(length),
            }), syncEnabled: false });
            const text = 'Keep this first turn and its file';
            repository.writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit',
                patch: { text, attachments: [{ id: 'attachment-1' }] } });
            const draftBefore = repository.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
            const attachments = [{ id: 'attachment-1', status: 'pending' as const,
                source: { kind: 'memory' as const, bytes: new Uint8Array([1, 2, 3]), name: 'first-turn.txt' } }];
            writeNewSessionAttachmentDrafts(draftId, attachments);
            const committed = createDeferred<void>();
            const rejoined = createDeferred<void>();
            const terminal = createDeferred<ActionExecuteResult>();
            const manualInput = { ...input, creationKey: buildManualSessionCreationKey(userAttemptId), initialInput: { text } };
            let firstTurnLocalId = '';
            frontDoorExecute.mockResolvedValueOnce({ ok: true, result: {
                type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true, sessionId: result.sessionId,
                operation: { ...input.executionTarget, operationId: 'commit-operation' },
            } }).mockImplementationOnce(async actionId => {
                expect(actionId).toBe('action.operations.get');
                rejoined.resolve();
                return observeCommittedTerminal(await terminal.promise);
            });
            const execution = executeManualSessionSpawnNewAction(manualInput, { surface: 'ui', actionRequestId: userAttemptId }, {
                scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'retained-commit-nonce',
                observation: { operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } },
                    onCommitted: () => {
                        const state = readSpawnAttemptCustodyState(scope);
                        expect(state.status).toBe('valid');
                        if (state.status !== 'valid') throw new Error('Expected launch custody before presentation');
                        const [record] = Object.values(state.attempts);
                        expect(record).toMatchObject({ createdSessionId: result.sessionId, submissionState: 'submitted', nonce: 'retained-commit-nonce' });
                        firstTurnLocalId = record!.firstTurnLocalId;
                        expect(record!.attachmentMessageLocalId).toBe(firstTurnLocalId);
                        committed.resolve();
                    },
                },
            });
            try {
                await Promise.race([committed.promise, execution.then(() => { throw new Error('Committed callback was not observed'); })]);
                await rejoined.promise;
                expect(repository.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })).toBe(draftBefore);
                expect(readNewSessionAttachmentDrafts(draftId)).toEqual(attachments);
                expect(readNewSessionAttachmentDrafts(draftId)[0]?.source).toBe(attachments[0]!.source);
                const terminalResult: SessionSpawnNewResultV1 = disposition === 'team_refusal'
                    ? { type: 'error', code: 'spawn_failed', retryable: false, launchError: { kind: 'launch_error',
                        code: 'connected_service_credential_reconnect_required', message: 'connected_service_credential_reconnect_required' } }
                    : { ...result, initialInput: disposition === 'rejected'
                        ? { status: 'rejected', code: 'session_input_target_unavailable' }
                        : { status: 'outcomeUnknown', localId: firstTurnLocalId, code: 'session_input_admission_outcome_unknown' } };
                terminal.resolve({ ok: true, result: projectSessionSpawnNewActionResultV1(terminalResult) });
                const settled = await execution;
                expect(settled).toMatchObject({ status: 'executed', action: { ok: true, result: terminalResult },
                    custody: { createdSessionId: result.sessionId, firstTurnLocalId, nonce: 'retained-commit-nonce' } });
                expect(readSpawnAttemptCustodyState(scope).status).toBe('valid');
                expect(repository.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })).toBe(draftBefore);
                expect(readNewSessionAttachmentDrafts(draftId)).toEqual(attachments);
                expect(readNewSessionAttachmentDrafts(draftId)[0]?.source).toBe(attachments[0]!.source);
                expect(frontDoorExecute.mock.calls).toHaveLength(2);
                if (terminalResult.type === 'error') expect(resolveSessionSpawnNewResultFailureMessageKey(terminalResult))
                    .toBe('connectedServices.diagnostics.body.connected_service_credential_reconnect_required');
            } finally {
                terminal.resolve({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
                await execution.catch(() => undefined);
                clearNewSessionAttachmentDrafts(draftId);
                getPersistenceStorage().clearAll();
                actionOperationStore.reset();
            }
        },
    );

    it.each([0, 1_000])('commits fresh manual custody with one lock, read and write beside %i unresolved attempts', async retainedEntries => {
        const persistence = getPersistenceStorage();
        persistence.clearAll();
        actionOperationStore.reset();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        // Retained entries are unresolved work, not completed launch history.
        for (let index = 0; index < retainedEntries; index += 1) {
            await acquireSpawnAttemptCustody({ scope, machineId: 'machine-1',
                targetFingerprint: 'retained-target', userAttemptId: `retained-${index}`, seedNonce: `nonce-${index}` });
        }
        const reads = vi.spyOn(persistence, 'getString');
        const writes = vi.spyOn(persistence, 'set');
        const spans: Array<{ waitMs: number; mutationMs: number }> = [];
        // Web Locks and MMKV are the only substituted system boundaries.
        const request = vi.fn(async <T>(_name: string, _options: LockOptions, callback: () => T) => {
            const requestedAt = performance.now();
            await Promise.resolve();
            const acquiredAt = performance.now();
            const value = callback();
            spans.push({ waitMs: acquiredAt - requestedAt, mutationMs: performance.now() - acquiredAt });
            return value;
        });
        vi.stubGlobal('navigator', { locks: { request } });
        const userAttemptId = 'cost-contract-fresh';
        let beforeDispatch: { locks: number; reads: number; writes: number; writtenBytes: number } | undefined;
        const execute = vi.fn<(...args: Parameters<typeof frontDoorExecute>) => ReturnType<typeof frontDoorExecute>>(async () => {
            beforeDispatch = { locks: request.mock.calls.length, reads: reads.mock.calls.length,
                writes: writes.mock.calls.length,
                writtenBytes: writes.mock.calls.reduce((sum, [, value]) => sum + (typeof value === 'string' ? value.length : 0), 0) };
            // A real downstream reader must see the committed submitted nonce before issuance.
            const persisted = readSpawnAttemptCustodyState(scope);
            expect(persisted.status).toBe('valid');
            if (persisted.status !== 'valid') throw new Error('Expected durable custody at dispatch');
            expect(Object.values(persisted.attempts)).toHaveLength(retainedEntries + 1);
            expect(Object.values(persisted.attempts).find(record => record.userAttemptId === userAttemptId))
                .toMatchObject({ nonce: 'cost-contract-nonce', submissionState: 'submitted' });
            return { ok: false, errorCode: 'target_unavailable', error: 'unavailable' };
        });
        const startedAt = performance.now();
        try {
            const settled = await executeManualSessionSpawnNewAction({ ...input,
                creationKey: buildManualSessionCreationKey(userAttemptId),
            }, { surface: 'ui', actionRequestId: userAttemptId }, {
                scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'cost-contract-nonce',
                executeAction: (strictInput, context) => executeSessionSpawnNewActionImpl(strictInput, context, { execute }),
            });
            console.info('SPAWNCLIENT constructed custody', JSON.stringify({ ...beforeDispatch,
                retainedEntries, phaseSpans: spans, elapsedMs: performance.now() - startedAt }));
            expect(settled).toMatchObject({ status: 'executed', custody: { submissionState: 'submitted' } });
            expect(beforeDispatch).toMatchObject({ locks: 1, reads: 1, writes: 1 });
        } finally {
            reads.mockRestore();
            writes.mockRestore();
            vi.unstubAllGlobals();
            persistence.clearAll();
            actionOperationStore.reset();
        }
    });

    it('retains an admitted birth origin for a direct manual caller without a separate writer-choice argument', async () => {
        getPersistenceStorage().clearAll();
        actionOperationStore.reset();
        const userAttemptId = 'direct-origin-birth';
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const authoringOrigin = { kind: 'project', accountId: scope.accountId, page: 'scripts',
            workspace: { serverId: scope.serverId, workspaceId: 'checkout-1', machineId: 'machine-1', rootPath: '/private-checkout' } } as const;
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
        const settled = await executeManualSessionSpawnNewAction({ ...input,
            creationKey: buildManualSessionCreationKey(userAttemptId), authoringOrigin,
        }, { surface: 'ui', actionRequestId: userAttemptId }, {
            scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'direct-origin-nonce',
        });
        expect(settled).toMatchObject({ status: 'executed', custody: { authoringOriginPersistence: 'daemon-birth' } });
        expect(frontDoorExecute.mock.calls[0]?.[1]).toMatchObject({ authoringOrigin });
    });
    it.each(['direct', 'pending', 'recovered', 'waiting'] as const)(
        'qualifies a daemon-spelled %s result before marking manual creation committed', async receipt => {
            getPersistenceStorage().clearAll();
            actionOperationStore.reset();
            const userAttemptId = `attempt-daemon-${receipt}`;
            const scope = { serverId: 'server-1', accountId: 'account-1' };
            const daemonResult = { ...result, executionTarget: { ...result.executionTarget, serverId: 'stack_agent-qa-voice-dev__id_default' } };
            const operation: ActionOperationSnapshotV1 = {
                version: 1, operationId: 'pending-operation', revision: 3, actionId: 'session.spawn_new', state: 'succeeded',
                scope: { accountId: scope.accountId, machineId: input.executionTarget.machineId },
                requestId: userAttemptId, title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
                cancellation: 'supported', result: projectSessionSpawnNewActionResultV1(daemonResult),
            };
            const manualInput = { ...input, creationKey: buildManualSessionCreationKey(userAttemptId) };
            const context = { surface: 'ui' as const, actionRequestId: userAttemptId };
            const params = { scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'daemon-result-nonce' };
            if (receipt === 'recovered') {
                frontDoorExecute.mockResolvedValueOnce({ ok: false, errorCode: 'target_unavailable', error: 'unavailable' });
                await executeManualSessionSpawnNewAction(manualInput, context, params);
                actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [operation] });
            } else if (receipt === 'pending') {
                frontDoorExecute.mockResolvedValueOnce({ ok: true, result: {
                    type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                    operation: { ...daemonResult.executionTarget, operationId: operation.operationId },
                } }).mockResolvedValueOnce({ ok: true, result: { kind: 'found', operation } });
            } else if (receipt === 'waiting') {
                frontDoorExecute.mockResolvedValueOnce({ ok: false, errorCode: 'session_follow_source_key_preparation_waiting',
                    error: 'session_follow_source_key_preparation_waiting', effectAttempted: false, details: {
                        status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source: daemonResult,
                    } });
            } else {
                frontDoorExecute.mockResolvedValueOnce({ ok: true, result: projectSessionSpawnNewActionResultV1(daemonResult) });
            }
            try {
                const settled = await executeManualSessionSpawnNewAction(manualInput, context, params);
                expect(settled).toMatchObject({ status: 'executed', custody: { createdSessionId: result.sessionId } });
                if (settled.status !== 'executed') throw new Error('Expected executed manual action');
                expect(readCommittedSessionSpawnNewActionResult(settled.action)).toEqual(result);
                const persisted = readSpawnAttemptCustodyState(scope);
                if (persisted.status !== 'valid') throw new Error('Expected valid manual custody');
                expect(Object.values(persisted.attempts)).toEqual([expect.objectContaining({ createdSessionId: result.sessionId })]);
            } finally {
                getPersistenceStorage().clearAll();
                actionOperationStore.reset();
            }
        },
    );

    it.each(['receiptMachineId', 'operationId', 'actionId', 'accountId', 'machineId', 'resultMachineId'] as const)(
        'refuses a pending settlement with a mismatched %s', async mismatch => {
            const operation: ActionOperationSnapshotV1 = {
                version: 1, operationId: mismatch === 'operationId' ? 'other-operation' : 'pending-operation', revision: 3,
                actionId: mismatch === 'actionId' ? 'session.stop' : 'session.spawn_new', state: 'succeeded',
                scope: { accountId: mismatch === 'accountId' ? 'other-account' : 'account-1',
                    machineId: mismatch === 'machineId' ? 'other-machine' : input.executionTarget.machineId },
                requestId: 'spawn-request', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
                cancellation: 'supported', result: projectSessionSpawnNewActionResultV1({ ...result, executionTarget: { ...result.executionTarget,
                    ...(mismatch === 'resultMachineId' ? { machineId: 'other-machine' } : {}) } }),
            };
            frontDoorExecute.mockResolvedValueOnce({ ok: true, result: {
                type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                operation: { serverId: 'stack_agent-qa-voice-dev__id_default',
                    machineId: mismatch === 'receiptMachineId' ? 'other-machine' : input.executionTarget.machineId,
                    operationId: 'pending-operation' },
            } }).mockResolvedValueOnce({ ok: true, result: { kind: 'found', operation } });
            await expect(executeSessionSpawnNewAction(input, {
                surface: 'ui', serverId: input.executionTarget.serverId, expectedAccountId: 'account-1',
            })).resolves.toEqual({ ok: false, errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' });
        },
    );

    it('retains the exact created Session in manual custody while key preparation remains explicitly waiting', async () => {
        getPersistenceStorage().clearAll();
        const failure = { ok: false as const, errorCode: 'session_follow_source_key_preparation_waiting',
            error: 'session_follow_source_key_preparation_waiting', details: {
                status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source: result,
            } };
        const userAttemptId = 'attempt-waiting-key';
        // A presentation host may own creation through this public adapter;
        // persisted custody and result interpretation remain real.
        const settled = await executeManualSessionSpawnNewAction({ ...input,
            creationKey: buildManualSessionCreationKey(userAttemptId),
        }, { surface: 'ui', actionRequestId: userAttemptId }, {
            scope: { serverId: 'server-1', accountId: 'account-1' }, machineHomeDir: '/home/tester',
            userAttemptId, seedNonce: 'waiting-key-nonce', executeAction: async () => failure,
        });
        expect(settled).toMatchObject({ status: 'executed', action: failure,
            custody: { createdSessionId: result.sessionId, nonce: 'waiting-key-nonce' } });
        const persisted = readSpawnAttemptCustodyState({ serverId: 'server-1', accountId: 'account-1' });
        if (persisted.status !== 'valid') throw new Error('expected persisted manual custody');
        expect(Object.values(persisted.attempts)).toEqual([expect.objectContaining({ createdSessionId: result.sessionId })]);
        getPersistenceStorage().clearAll();
    });

    it('uses the historical Action front door exactly once and preserves its terminal result', async () => {
        frontDoorExecute.mockResolvedValue({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });

        await expect(executeSessionSpawnNewAction(input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        })).resolves.toEqual({ ok: true, result });

        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
        expect(frontDoorExecute).toHaveBeenCalledWith('session.spawn_new', projectSessionSpawnNewActionInputV2(input), {
            surface: 'ui',
            actionRequestId: input.creationKey,
        });
    });

    it('preserves the historical typed failure without issuing another execution path', async () => {
        frontDoorExecute.mockResolvedValue({
            ok: false,
            errorCode: 'target_unavailable',
            error: 'Target unavailable',
        });

        await expect(executeSessionSpawnNewAction(input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'target_unavailable',
            error: 'Target unavailable',
        });
        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
    });

    it('uses the existing persisted custody owner around the manual Action path', async () => {
        getPersistenceStorage().clearAll();
        frontDoorExecute.mockResolvedValue({ ok: true, result: projectSessionSpawnNewActionResultV1(result) });
        const userAttemptId = 'attempt-1';
        const creationKey = buildManualSessionCreationKey(userAttemptId);
        const manualInput: StrictSessionSpawnNewInput = {
            ...input,
            creationKey,
        };

        const first = await executeManualSessionSpawnNewAction(manualInput, {
            surface: 'ui',
            actionRequestId: userAttemptId,
        }, {
            scope: { serverId: 'server-1', accountId: 'account-1' },
            machineHomeDir: '/home/tester',
            userAttemptId,
            seedNonce: 'manual-nonce-1',
        });

        expect(first).toMatchObject({
            status: 'executed',
            action: { ok: true, result },
            custody: {
                userAttemptId,
                nonce: 'manual-nonce-1',
                submissionState: 'submitted',
                createdSessionId: 'session-created',
            },
        });
        expect(frontDoorExecute).toHaveBeenCalledWith('session.spawn_new', projectSessionSpawnNewActionInputV2(manualInput), {
            surface: 'ui',
            actionRequestId: userAttemptId,
            expectedAccountId: 'account-1',
        });

        if (first.status !== 'executed') throw new Error('expected executed manual action');
        await expect(completeManualSessionSpawnNewActionCustody(first.custody)).resolves.toBe(true);
        getPersistenceStorage().clearAll();
    });

    it('rehydrates one submitted manual attempt after an ambiguous Action result', async () => {
        getPersistenceStorage().clearAll();
        frontDoorExecute.mockResolvedValue({
            ok: true,
            result: {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
            },
        });
        const userAttemptId = 'attempt-reload';
        const creationKey = buildManualSessionCreationKey(userAttemptId);
        const manualInput: StrictSessionSpawnNewInput = { ...input, creationKey };
        const params = {
            scope: { serverId: 'server-1', accountId: 'account-1' },
            machineHomeDir: '/home/tester',
            userAttemptId,
            seedNonce: 'nonce-before-reload',
        } as const;

        const first = await executeManualSessionSpawnNewAction(manualInput, {
            surface: 'ui',
            actionRequestId: userAttemptId,
        }, params);
        const retried = await executeManualSessionSpawnNewAction(manualInput, {
            surface: 'ui',
            actionRequestId: userAttemptId,
        }, { ...params, seedNonce: 'nonce-after-reload' });

        expect(first).toMatchObject({
            status: 'executed',
            custody: { nonce: 'nonce-before-reload', submissionState: 'submitted' },
        });
        expect(retried).toMatchObject({
            status: 'executed',
            custody: { nonce: 'nonce-before-reload', submissionState: 'submitted' },
        });
        expect(frontDoorExecute).toHaveBeenCalledTimes(2);
        await expect(settleSpawnAttemptCustodyFromActionOperation({
            scope: params.scope,
            userAttemptId,
            createdSessionId: 'session-rehydrated-after-reload',
        })).resolves.toBe(true);
        getPersistenceStorage().clearAll();
    });

    it.each([false, true, undefined])('retains only unresolved attempts when effectAttempted is %s', async effectAttempted => {
        getPersistenceStorage().clearAll();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        frontDoorExecute.mockResolvedValue({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action',
            ...(effectAttempted === undefined ? {} : { effectAttempted }) });
        try {
            for (let index = 0; index < 20; index += 1) {
                const userAttemptId = `settled-retention-${index}`;
                await executeManualSessionSpawnNewAction({ ...input, creationKey: buildManualSessionCreationKey(userAttemptId) },
                    { surface: 'ui', actionRequestId: userAttemptId }, {
                        scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: `retention-nonce-${index}`,
                    });
            }
            const persisted = readSpawnAttemptCustodyState(scope);
            const retained = persisted.status === 'valid' ? Object.values(persisted.attempts).length : 0;
            console.info('SPAWNCLIENT constructed pruning', JSON.stringify({ effectAttempted: String(effectAttempted),
                attemptedEntries: 20, retainedEntries: retained,
                serializedCharacters: persisted.status === 'valid' ? JSON.stringify(persisted.attempts).length : 0 }));
            expect(retained).toBe(effectAttempted === false ? 0 : 20);
            expect(persisted.status).toBe(effectAttempted === false ? 'missing' : 'valid');
        } finally {
            getPersistenceStorage().clearAll();
        }
    });

    it('retains an unknown concurrent retry when the first dispatch later proves no effect', async () => {
        getPersistenceStorage().clearAll();
        actionOperationStore.reset();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const userAttemptId = 'overlapping-submission';
        let releaseFirst: (() => void) | undefined;
        const firstResult = new Promise<ActionExecuteResult>(resolve => {
            releaseFirst = () => resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action', effectAttempted: false });
        });
        frontDoorExecute.mockReturnValueOnce(firstResult).mockResolvedValueOnce({ ok: true,
            result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } });
        const manualInput = { ...input, creationKey: buildManualSessionCreationKey(userAttemptId) };
        const context = { surface: 'ui' as const, actionRequestId: userAttemptId };
        const params = { scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'overlap-original' };
        const first = executeManualSessionSpawnNewAction(manualInput, context, params);
        try {
            await vi.waitFor(() => expect(frontDoorExecute).toHaveBeenCalledTimes(1));
            await executeManualSessionSpawnNewAction(manualInput, context, { ...params, seedNonce: 'must-not-replace' });
            releaseFirst?.();
            await first;
            const persisted = readSpawnAttemptCustodyState(scope);
            expect(persisted.status === 'valid' && Object.values(persisted.attempts))
                .toEqual([expect.objectContaining({ nonce: 'overlap-original', submissionState: 'submitted' })]);
        } finally {
            releaseFirst?.();
            await first;
            getPersistenceStorage().clearAll();
            actionOperationStore.reset();
        }
    });

    it.each([
        { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action', effectAttempted: false },
        { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'method_unavailable' },
        { ok: true, result: { type: 'error', code: 'organization_invalid', retryable: false } },
    ] satisfies SessionSpawnNewActionResult[])(
        'retains a prior submitted outcome after the later retry returns $ok', async laterResult => {
        getPersistenceStorage().clearAll();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const userAttemptId = 'prior-submitted-unknown';
        const manualInput = { ...input, creationKey: buildManualSessionCreationKey(userAttemptId) };
        const context = { surface: 'ui' as const, actionRequestId: userAttemptId };
        const params = { scope, machineHomeDir: '/home/tester', userAttemptId, seedNonce: 'original-unknown-nonce' };
        frontDoorExecute.mockResolvedValueOnce({ ok: true, result: {
            type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
        } }).mockResolvedValueOnce(laterResult.ok ? { ok: true, result: projectSessionSpawnNewActionResultV1(laterResult.result) } : laterResult);
        try {
            await executeManualSessionSpawnNewAction(manualInput, context, params);
            await executeManualSessionSpawnNewAction(manualInput, context, { ...params, seedNonce: 'must-not-replace' });
            const persisted = readSpawnAttemptCustodyState(scope);
            expect(persisted.status === 'valid' && Object.values(persisted.attempts))
                .toEqual([expect.objectContaining({ nonce: 'original-unknown-nonce', submissionState: 'submitted' })]);
        } finally {
            getPersistenceStorage().clearAll();
        }
    });

    it.each([
        [{
            ok: true as const,
            result: { type: 'error', code: 'organization_invalid', retryable: false },
        }],
        [{
            ok: false as const,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        }],
    ])('settles custody after a proven terminal no-commit result', async (terminalResult) => {
        getPersistenceStorage().clearAll();
        frontDoorExecute.mockResolvedValue(terminalResult);
        const scope = { serverId: 'server-1', accountId: 'account-1' } as const;
        const userAttemptId = 'attempt-terminal';
        const manualInput: StrictSessionSpawnNewInput = {
            ...input,
            creationKey: buildManualSessionCreationKey(userAttemptId),
        };

        await executeManualSessionSpawnNewAction(manualInput, {
            surface: 'ui',
            actionRequestId: userAttemptId,
        }, {
            scope,
            machineHomeDir: '/home/tester',
            userAttemptId,
            seedNonce: 'terminal-nonce',
        });

        if (terminalResult.ok) {
            const persisted = readSpawnAttemptCustodyState(scope);
            expect(persisted.status === 'valid' && Object.values(persisted.attempts))
                .toEqual([expect.objectContaining({ terminalResult: terminalResult.result })]);
        } else {
            expect(readSpawnAttemptCustodyState(scope)).toEqual({ status: 'missing' });
        }
        getPersistenceStorage().clearAll();
    });
});
