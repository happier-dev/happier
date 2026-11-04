import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ComputerGrantStatusV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol/computer/v1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createComputerControlClient, getComputerSessionProjection } from './computerControlClient';

const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
const selection = {
    sourceId: 'selected-source', selectedTarget: target, access: 'use', consentGranted: true,
    approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: false, target: { kind: 'window', title: 'Editor' } },
} satisfies ComputerSelectedTargetResponseV1;
const unselected = { consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: true } };

describe('computer Action-answer projection', () => {
    it('exchanges clipboard text for a Machine-person through the private present-user Action path', async () => {
        let text = 'remote clipboard';
        const observations: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ observeActionExecution: async observation => { observations.push(observation); }, runtimeActionExecute: async ({ actionId, input }) => {
            if (actionId === 'computer.clipboard.read') return { ok: true, text };
            if (actionId === 'computer.clipboard.write') { text = (input as { text: string }).text; return { ok: true }; }
            throw new Error(`Unexpected clipboard Action: ${actionId}`);
        } }));
        const client = createComputerControlClient({ machineId: 'machine', serverId: 'home', source: { kind: 'machine-person', personId: 'alice' } }, executor.execute);
        expect(await client.clipboard({ kind: 'read' })).toEqual({ ok: true, value: { ok: true, text: 'remote clipboard' } });
        expect(await client.clipboard({ kind: 'write', text: 'local clipboard' })).toEqual({ ok: true, value: { ok: true } });
        expect(await client.clipboard({ kind: 'read' })).toEqual({ ok: true, value: { ok: true, text: 'local clipboard' } });
        expect(await client.clipboard({ kind: 'write', text: '' })).toEqual({ ok: true, value: { ok: true } });
        expect(await client.clipboard({ kind: 'read' })).toEqual({ ok: true, value: { ok: true, text: '' } });
        expect(JSON.stringify(observations)).not.toContain('remote clipboard');
        expect(JSON.stringify(observations)).not.toContain('local clipboard');
        expect(observations).toHaveLength(5);
    });

    it('keeps Machine-person selections separate from other people and Session selections without inventing a Session', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async () => unselected }));
        const machine = { machineId: 'machine', serverId: 'home' };
        const alice = getComputerSessionProjection({ ...machine, source: { kind: 'machine-person', personId: 'alice' } }, executor.execute);
        const aliceAgain = getComputerSessionProjection({ ...machine, source: { kind: 'machine-person', personId: 'alice' } }, executor.execute);
        const bob = getComputerSessionProjection({ ...machine, source: { kind: 'machine-person', personId: 'bob' } }, executor.execute);
        const session = getComputerSessionProjection({ ...machine, sessionId: 'alice' }, executor.execute);
        alice.applySelection(selection);
        expect(aliceAgain).toBe(alice);
        expect(aliceAgain.getSnapshot().selection?.sourceId).toBe(selection.sourceId);
        expect(bob.getSnapshot().selection).toBeNull();
        expect(session.getSnapshot().selection).toBeNull();
    });

    it.each([
        { capture: 'denied', readFailure: false }, { capture: 'unknown', readFailure: false },
        { capture: 'denied', readFailure: true }, { capture: 'unknown', readFailure: true },
    ] as const)('keeps the share releasable while OS capture is $capture (read refusal: $readFailure), then honors retirement', async ({ capture, readFailure }) => {
        let shared = true;
        let grants: ComputerGrantStatusV1 = { capture: 'granted', input: 'granted' };
        // The remote daemon is the host boundary; Action policy, output parsing,
        // client confirmation and the shared projection execute for real.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            if (actionId === 'computer.target.get') return shared ? selection : unselected;
            if (actionId === 'computer.targets.list') return { targets: [{ target }], grants };
            if (actionId === 'computer.control.status') {
                if (readFailure && grants.capture !== 'granted') return { ok: false,
                    errorCode: `capture_permission_${grants.capture}`, error: 'Capture permission unavailable' };
                return { target, sourceId: selection.sourceId, controller: 'human', controlEpoch: 1, stopping: false, uncertain: false, grants };
            }
            if (actionId === 'computer.target.close') { shared = false; return { target, sourceId: selection.sourceId, status: 'dispatched' }; }
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: `permission-${capture}` }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            expect(projection.getSnapshot().selection?.sourceId).toBe(selection.sourceId);
            grants = { capture, input: 'granted' };
            await projection.refresh();
            expect(projection.getSnapshot().selection?.sourceId).toBe(selection.sourceId);
            expect(projection.getSnapshot().grants).toEqual(grants);
            expect(await projection.client.stopSharing()).toMatchObject({ ok: true, value: { status: 'dispatched' } });
            await projection.refresh();
            expect(projection.getSnapshot().selection?.sourceId).toBeUndefined();
            grants = { capture: 'granted', input: 'granted' };
            await projection.refresh();
            expect(projection.getSnapshot().selection?.sourceId).toBeUndefined();
        } finally { unsubscribe(); }
    });

    it('reads retained-source grants and control status when picker thumbnails fail', async () => {
        const calls: string[] = [];
        const grants = { capture: 'granted', input: 'granted' } as const;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.control.status') return { target, sourceId: selection.sourceId,
                controller: 'human', controlEpoch: 1, stopping: false, uncertain: false, grants };
            if (actionId === 'computer.targets.list') return { ok: false, errorCode: 'thumbnail_failed', error: 'thumbnail_failed' };
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'retained-grants' }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            expect(projection.getSnapshot()).toMatchObject({ selection: { sourceId: selection.sourceId }, grants, failure: null,
                status: { controller: 'human' } });
            expect(calls).not.toContain('computer.targets.list');
        } finally { unsubscribe(); }
    });
});
