import { describe, expect, it, vi } from 'vitest';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentWorkspaceSyncFailure } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';

import {
    disableWorkspaceSyncRelationshipAction,
    enableWorkspaceSyncRelationshipAction,
    flushWorkspaceSyncRelationshipAction,
    terminateWorkspaceSyncRelationship,
} from './workspaceSyncRelationshipActions';

const input = { controllerMachineId: 'machine-a', relationshipId: 'relationship-a' };
const status = {
    relationshipId: 'relationship-a', controllerMachineId: 'machine-a', state: 'watching' as const,
    alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_both_in_sync' as const,
    endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1,
};

describe('workspace Sync relationship Action adapters', () => {
    it('preserves a thrown owner refusal through the relationship presenter', async () => {
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
            requestId: 'sync-refusal', effectAttempted: false,
            failureCause: { phase: 'workspace.sync.disable', errorClass: 'HttpStatusError', errorCode: 'machine_manage_required', httpStatus: 403 } });
        const result = await disableWorkspaceSyncRelationshipAction(input, null, async () => { throw createActionExecuteFailureError(failure); });
        expect(result).toEqual(failure);
        const presentation = presentWorkspaceSyncFailure(result);
        expect(presentation?.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'requestId', value: failure.requestId }),
            expect.objectContaining({ key: 'causePhase', value: failure.failureCause!.phase }),
            expect.objectContaining({ key: 'causeCode', value: failure.failureCause!.errorCode }),
        ]));
    });
    it.each([
        ['workspace.sync.relationship.disable', disableWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', enabled: false as const }],
        ['workspace.sync.relationship.enable', enableWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', enabled: true as const }],
        ['workspace.sync.relationship.flush', flushWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', status }],
        ['workspace.sync.relationship.terminate', terminateWorkspaceSyncRelationship,
            { v: 1 as const, relationshipId: 'relationship-a', terminated: true as const }],
    ] as const)('parses the strict %s producer result at the mounted consumer', async (actionId, run, output) => {
        const execute = vi.fn(async () => ({ ok: true as const, result: output }));

        await expect(run(input, null, execute)).resolves.toEqual({ ok: true, ...output });
        expect(execute).toHaveBeenCalledWith(actionId, input);
    });

    it('rejects a producer result outside the strict lifecycle schema', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {
            v: 1, relationshipId: 'relationship-a', enabled: false, extra: true,
        } }));

        await expect(disableWorkspaceSyncRelationshipAction(input, null, execute)).resolves.toEqual({
            ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown',
        });
    });

});
