import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionCreationKeyV1Schema,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
    readSpawnAttemptCustodyState,
    settleSpawnAttemptCustodyFromActionOperation,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

const frontDoorExecute = vi.hoisted(() => vi.fn());

vi.mock('./frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => frontDoorExecute,
}));

import {
    buildManualSessionCreationKey,
    completeManualSessionSpawnNewActionCustody,
    executeManualSessionSpawnNewAction,
    executeSessionSpawnNewAction,
    type StrictSessionSpawnNewInput,
} from './sessionSpawnNewAction';

const input: StrictSessionSpawnNewInput = {
    creationKey: SessionCreationKeyV1Schema.parse('new-session-attempt-1'),
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: '/work/project',
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier', localId: 'codex' } },
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

describe('executeSessionSpawnNewAction tracking', () => {
    it('uses the historical Action front door exactly once and preserves its terminal result', async () => {
        frontDoorExecute.mockResolvedValue({ ok: true, result });

        await expect(executeSessionSpawnNewAction(input, {
            surface: 'ui',
            actionRequestId: input.creationKey,
        })).resolves.toEqual({ ok: true, result });

        expect(frontDoorExecute).toHaveBeenCalledTimes(1);
        expect(frontDoorExecute).toHaveBeenCalledWith('session.spawn_new', input, {
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
        frontDoorExecute.mockResolvedValue({ ok: true, result });
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
        expect(frontDoorExecute).toHaveBeenCalledWith('session.spawn_new', manualInput, {
            surface: 'ui',
            actionRequestId: userAttemptId,
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

    it.each([
        [{
            ok: true,
            result: { type: 'error', code: 'organization_invalid', retryable: false },
        }],
        [{
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        }],
    ])('clears custody after a proven terminal no-commit result', async (terminalResult) => {
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

        expect(readSpawnAttemptCustodyState(scope)).toEqual({ status: 'missing' });
        getPersistenceStorage().clearAll();
    });
});
