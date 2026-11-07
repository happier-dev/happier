import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { createPresentedFirstTurnSettlement } from './presentedFirstTurnSettlement';
import { getPendingMessageVisualState } from '@/components/sessions/pending/pendingMessageVisualState';

const presented = { sessionId: 'session-1', firstTurnLocalId: 'first-turn' };
const canonical = (state: ActionOperationSnapshotV1['state'], error?: ActionOperationSnapshotV1['error']) =>
    ({ state, ...(error ? { error } : {}) }) as Pick<ActionOperationSnapshotV1, 'state' | 'error'>;

function harness(operation: Pick<ActionOperationSnapshotV1, 'state' | 'error' | 'result'> | null) {
    const write = vi.fn();
    const settlement = createPresentedFirstTurnSettlement({
        draftId: 'draft-1', readCanonicalOperation: () => operation, write,
    });
    settlement.present(presented);
    return { settlement, write };
}

describe('createPresentedFirstTurnSettlement', () => {
    it('recovers a typed spawn refusal from a successful Action without claiming that its first input reached the agent', () => {
        const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
            launchError: { kind: 'launch_error' as const, code: 'agent_isolation_unavailable', message: 'Member setup unavailable',
                agentIsolationRefusal: { reason: 'member_setup_required' as const, phase: 'native_execution_preparation' as const,
                    remedy: { kind: 'ask_machine_manager' as const } } } };
        const { settlement, write } = harness({ state: 'succeeded', result: projectSessionSpawnNewActionResultV1(refusal) });
        settlement.settle({ final: true, acceptedLocalId: null });
        const pendingLaunch = write.mock.calls[0]?.[1];
        expect(pendingLaunch).toMatchObject({ state: 'failed', failure: refusal });
        const visual = getPendingMessageVisualState({ id: 'first-turn', localId: 'first-turn', createdAt: 1, updatedAt: 1,
            source: 'local_outbound', text: 'Start here', rawRecord: {}, pendingLaunch });
        expect(visual).toMatchObject({ kind: 'launch_failed', deliveryBlockedPresentation: { isUnknown: false } });
    });

    it('settles a launch the caller abandoned to its canonical operation from that operation (review P1 path a)', () => {
        const { settlement, write } = harness(canonical('failed', { errorCode: 'spawn_failed', error: 'spawn_failed' }));
        // The launcher adopted the canonical settlement and returned without any result.
        settlement.settle({ final: true, acceptedLocalId: null });
        expect(write).toHaveBeenCalledWith(presented, expect.objectContaining({ state: 'failed', draftId: 'draft-1' }));
    });

    it('never leaves an exception exit on "starting": unknown outcome becomes unresolved (review P1 path b)', () => {
        const { settlement, write } = harness(canonical('running'));
        settlement.settle({ final: true, acceptedLocalId: null });
        expect(write).toHaveBeenCalledWith(presented, { state: 'unresolved' });
    });

    it('settles a typed refusal whatever the launcher now shows (review P1 path c)', () => {
        const { settlement, write } = harness(canonical('succeeded'));
        settlement.observe({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false } });
        settlement.settle({ final: false });
        expect(write).toHaveBeenCalledWith(presented, expect.objectContaining({ state: 'failed', draftId: 'draft-1' }));
        settlement.settle({ final: true, acceptedLocalId: null });
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('leaves accepted input to its committed message and settles nothing twice', () => {
        const { settlement, write } = harness(canonical('succeeded'));
        settlement.observe({ ok: true, result: { type: 'success', disposition: 'created', sessionId: 'session-1',
            executionTarget: { serverId: 's', machineId: 'm' }, organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'accepted', localId: 'first-turn' } } } as never);
        settlement.settle({ final: false });
        settlement.settle({ final: true, acceptedLocalId: 'first-turn' });
        expect(write).not.toHaveBeenCalled();
        // A created Session whose input was not accepted, and whose created branch never ran, is not left starting.
        const second = harness(canonical('succeeded'));
        second.settlement.observe({ ok: true, result: { type: 'success', disposition: 'created', sessionId: 'session-1',
            executionTarget: { serverId: 's', machineId: 'm' }, organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'outcomeUnknown', reason: 'transport_unavailable' } } } as never);
        second.settlement.settle({ final: true, acceptedLocalId: null });
        expect(second.write).toHaveBeenCalledWith(presented, { state: 'unresolved' });
    });

    it('keeps completion (custody, draft consumption) with a launch presented at commit after its launcher moved on', () => {
        const write = vi.fn();
        const settlement = createPresentedFirstTurnSettlement({ draftId: 'draft-1', readCanonicalOperation: () => null, write });
        // Before hand-off the launcher's current scope decides, as before.
        expect(settlement.ownsCompletion(false)).toBe(false);
        expect(settlement.ownsCompletion(true)).toBe(true);
        // A docked host renews its composer at hand-off: the submitted draft must still be consumed once.
        settlement.present(presented);
        expect(settlement.ownsCompletion(false)).toBe(true);
    });
});
