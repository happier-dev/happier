import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { OverlayPortalProvider, OverlayPortalHost } from '@/components/ui/popover/OverlayPortal';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance as waitForHomeGovernanceRequests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn() }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Authenticated remote daemon and recipient-envelope HTTP are genuine boundaries.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc.machine }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: rpc.session }));
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Stop unexpectedly reached recipient-envelope HTTP'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { requestActionOperationStop, requestAcceptedActionOperationStop } = await import('./requestActionOperationStop');
const { useActionOperationStopControl } = await import('./useActionOperationStopControl');
const { ActionOperationLedgerView } = await import('./ActionOperationLedger');
const { ActionOperationDetailControls } = await import('./ActionOperationDetailControls');
const { projectActionOperationDetail } = await import('./actionOperationDetailPresentation');
const { WorkItemRow } = await import('@/components/sessions/work/WorkItemRow');
const { projectWork, resolveWorkItemContextActions } = await import('@/components/sessions/work/workProjection');

function WorkRowPortal(props: React.PropsWithChildren) {
    return React.createElement(OverlayPortalProvider, null, props.children, React.createElement(OverlayPortalHost));
}

// Host layout measurement is an OS/renderer boundary; the real Popover and menu run beneath it.
function createMeasuredWorkHost() {
    return {
        measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(20, 20, 600, 44),
        getBoundingClientRect: () => ({ left: 20, top: 20, width: 600, height: 44 }),
    };
}

// Home request polling inherits the runner deadline; mounted state also needs the canonical act flush.
function waitForHomeGovernance(assertion: () => void) {
    return waitForHomeGovernanceRequests(async () => {
        await flushHookEffects();
        assertion();
    });
}


function operation(serverId: string): ActionOperationProjection {
    return {
        serverId,
        snapshot: {
            version: 1,
            operationId: 'operation-1',
            revision: 1,
            actionId: 'session.fork',
            state: 'running',
            scope: { accountId: 'alice', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Fork session',
            createdAt: 1,
            startedAt: 2,
            cancellation: 'supported',
        },
        observation: 'available',
        isUnavailableProjection: false,
    };
}

describe('requestActionOperationStop', () => {
    beforeEach(async () => { await harness.reset(); actionOperationStore.reset(); rpc.machine.mockReset(); rpc.session.mockReset(); });
    afterEach(() => standardCleanup());

    it('routes through the operation transport Home rather than ambient focus', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
        } }, version: 1 } });
        await harness.addHome({ name: 'Ambient', serverUrl: 'https://ambient.test', accountId: 'alice' });
        rpc.machine.mockResolvedValue({ kind: 'requested' });
        await expect(requestActionOperationStop(operation(serverId))).resolves.toEqual({ kind: 'requested' });

        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'actionOperation.cancel.v1', payload: { operationId: 'operation-1' }, serverId,
        }));
    });

    it('returns canonical deferred approval custody without dispatching Stop', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test',
            accountId: 'alice', serverIdentityId: 'origin-identity' });
        const result = await requestActionOperationStop(operation(serverId));
        expect(result).toMatchObject({ kind: 'approval_request_created', actionId: 'action.operations.cancel' });
        expect(rpc.machine).not.toHaveBeenCalled();
    });


    it('holds the real row Stop through deferred approval without opening detail', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        let opened = false;
        const screen = await renderScreen(React.createElement(ActionOperationLedgerView, {
            operations: [operation(serverId)], onOpenOperation: () => { opened = true; },
            onCancelOperation: requestAcceptedActionOperationStop,
        }));
        await screen.pressByTestIdAsync('action-operation-stop.operation-1');
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        expect(opened).toBe(false);
        expect(rpc.machine).not.toHaveBeenCalled();
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        rpc.machine.mockResolvedValue({ kind: 'requested' });
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledOnce());
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-1', method: 'actionOperation.cancel.v1' }));
    });

    it('joins the real deferred replay and releases rejected or retired mounted interest without dispatch', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        // A mounted active-Home reader observes decision writes through the real Account-scoped Artifact store.
        await harness.requireUiApproval(serverId, 'action.operations.cancel');
        let target = operation(serverId);
        const hook = await renderHook(() => useActionOperationStopControl(target));
        act(() => hook.getCurrent().requestStop());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval).not.toBeNull());
        expect(hook.getCurrent().pending).toBe(true);
        expect(rpc.machine).not.toHaveBeenCalled();
        const firstId = hook.getCurrent().pendingApproval!.artifactId;
        expect(await decideApprovalAsInbox(serverId, firstId, 'reject')).toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        expect(hook.getCurrent().feedback).toBe('failed');
        expect(hook.getCurrent().failureCode).toBe('approval_rejected');
        expect(rpc.machine).not.toHaveBeenCalled();
        rpc.machine.mockResolvedValue({ kind: 'requested' });
        act(() => hook.getCurrent().requestStop());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval).not.toBeNull());
        const secondId = hook.getCurrent().pendingApproval!.artifactId;
        expect(secondId).not.toBe(firstId);
        expect(await decideApprovalAsInbox(serverId, secondId, 'approve')).toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().feedback).toBe('requested'));
        expect(hook.getCurrent().pending).toBe(false);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-1', method: 'actionOperation.cancel.v1' }));
        rpc.machine.mockClear();
        target = { ...target, snapshot: { ...target.snapshot, revision: 2,
            observation: { kind: 'stop_unconfirmed', code: 'terminal_stop_failed' } } };
        await hook.rerender();
        act(() => hook.getCurrent().requestStop());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval).not.toBeNull());
        await act(async () => { await harness.switchAccount(serverId, 'bob'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        expect(hook.getCurrent().failureCode).toBeNull();
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('fails closed without exact Home evidence', async () => {

        await expect(requestActionOperationStop({
            ...operation('home-a'),
            serverId: '',
        })).resolves.toEqual({ kind: 'not_found' });
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('never adopts the replacement Account when retirement occurs during approval creation', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        const responseGate = createDeferred<void>();
        const answer = { respondAfter: responseGate.promise, body: undefined as unknown };
        harness.answer(serverId, 'POST /v1/artifacts', answer);
        const hook = await renderHook(() => useActionOperationStopControl(operation(serverId)));
        act(() => hook.getCurrent().requestStop());
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/artifacts')).toHaveLength(1));
        const dispatched = harness.requestsFor('/v1/artifacts')[0]!;
        // Persist through the real Artifact boundary before delaying its acknowledgement.
        const response = await harness.artifacts(serverId).handle('/v1/artifacts', {
            method: 'POST', body: JSON.stringify(dispatched.input),
        });
        if (!response) throw new Error('Expected the Artifact create boundary');
        answer.body = await response.json();
        await act(async () => { await harness.switchAccount(serverId, 'bob'); responseGate.resolve(undefined); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        expect(hook.getCurrent().pendingApproval).toBeNull();
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('refuses a retained prior-Account target before any new approval or cancellation effect', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        const retained = operation(serverId);
        await harness.switchAccount(serverId, 'bob');
        await expect(requestActionOperationStop(retained)).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        const hook = await renderHook(() => useActionOperationStopControl(retained));
        act(() => hook.getCurrent().requestStop());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        expect(hook.getCurrent().failureCode).toBe('action_account_scope_changed');
        expect(hook.getCurrent().pendingApproval).toBeNull();
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('re-enables explicit Stop only after the owner reports stop unconfirmed, without settling the operation', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
        } }, version: 1 } });
        rpc.machine.mockResolvedValue({ kind: 'requested' });
        const accepted: ActionOperationProjection = {
            ...operation(serverId),
            snapshot: { ...operation(serverId).snapshot, state: 'accepted',
                scope: { accountId: 'alice', machineId: 'machine-1', sessionId: 'session-1' } },
        };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [accepted.snapshot] });
        actionOperationStore.setMachineObservation({ serverId, machineId: 'machine-1' }, 'available');
        function ObservedControls() {
            const target = useActionOperation({ serverId, operationId: 'operation-1' });
            return target ? React.createElement(ActionOperationDetailControls, {
                operation: target, terminal: false,
                canCancel: projectActionOperationDetail(target.snapshot, target.observation).canCancel,
                onClose: () => {},
            }) : null;
        }
        const screen = await renderScreen(React.createElement(ObservedControls));
        await screen.pressByTestIdAsync('action-operation-cancel');
        await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledOnce());
        expect(screen.findByTestId('action-operation-cancel')?.props.disabled).toBe(true);
        const unconfirmed: ActionOperationProjection = {
            ...accepted, observation: 'unavailable',
            snapshot: { ...accepted.snapshot, revision: 2, observation: { kind: 'stop_unconfirmed', code: 'terminal_stop_failed' } },
        };
        await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [unconfirmed.snapshot] }); });
        expect(screen.findByTestId('action-operation-cancel')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('action-operation-cancel');
        await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledTimes(2));
        for (const [request] of rpc.machine.mock.calls) {
            expect(request).toMatchObject({ serverId, machineId: 'machine-1',
                method: 'actionOperation.cancel.v1', payload: { operationId: 'operation-1' } });
        }
        expect([...actionOperationStore.getSnapshot().operationsByKey.values()][0]?.snapshot).toMatchObject({
            state: 'accepted', revision: 2, observation: { kind: 'stop_unconfirmed' },
        });
    });

    it('requests contextual Work Stop before output exists and joins approval without opening or settling the row', async () => {
        const serverId = await harness.addHome({ name: 'Origin', serverUrl: 'https://origin.test', accountId: 'alice' });
        const accepted: ActionOperationProjection = {
            ...operation(serverId),
            snapshot: {
                ...operation(serverId).snapshot, actionId: 'projects.script.run', state: 'accepted',
                scope: { accountId: 'alice', machineId: 'machine-1', sessionId: 'session-1' },
                domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: 'machine-1',
                    workspaceRefId: 'workspace', cwd: '/repo' },
            },
        };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [accepted.snapshot] });
        const project = (target: ActionOperationProjection) => projectWork({ sessionId: 'session-1', serverId, accountId: 'alice',
            actionOperations: [target], reportSessions: [], agentEntries: [], workflowHeadlineRuns: [],
            managedRuns: [], ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '' });
        const projected = project(accepted);
        const item = projected.projectCommands[0];
        if (!item) throw new Error('Expected the admitted command Work row');
        let opened = false;
        let openedTarget: React.ComponentProps<typeof WorkItemRow>['item']['open'] | null = null;
        let transcript: ReturnType<typeof resolveWorkItemContextActions>['transcript'] = null;
        const onOpen: React.ComponentProps<typeof WorkItemRow>['onOpen'] = target => {
            opened = true;
            openedTarget = target.open;
        };
        const onShowInTranscript: React.ComponentProps<typeof WorkItemRow>['onShowInTranscript'] = target => {
            transcript = resolveWorkItemContextActions(target).transcript;
        };
        const row = (target: React.ComponentProps<typeof WorkItemRow>['item']) => React.createElement(WorkItemRow, { item: target, onOpen, onShowInTranscript });
        const screen = await renderScreen(row(item), { wrapper: WorkRowPortal, createNodeMock: createMeasuredWorkHost });
        act(() => invokeTestInstanceHandler(screen.findByTestId(`session-work-row:${item.key}`), 'onLongPress'));
        await screen.pressByTestIdAsync(`session-work-stop:${item.key}`);
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        expect(opened).toBe(false);
        expect(rpc.machine).not.toHaveBeenCalled();
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        rpc.machine.mockResolvedValue({ kind: 'requested' });
        await decideApprovalAsInbox(serverId, artifactId, 'approve');
        await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledOnce());
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-1',
            method: 'actionOperation.cancel.v1', payload: { operationId: 'operation-1' } }));
        expect(opened).toBe(false);
        expect([...actionOperationStore.getSnapshot().operationsByKey.values()][0]?.snapshot.state).toBe('accepted');
        act(() => invokeTestInstanceHandler(screen.findByTestId(`session-work-row:${item.key}`), 'onLongPress'));
        await screen.pressByTestIdAsync(`session-work-open:${item.key}`);
        await waitForHomeGovernance(() => expect(opened).toBe(true));
        expect(openedTarget).toEqual({ kind: 'action_operation', serverId, operationId: 'operation-1' });
        act(() => invokeTestInstanceHandler(screen.findByTestId(`session-work-row:${item.key}`), 'onLongPress'));
        await screen.pressByTestIdAsync(`session-work-transcript:${item.key}`);
        await waitForHomeGovernance(() => expect(transcript).toEqual({ serverId, sessionId: 'session-1' }));
        const terminalItem = project({ ...accepted, snapshot: { ...accepted.snapshot, revision: 2, state: 'cancelled', settledAt: 3 } }).projectCommands[0];
        if (!terminalItem) throw new Error('Expected the retained terminal Work row');
        await screen.update(row(terminalItem));
        act(() => invokeTestInstanceHandler(screen.findByTestId(`session-work-row:${item.key}`), 'onLongPress'));
        expect(screen.findAllHostsByTestId(`session-work-stop:${item.key}`)).toHaveLength(0);
        expect(screen.findByTestId(`session-work-open:${item.key}`)).not.toBeNull();
        expect(screen.findByTestId(`session-work-transcript:${item.key}`)).not.toBeNull();
    });
});
