import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox, replayApprovedAsDaemon } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

// The daemon RPC is the physical-process boundary; policy, Artifact CAS, pane
// state, binding validation and original receipt delivery remain real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ method: string; serverId: string; machineId: string;
        payload: Readonly<{ artifactId: string }>; signal?: AbortSignal }>) => {
        if (request.method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED) return replayApprovedAsDaemon({
            serverId: request.serverId, machineId: request.machineId, artifactId: request.payload.artifactId, signal: request.signal,
        });
        return rpc(request);
    },
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useMachineTerminalActionAdmission } = await import('./useMachineTerminalActionAdmission');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { buildProjectTerminalKey } = await import('@/components/projects/detail/projectTerminalScope');
const { invokeSessionTerminalAction } = await import('@/components/sessions/terminal/sessionTerminalActions');
const { readSessionTerminalWorkspaceForScope, registerSessionTerminalSplitMeasurements, initializeSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
const { EMPTY_TERMINAL_WORKSPACE } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { inspectMachineTerminalMemberApproval } = await import('@/components/sessions/terminal/machineTerminalApproval');
const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
const { buildApprovalRequestArtifactHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
const { createDeferred } = await import('@/dev/testkit');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useMachineTerminalSession } = await import('./useMachineTerminalSession');

const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>;
async function setup() {
    const serverId = await harness.addHome({ name: 'Project Home', serverUrl: 'https://project-approval-continuity.test',
        serverIdentityId: 'srv_project-approval-continuity', accountId: 'bob' });
    harness.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'machine', accountId: 'bob' })] });
    await harness.requireUiApproval(serverId, 'machines.terminal.open');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Expected admitted Account scope');
    const workspace = { serverId: scope.serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: workspace.workspaceId, serverId: workspace.serverId,
        machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }] });
    const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
    const host = await renderHook(() => null, { wrapper });
    const outcome: { result?: Awaited<ReturnType<typeof invokeSessionTerminalAction>> } = {};
    await act(async () => { outcome.result = await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: {
        scopeId, target: { kind: 'workspace_shell', workspace },
    } }); });
    const opened = outcome.result;
    if (!opened || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Expected admitted member');
    const memberId = opened.terminalId;
    const terminalKey = buildProjectTerminalKey(scope, workspace, memberId);
    const input = { terminalKey, workspace, scopeId, memberId };
    const request = { terminalKey, workspace, cwd: workspace.rootPath, cols: 80, rows: 24 };
    return { serverId, scope, workspace, scopeId, memberId, input, request, host };
}

describe('pending terminal creation follows its existing member, not its mounted view', () => {
    let disposeLoader: (() => void) | undefined;
    afterEach(() => { disposeLoader?.(); disposeLoader = undefined; });
    beforeEach(async () => { await standardCleanup(); await harness.reset();
        storage.getState().applyLocalSettings({ appPaneScopesV1: {} });
        disposeLoader = await installRealActionExecutorModuleLoader();
        rpc.mockReset();
        rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_TERMINAL_LIST
            ? { ok: true, terminals: [] } : { ok: true, terminalId: 'requester-pty', reused: false }); });
    it.each(['session.terminals.open', 'session.terminals.split', 'session.terminals.run_script'] as const)(
        '%s keeps the original Agent Machine policy before committing a process-producing pane intent', async actionId => {
            const fixture = await setup();
            const scope = fixture.scope;
            storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1, actions: {},
                approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] },
            } }), 2);
            const retireMeasurement = registerSessionTerminalSplitMeasurements(fixture.scopeId,
                () => ({ availableWidthPx: 1000, minimumTerminalWidthPx: 320 }));
            let issuance: ReturnType<typeof invokeSessionTerminalAction> | undefined;
            let artifactId: string | undefined;
            try {
                const input = actionId === 'session.terminals.run_script'
                    ? { scopeId: fixture.scopeId, machineId: fixture.workspace.machineId, cwd: fixture.workspace.rootPath, runTargetId: 'test-script' }
                    : { scopeId: fixture.scopeId, target: { kind: 'workspace_shell', workspace: fixture.workspace } };
                issuance = invokeSessionTerminalAction({ actionId, input, context: {
                    surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: fixture.serverId,
                } });
                await waitForHomeGovernance(() => expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1));
                const artifact = harness.artifacts(fixture.serverId).list()[0];
                artifactId = artifact.id;
                const stored = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifact.id)!));
                // A durable owned member cannot associate its Artifact if the
                // initial issuance stage itself waits for the human decision.
                expect(stored.approval).toEqual({ flow: 'deferred', result: 'required' });
                const result = await issuance;
                expect(result).toMatchObject({ ok: true });
                if (!('terminalId' in result) || typeof result.terminalId !== 'string') throw new Error('Expected pending pane member');
                expect(stored).toMatchObject({
                    actionId: 'machines.terminal.open', status: 'open',
                    executionOriginV1: { surface: 'agent', authority: 'account_automation', caller: { kind: 'host' } },
                    actionArgs: { workspace: fixture.workspace,
                        ...(actionId === 'session.terminals.run_script' ? { launch: { kind: 'package_script', runTargetId: 'test-script' } } : {}),
                    },
                });
                expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals)
                    .find(member => member.id === result.terminalId)?.pendingActionApproval).toEqual({
                        scope, artifactId: artifact.id, actionId: 'machines.terminal.open',
                    });
                expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
            } finally {
                // Settle a still-blocking real Ask even when the deciding flow
                // assertion fails, so the next owner case inherits no waiter.
                if (artifactId) await decideApprovalAsInbox(fixture.serverId, artifactId, 'cancel');
                await issuance;
                retireMeasurement(); await fixture.host.unmount();
            }
        });
    it('keeps an Agent restart under Ask first when only the UI Machine policy is waived', async () => {
        const fixture = await setup();
        const scope = fixture.scope;
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1, actions: {},
            approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'], 'machines.terminal.restart': ['ui'] },
        } }), 2);
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return { ok: true, terminals: [] };
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) return { ok: true, terminalId: 'requester-pty',
                frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true };
            return { ok: true, terminalId: 'requester-pty', reused: false };
        });
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
        const hook = await renderHook(() => useMachineTerminalSession({ ...fixture.input, machineId: fixture.workspace.machineId,
            cwd: fixture.workspace.rootPath, terminalRef }));
        let remount: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useMachineTerminalActionAdmission>>>> | undefined;
        let observed: Promise<Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>>> | undefined;
        const interest = new AbortController();
        try {
            await act(async () => { hook.getCurrent().onReady(80, 24); });
            await waitForHomeGovernance(() => expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(true));
            // This is the host-stamped Agent origin, not public Action input. UI
            // Always allow must not be borrowed by a mounted Agent restart.
            await act(async () => { hook.getCurrent().requestRestart({ surface: 'agent',
                authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: fixture.serverId }); });
            await waitForHomeGovernance(() => expect(harness.artifacts(fixture.serverId).list().length > 0
                || rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_RESTART)).toBe(true));
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_RESTART)).toBe(false);
            const artifact = harness.artifacts(fixture.serverId).list()[0];
            expect(artifact).toBeDefined();
            expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifact.id)!)).toMatchObject({
                actionId: 'machines.terminal.restart', status: 'open',
                executionOriginV1: { surface: 'agent', authority: 'account_automation', caller: { kind: 'host' } },
            });
            // The creation-ACK race has its own held network case below. Here
            // hide an actual associated pending member, as the Frame presents it.
            await waitForHomeGovernance(() => expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs
                .flatMap(tab => tab.terminals).find(member => member.id === fixture.memberId)?.pendingActionApproval)
                .toMatchObject({ artifactId: artifact.id, actionId: 'machines.terminal.restart' }));
            await hook.unmount();
            remount = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
            const outcome: { result?: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> } = {};
            observed = remount.getCurrent().admit(fixture.request, false, interest.signal).then(result => { outcome.result = result; return result; });
            await waitForHomeGovernance(() => expect(Boolean(outcome.result) || remount?.getCurrent().approvalPending).toBe(true));
            expect(outcome.result).toBeUndefined();
            expect(remount.getCurrent()).toMatchObject({ approvalPending: true, approvalId: artifact.id });
            expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1);
        } finally { interest.abort(); await observed; await remount?.unmount(); await hook.unmount(); await fixture.host.unmount(); }
    });
    it('keeps pending creation when its view hides before acknowledgement', async () => {
        const fixture = await setup();
        storage.getState().applySettingsForScope(fixture.scope, settingsParse({
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } },
        }), 2);
        const acknowledgement = createDeferred<void>();
        harness.artifacts(fixture.serverId).afterNextCreate(() => acknowledgement.promise);
        const first = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const firstInterest = new AbortController();
        const issued = first.getCurrent().admit(fixture.request, true, firstInterest.signal, {
            surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: fixture.serverId,
        });
        await waitForHomeGovernance(() => expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(fixture.serverId).list()[0].id;
        firstInterest.abort(); await issued; await first.unmount();
        const returning = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const outcome: { result?: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> } = {};
        const observing = returning.getCurrent().admit(fixture.request, false, interest.signal)
            .then(result => { outcome.result = result; });
        try {
            acknowledgement.resolve();
            await waitForHomeGovernance(() => expect(Boolean(outcome.result) || returning.getCurrent().approvalPending).toBe(true));
            expect(outcome.result).toBeUndefined();
            expect(returning.getCurrent()).toMatchObject({ approvalPending: true, approvalId: artifactId });
            expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1);
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
        } finally { acknowledgement.resolve(); interest.abort(); await observing; await returning.unmount(); await fixture.host.unmount(); }
    });
    it('keeps the owned member while a stored but unacknowledged creation is claimed by another Inbox', async () => {
        const fixture = await setup();
        const acknowledgement = createDeferred<void>();
        const physical = createDeferred<unknown>();
        harness.artifacts(fixture.serverId).afterNextCreate(() => acknowledgement.promise);
        rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
            ? physical.promise : Promise.resolve({ ok: true, terminals: [] }));
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        await waitForHomeGovernance(() => expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(fixture.serverId).list()[0].id;
        const closing = invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: {
            scopeId: fixture.scopeId, terminalId: fixture.memberId,
        } });
        const execution = decideApprovalAsInbox(fixture.serverId, artifactId, 'approve');
        try {
            await waitForHomeGovernance(() => expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'executing' }));
            expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals)
                .some(member => member.id === fixture.memberId)).toBe(true);
            acknowledgement.resolve();
            expect(await closing).toMatchObject({ ok: false, errorCode: 'terminal_approval_cancellation_pending' });
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(false);
            physical.resolve({ ok: true, terminalId: 'requester-pty', reused: false });
            await execution;
            expect(await waiting).toMatchObject({ ok: true, terminalId: 'requester-pty' });
        } finally {
            acknowledgement.resolve(); physical.resolve({ ok: true, terminalId: 'requester-pty', reused: false });
            await execution; await closing;
            interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount();
        }
    });
    it('reattaches the current requester-owned process after an executed receipt without asking to create it again', async () => {
        const fixture = await setup();
        const first = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const waiting = first.getCurrent().admit(fixture.request, false, new AbortController().signal);
        await waitForHomeGovernance(() => expect(first.getCurrent().approvalPending).toBe(true));
        const artifactId = first.getCurrent().approvalId!;
        expect(await decideApprovalAsInbox(fixture.serverId, artifactId, 'approve')).toMatchObject({ ok: true });
        expect(await waiting).toMatchObject({ ok: true, terminalId: 'requester-pty' });
        await first.unmount();
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { workspace?: typeof fixture.workspace } }) => method === RPC_METHODS.DAEMON_TERMINAL_LIST
            ? { ok: true, terminals: [{ terminalId: payload.workspace?.workspaceId === fixture.workspace.workspaceId ? 'requester-pty' : 'other-project-pty', terminalKey: fixture.request.terminalKey,
                cwd: fixture.workspace.rootPath, ended: false, exit: null }] }
            : { ok: true, terminalId: 'unexpected-second-pty', reused: false });
        const remount = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const outcome: { result?: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> } = {};
        const second = remount.getCurrent().admit(fixture.request, false, interest.signal).then(result => { outcome.result = result; });
        try {
            await waitForHomeGovernance(() => expect(Boolean(outcome.result) || remount.getCurrent().approvalPending).toBe(true));
            expect(remount.getCurrent().approvalPending).toBe(false);
            expect(outcome.result).toMatchObject({ ok: true, terminalId: 'requester-pty', reused: true });
            expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1);
        } finally { interest.abort(); await second; await remount.unmount(); await fixture.host.unmount(); }
    });
    it('preserves the actual pending Artifact across view hide and consumes its one receipt after remount', async () => {
        const fixture = await setup();
        const first = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = first.getCurrent().admit(fixture.request, false, interest.signal);
        await waitForHomeGovernance(() => expect(first.getCurrent().approvalPending).toBe(true));
        const artifactId = first.getCurrent().approvalId!;
        interest.abort();
        await waiting;
        await first.unmount();
        expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
        expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
        const remount = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const receipt = remount.getCurrent().admit({ ...fixture.request, cols: 120 }, false, new AbortController().signal);
        await waitForHomeGovernance(() => expect(remount.getCurrent().approvalId).toBe(artifactId));
        expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1);
        expect(await decideApprovalAsInbox(fixture.serverId, artifactId, 'approve')).toMatchObject({ ok: true });
        expect(await receipt).toMatchObject({ ok: true, terminalId: 'requester-pty' });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_ENSURE }));
        expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toHaveLength(1);
        await waitForHomeGovernance(() => expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs
            .flatMap(tab => tab.terminals).find(member => member.id === fixture.memberId)?.pendingActionApproval).toBeUndefined());
        await remount.unmount(); await fixture.host.unmount();
    });
    it('withdraws the actual pending approval on explicit member close before any PTY is created', async () => {
        const fixture = await setup();
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalPending).toBe(true));
            const artifactId = hook.getCurrent().approvalId!;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: {
                scopeId: fixture.scopeId, terminalId: fixture.memberId,
            } })).toMatchObject({ ok: true });
            expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'canceled' });
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
                || request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(false);
        } finally { interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount(); }
    });
    it('retains the member while the physical open is already claimed instead of reporting cancellation', async () => {
        const fixture = await setup();
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalPending).toBe(true));
        const artifactId = hook.getCurrent().approvalId!;
        const physical = createDeferred<unknown>();
        rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
            ? physical.promise : Promise.resolve({ ok: true, terminals: [] }));
        const execution = decideApprovalAsInbox(fixture.serverId, artifactId, 'approve');
        try {
            await waitForHomeGovernance(() => expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'executing' }));
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: {
                scopeId: fixture.scopeId, terminalId: fixture.memberId,
            } })).toMatchObject({ ok: false, errorCode: 'terminal_approval_cancellation_pending' });
            expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals).map(member => member.id)).toContain(fixture.memberId);
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(false);
        } finally {
            physical.resolve({ ok: true, terminalId: 'requester-pty', reused: false });
            await execution; interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount();
        }
    });
    it('keeps the member when a cancellation write loses its acknowledgement', async () => {
        const fixture = await setup();
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        await waitForHomeGovernance(() => expect(hook.getCurrent().approvalPending).toBe(true));
        const artifactId = hook.getCurrent().approvalId!;
        harness.answer(fixture.serverId, `POST /v1/artifacts/${encodeURIComponent(artifactId)}`, { dispatchThenFail: true });
        expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: {
            scopeId: fixture.scopeId, terminalId: fixture.memberId,
        } })).toMatchObject({ ok: false });
        expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals).map(member => member.id)).toContain(fixture.memberId);
        expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(false);
        interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount();
    });
    it('does not let an Agent member close borrow present-user authority to cancel a pending Artifact', async () => {
        const fixture = await setup();
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalPending).toBe(true));
            const artifactId = hook.getCurrent().approvalId!;
            const closed = await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: {
                scopeId: fixture.scopeId, terminalId: fixture.memberId,
            }, context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId: fixture.serverId, runtimeAccountId: 'bob', bypassApprovals: true } });
            expect(closed).toMatchObject({ ok: false });
            expect(JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
            expect(readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals)
                .some(member => member.id === fixture.memberId)).toBe(true);
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
                || request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(false);
        } finally { interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount(); }
    });
    it('retains an admitted Agent split when its original target tab closes during Artifact issuance', async () => {
        const fixture = await setup();
        const targetTab = readSessionTerminalWorkspaceForScope(fixture.scopeId)!.tabs[0].id;
        const retireMeasurements = registerSessionTerminalSplitMeasurements(fixture.scopeId,
            () => ({ availableWidthPx: 1000, minimumTerminalWidthPx: 320 }));
        const acknowledgement = createDeferred<void>();
        harness.artifacts(fixture.serverId).afterNextCreate(() => acknowledgement.promise);
        let spawnedTerminalKey: string | undefined;
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { terminalKey?: string } }) => {
            if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return { ok: true, terminals: [] };
            spawnedTerminalKey = payload.terminalKey;
            return { ok: true, terminalId: 'retained-split-pty', reused: false };
        });
        const interest = new AbortController();
        const split = invokeSessionTerminalAction({ actionId: 'session.terminals.split', input: {
            scopeId: fixture.scopeId, tabId: targetTab, target: { kind: 'workspace_shell', workspace: fixture.workspace },
        }, context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            serverId: fixture.serverId, runtimeAccountId: 'bob', actionRequestId: 'split-target-close' }, signal: interest.signal });
        try {
            await waitForHomeGovernance(() => expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(fixture.serverId).list()[0].id;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close_tab', input: {
                scopeId: fixture.scopeId, tabId: targetTab,
            } })).toMatchObject({ ok: true });
            acknowledgement.resolve();
            expect(await decideApprovalAsInbox(fixture.serverId, artifactId, 'approve')).toMatchObject({ ok: true });
            const outcome = await split;
            expect(outcome).toMatchObject({ ok: true });
            if (!('terminalId' in outcome) || !outcome.terminalId) throw new Error('Expected retained admitted member identity');
            const retained = readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs
                .flatMap(tab => tab.terminals).find(member => member.id === outcome.terminalId);
            expect(retained).toMatchObject({ target: { kind: 'workspace_shell', workspace: fixture.workspace } });
            const artifact = JSON.parse(harness.artifacts(fixture.serverId).readPlainBody(artifactId)!);
            expect(artifact).toMatchObject({ actionId: 'machines.terminal.open', status: 'executed',
                actionArgs: { workspace: fixture.workspace }, executionOriginV1: { surface: 'agent' } });
            expect(spawnedTerminalKey).toBe(buildProjectTerminalKey(fixture.scope, fixture.workspace, outcome.terminalId));
            if (retained?.pendingActionApproval) expect(retained.pendingActionApproval.artifactId).toBe(artifactId);
            expect(harness.artifacts(fixture.serverId).list()).toHaveLength(1);
        } finally { acknowledgement.resolve(); interest.abort(); await split; retireMeasurements(); await fixture.host.unmount(); }
    });
    it('refuses an original caller Home mismatch before reading the qualified Session Home', async () => {
        const callerHome = await harness.addHome({ name: 'Caller Home', serverUrl: 'https://terminal-caller-home.test', accountId: 'bob', active: false });
        const fixture = await setup();
        const scopeId = createSessionPaneScopeId('session-b', fixture.serverId);
        expect(initializeSessionTerminalWorkspaceForScope(scopeId, EMPTY_TERMINAL_WORKSPACE)).toBe(true);
        const baseline = harness.requests.length;
        const interest = new AbortController();
        const observed: { result?: Awaited<ReturnType<typeof invokeSessionTerminalAction>> } = {};
        const operation = invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: {
            scopeId, target: { kind: 'machine_shell', machineId: 'machine', cwd: '/repo' },
        }, context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            serverId: callerHome, runtimeAccountId: 'bob', actionRequestId: 'wrong-home' }, signal: interest.signal })
            .then(result => { observed.result = result; return result; });
        try {
            await waitForHomeGovernance(() => expect(Boolean(observed.result)
                || harness.artifacts(fixture.serverId).list().length > 0).toBe(true));
            expect(harness.requests.slice(baseline).filter(request => request.serverId === fixture.serverId)).toEqual([]);
            expect(observed.result).toMatchObject({ ok: false, errorCode: 'terminal_scope_unavailable' });
            expect(harness.artifacts(fixture.serverId).list()).toHaveLength(0);
            expect(rpc).not.toHaveBeenCalled();
        } finally { interest.abort(); await operation; await fixture.host.unmount(); }
    });
    it('binds a canonical pending Artifact whose descriptive requested surface is omitted', async () => {
        const fixture = await setup();
        const hook = await renderHook(() => useMachineTerminalActionAdmission(fixture.input));
        const interest = new AbortController();
        const waiting = hook.getCurrent().admit(fixture.request, false, interest.signal);
        const account = await captureLazyActionAccountContext(fixture.serverId);
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalPending).toBe(true));
            const artifact = await account.fetchArtifact(hook.getCurrent().approvalId!);
            if (typeof artifact?.body !== 'string') throw new Error('Expected inline real pending approval Artifact');
            const member = readSessionTerminalWorkspaceForScope(fixture.scopeId)?.tabs.flatMap(tab => tab.terminals)
                .find(member => member.id === fixture.memberId);
            if (!member?.pendingActionApproval) throw new Error('Expected actual member Artifact association');
            // Persisted V2 permits an omitted descriptive surface. Keep the
            // genuine immutable origin/input and use its canonical writer/schema.
            const request = ApprovalRequestV2Schema.parse({ ...JSON.parse(artifact.body), requestedSurface: undefined });
            const observed = inspectMachineTerminalMemberApproval({ artifact: { ...artifact,
                header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            }, pending: member.pendingActionApproval, machineId: fixture.workspace.machineId, request: fixture.request });
            expect(observed).toMatchObject({ v: 2, status: 'open', actionId: 'machines.terminal.open',
                executionOriginV1: request.executionOriginV1 });
        } finally { account.dispose(); interest.abort(); await waiting; await hook.unmount(); await fixture.host.unmount(); }
    });
});
