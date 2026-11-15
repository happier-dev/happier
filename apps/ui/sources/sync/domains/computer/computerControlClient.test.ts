import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ComputerGrantStatusV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol/computer/v1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createComputerControlClient, getComputerSessionProjection } from './computerControlClient';

const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
const selection = {
    sourceId: 'selected-source', selectedTarget: target, access: 'use', consentGranted: true,
    approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: false, target: { kind: 'window', title: 'Editor' } },
} satisfies ComputerSelectedTargetResponseV1;
const unselected = { consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: true } };
const identity = { target, sourceId: selection.sourceId, targetLabel: selection.approvalDisplay.target.title };

describe('computer Action-answer projection', () => {
    it('publishes only changed answers and preserves unchanged selection facts across control changes', () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture());
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'stable-answer-facts' }, executor.execute);
        let publications = 0;
        const unsubscribe = projection.subscribe(() => { publications++; }, false);
        try {
            projection.applySelection(structuredClone(selection));
            const initial = projection.getSnapshot();
            for (let i = 0; i < 20; i++) projection.applySelection(structuredClone(selection));
            expect(publications).toBe(1);
            expect(projection.getSnapshot()).toBe(initial);
            projection.applyStatus({ target, sourceId: selection.sourceId, controller: 'human', controlEpoch: 1, stopping: false, uncertain: false });
            const controlled = projection.getSnapshot();
            expect(controlled.selection).toBe(initial.selection);
            projection.applyStatus({ target: { ...target }, sourceId: selection.sourceId, controller: 'agent', controlEpoch: 2, stopping: false, uncertain: false });
            expect(projection.getSnapshot().selection).toBe(initial.selection);
            expect(projection.getSnapshot().status?.target).toBe(controlled.status?.target);
            const agentStatus = projection.getSnapshot().status;
            projection.applySelection({ ...structuredClone(selection), access: 'see' });
            expect(projection.getSnapshot().selection?.approvalDisplay).toBe(initial.selection?.approvalDisplay);
            expect(projection.getSnapshot().status).toBe(agentStatus);
            expect(publications).toBe(4);
        } finally { unsubscribe(); }
    });
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

    it('retires a dispatched close with one Action and no confirmation read', async () => {
        const calls: string[] = [];
        let shared = true;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return shared ? selection : unselected;
            if (actionId === 'computer.control.status') return { target, sourceId: selection.sourceId,
                controller: 'human', controlEpoch: 1, stopping: false, uncertain: false };
            if (actionId === 'computer.target.close') { shared = false; return { ...identity, status: 'dispatched' }; }
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'close-fact' }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            calls.length = 0;
            expect(await projection.client.stopSharing()).toMatchObject({ ok: true, value: { status: 'dispatched', sourceId: selection.sourceId } });
            expect(calls).toEqual(['computer.target.close']);
            expect(projection.getSnapshot().selection?.sourceId).toBeUndefined();
        } finally { unsubscribe(); }
    });

    it('keeps a replacement source when the previous source close acknowledges later', async () => {
        const closed = createDeferred<typeof identity & { status: 'dispatched' }>();
        let current = selection;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            if (actionId === 'computer.target.get') return current;
            if (actionId === 'computer.control.status') return { target, sourceId: current.sourceId,
                controller: 'human', controlEpoch: 1, stopping: false, uncertain: false };
            if (actionId === 'computer.target.close') return closed.promise;
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'replacement-close' }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            const stopping = projection.client.stopSharing();
            current = { ...selection, sourceId: 'replacement-source' };
            projection.applySelection(current);
            closed.resolve({ ...identity, status: 'dispatched' });
            expect(await stopping).toMatchObject({ ok: true, value: { status: 'dispatched', sourceId: selection.sourceId } });
            expect(projection.getSnapshot().selection?.sourceId).toBe(current.sourceId);
        } finally { unsubscribe(); }
    });

    it('retains the release affordance when the close owner reports unknown completion', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.control.status') return { target, sourceId: selection.sourceId,
                controller: 'human', controlEpoch: 1, stopping: false, uncertain: false };
            if (actionId === 'computer.target.close') return { ...identity, status: 'interrupted', completion: 'unknown' };
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'unknown-close' }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            expect(await projection.client.stopSharing()).toMatchObject({ ok: true, value: { status: 'interrupted', completion: 'unknown' } });
            expect(projection.getSnapshot().selection?.sourceId).toBe(selection.sourceId);
        } finally { unsubscribe(); }
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
            if (actionId === 'computer.target.close') { shared = false; return { ...identity, status: 'dispatched' }; }
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
    it('says a screenless Machine has no screen while nothing is shared, so the stage never offers a window it cannot list', async () => {
        let displays: 'none' | 'present' = 'none';
        let listCalls = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            if (actionId === 'computer.target.get') return displays === 'none'
                ? { ok: false, errorCode: 'computer_display_unavailable', error: 'No screen' } : unselected;
            if (actionId === 'computer.targets.list') {
                listCalls += 1;
                return displays === 'none'
                    ? { ok: false, errorCode: 'computer_display_unavailable', error: 'No screen' }
                    : { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            }
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'screenless' }, executor.execute);
        const unsubscribe = projection.subscribe(() => {});
        try {
            await projection.refresh();
            expect(projection.getSnapshot().failure).toBe('computer_display_unavailable');
            // The answer survives the next ordinary read of the (still empty) selection.
            await projection.refresh();
            expect(projection.getSnapshot().failure).toBe('computer_display_unavailable');
            // The owner's next selection answer clears headless state without listing windows.
            displays = 'present';
            await projection.refresh();
            expect(projection.getSnapshot().failure).toBeNull();
            const answered = listCalls;
            await projection.refresh();
            expect(listCalls).toBe(answered);
            expect(listCalls).toBe(0);
        } finally { unsubscribe(); }
    });
    it('opens and refreshes an unshared screenful Machine with zero picker listing reads', async () => {
        let listCalls = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async ({ actionId }) => {
            if (actionId === 'computer.target.get') return unselected;
            if (actionId === 'computer.targets.list') {
                listCalls += 1;
                return { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            }
            throw new Error(`Unexpected remote Computer Action: ${actionId}`);
        } }));
        for (let mount = 0; mount < 2; mount += 1) {
            const projection = getComputerSessionProjection({ machineId: 'machine', sessionId: 'screenful' }, executor.execute);
            const unsubscribe = projection.subscribe(() => {});
            try {
                await projection.refresh();
                await projection.refresh();
                expect(projection.getSnapshot()).toMatchObject({ selection: unselected, failure: null });
                expect(listCalls).toBe(0);
            } finally { unsubscribe(); }
        }
    });
});
