import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import type { WorkflowRunNowRequest } from './useWorkflowRunNowController';

const executeMock = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

const accountHost = vi.hoisted(() => ({ serverId: 'server-a', available: true }));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => executeMock,
}));
vi.mock('@/modal', () => ({ Modal: { alert: modalAlertSpy } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: accountHost.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => accountHost.available,
}));

function setAccountScope(scope: { serverId: string; accountId: string } | null): void {
    // Model the host reset using the real lifetime owner, not a fake generation.
    retireActiveServerAccountScopeLifetime();
    accountHost.serverId = scope?.serverId ?? '';
    accountHost.available = scope !== null;
    storage.setState({ profileScope: scope });
}

/** The one Run UUID the caller allocates for an explicit admission attempt. */
const RUN_ID = '00000000-0000-4000-8000-000000000001';

// Not `as const`: the canonical ingress request takes mutable arrays, and a
// readonly literal would only be assignable through a cast.
const source: WorkflowRunNowRequest['source'] = {
    kind: 'inline',
    definition: { blocks: ['Do the thing'] },
};

function admitted(admission: 'created' | 'existing') {
    return {
        ok: true,
        result: {
            run: createWorkflowRunSummaryFixture({ id: RUN_ID, origin: { kind: 'direct' } }),
            admission,
        },
    };
}

describe('useWorkflowRunNowController', () => {
    it('admits the reviewed role overrides rather than silently using the Account roles', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        const roleOverrides = [{ roleId: 'builder', runsAs: { kind: 'background_run' as const, intent: 'delegate' as const } }];
        await act(async () => {
            await hook.getCurrent().runNow({ runId: RUN_ID, source, roleOverrides });
        });
        expect(executeMock.mock.calls[0]?.[1]).toMatchObject({ roleOverrides });
    });
    beforeEach(() => {
        setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        storage.setState({ workflowRunsById: {} });
    });

    afterEach(() => {
        vi.useRealTimers();
        executeMock.mockReset();
        modalAlertSpy.mockClear();
        setAccountScope(null);
        storage.setState({ workflowRunsById: {} });
        standardCleanup();
    });

    it('returns the exact admitted handle and stores that Run by its own runId', async () => {
        vi.useFakeTimers();
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let outcome: Awaited<ReturnType<ReturnType<typeof useWorkflowRunNowController>['runNow']>>;
        await act(async () => {
            outcome = await hook.getCurrent().runNow({ runId: RUN_ID, source, metadata: { title: 'Frozen title' } });
        });

        expect(outcome!?.run.id).toBe(RUN_ID);
        expect(outcome!?.admission).toBe('created');
        expect(executeMock.mock.calls[0]?.[0]).toBe('workflow.run.start');
        expect((executeMock.mock.calls[0]?.[1] as { runId: string }).runId).toBe(RUN_ID);
        expect(executeMock.mock.calls[0]?.[1]).toMatchObject({ metadata: { title: 'Frozen title' } });
        // The admitted Run reaches the one Account-scoped row map keyed by runId,
        // so the exact route can open it without any list being loaded.
        expect(storage.getState().workflowRunsById[RUN_ID]?.summary?.id).toBe(RUN_ID);
        expect(storage.getState().workflowRunsById[RUN_ID]?.metadata)
            .toEqual({ kind: 'available', value: { title: 'Frozen title' } });
        // An acknowledgement is command state, not a Run state.
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('acknowledged');
        await act(async () => {
            vi.advanceTimersByTime(2_500);
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });

    it('owns an ordinary start identity until admission settles, then permits a new explicit start', async () => {
        const reply = createDeferred<unknown>();
        executeMock.mockImplementation(async (_action: string, input: { runId: string }) =>
            input.runId === RUN_ID ? admitted('created') : reply.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        let first!: Promise<unknown>;
        await act(async () => { first = hook.getCurrent().runNow({ source }); });
        const firstId = executeMock.mock.calls[0]?.[1].runId;
        expect(firstId).toBeTypeOf('string');
        expect(hook.getCurrent().pendingRunId).toBe(firstId);
        await act(async () => { expect(await hook.getCurrent().runNow({ source })).toBeNull(); });
        expect(executeMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            reply.resolve({ ok: true, result: { admission: 'created', run: createWorkflowRunSummaryFixture({ id: firstId, origin: { kind: 'direct' } }) } });
            await first;
        });
        expect(hook.getCurrent().pendingRunId).toBeNull();
        executeMock.mockImplementation(async (_action: string, input: { runId: string }) => ({ ok: true,
            result: { admission: 'created', run: createWorkflowRunSummaryFixture({ id: input.runId, origin: { kind: 'direct' } }) } }));
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        expect(executeMock.mock.calls[1]?.[1].runId).not.toBe(firstId);
    });

    it('releases its owned identity after a confirmed refusal without affecting explicit recovery IDs', async () => {
        executeMock.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Confirmed not sent' });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        const refusedId = executeMock.mock.calls[0]?.[1].runId;
        expect(hook.getCurrent().pendingRunId).toBeNull();
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        expect(executeMock.mock.calls[1]?.[1].runId).not.toBe(refusedId);
        await act(async () => { await hook.getCurrent().runNow({ runId: RUN_ID, source }); });
        expect(executeMock.mock.lastCall?.[1].runId).toBe(RUN_ID);
    });

    it('keeps a known refusal for the composer instead of interrupting with an alert', async () => {
        executeMock.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Confirmed not sent' });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        await act(async () => { await hook.getCurrent().runNow({ source, refusal: 'inline' }); });
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().refusal?.message).toBe('workflows.problem.targetUnavailable');
        // A new press is a new attempt: the previous reason does not outlive it.
        executeMock.mockResolvedValue(admitted('created'));
        await act(async () => { await hook.getCurrent().runNow({ runId: RUN_ID, source, refusal: 'inline' }); });
        expect(hook.getCurrent().refusal).toBeNull();
    });

    it('stamps the selected project into host context rather than Action input', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        const project = {
            machineId: 'machine-1',
            directory: '/repo/project',
            workspaceRefId: 'workspace-1',
            // Run-again starts from an accepted descriptor. These historical
            // facts are not part of a new ExternalActionTarget.
            checkoutRootPath: '/repo',
            checkout: { kind: 'git_worktree' as const, branchName: 'old-run' },
        };

        await act(async () => {
            await hook.getCurrent().runNow({ runId: RUN_ID, source, project });
        });

        expect(executeMock.mock.calls[0]?.[1]).not.toHaveProperty('project');
        expect(executeMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            surface: 'ui', externalActionTarget: {
                kind: 'machine', machineId: project.machineId,
                project: {
                    machineId: project.machineId,
                    directory: project.directory,
                    workspaceRefId: project.workspaceRefId,
                },
            },
        }));
    });

    it('retires an unresolved admission observer when its Account changes', async () => {
        vi.useFakeTimers();
        executeMock.mockRejectedValueOnce(new WorkflowActionError({ message: 'response lost', rawCode: 'workflow_outcome_unresolved' }));
        executeMock.mockResolvedValue({ ok: false, errorCode: 'run_not_found', error: 'run_not_found' });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        let pending!: Promise<unknown>;
        await act(async () => {
            pending = hook.getCurrent().runNow({ source });
        });
        const runId = executeMock.mock.calls[0]?.[1].runId;
        expect(hook.getCurrent().pendingRunId).toBe(runId);
        expect(hook.getCurrent().stateFor(runId)).toBe('reconciling');
        expect(executeMock).toHaveBeenCalledTimes(2);
        await act(async () => {
            vi.advanceTimersByTime(60_000);
            publishHomeAccountChange('server-a', ['workflow-run:another-run']);
        });
        expect(executeMock).toHaveBeenCalledTimes(2);
        await act(async () => { setAccountScope({ serverId: 'server-b', accountId: 'account-b' }); await pending; });
        expect(hook.getCurrent().pendingRunId).toBeNull();
        publishHomeAccountChange('server-a', [`workflow-run:${runId}`]);
        expect(executeMock).toHaveBeenCalledTimes(2);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(storage.getState().workflowRunsById[runId]).toBeUndefined();
    });

    it('does not dispatch twice while one admission is still in flight', async () => {
        const request = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(request.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let first!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().runNow({ runId: RUN_ID, source });
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

        await act(async () => {
            expect(await hook.getCurrent().runNow({ runId: RUN_ID, source })).toBeNull();
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            request.resolve(admitted('created'));
            await first;
        });
    });

    it('retires a result whose Account scope changed between dispatch and response', async () => {
        const request = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(request.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let invocation!: Promise<unknown>;
        await act(async () => {
            invocation = hook.getCurrent().runNow({ runId: RUN_ID, source });
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

        await act(async () => { setAccountScope({ serverId: 'server-b', accountId: 'account-b' }); });
        let outcome: unknown;
        await act(async () => {
            request.resolve(admitted('created'));
            outcome = await invocation;
        });

        // No navigation handle and no row: another Account's session must not be
        // shown this Run, and no error is surfaced for a retired command.
        expect(outcome).toBeNull();
        expect(storage.getState().workflowRunsById[RUN_ID]).toBeUndefined();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await act(async () => {
            setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });

    it('rejects a malformed admission response instead of navigating to it', async () => {
        // A partially migrated owner answering with a Run body but no admission.
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: { run: createWorkflowRunSummaryFixture({ id: RUN_ID }) },
        });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let outcome: unknown;
        await act(async () => {
            outcome = await hook.getCurrent().runNow({ runId: RUN_ID, source });
        });

        expect(outcome).toBeNull();
        expect(storage.getState().workflowRunsById[RUN_ID]).toBeUndefined();
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });

    it('sends declared inputs and the originating-session completion choice with the admission', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            await hook.getCurrent().runNow({
                runId: RUN_ID,
                source,
                inputs: { branch: 'main' },
                onComplete: { kind: 'originating_session' },
            });
        });

        expect(executeMock.mock.calls[0]?.[1]).toEqual({
            runId: RUN_ID,
            source,
            inputs: { branch: 'main' },
            onComplete: { kind: 'originating_session' },
        });
    });

    it('preserves an explicit Run execution target while omitting the default Session target', async () => {
        executeMock
            .mockResolvedValueOnce(admitted('created'))
            .mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            await hook.getCurrent().runNow({
                runId: RUN_ID,
                source,
                executionTarget: { kind: 'detached_run' },
            });
            await hook.getCurrent().runNow({
                runId: '00000000-0000-4000-8000-000000000002',
                source,
                executionTarget: { kind: 'session' },
            });
        });

        expect(executeMock.mock.calls[0]?.[1]).toEqual({
            runId: RUN_ID,
            source,
            executionTarget: { kind: 'detached_run' },
        });
        expect(executeMock.mock.calls[1]?.[1]).not.toHaveProperty('executionTarget');
    });

    it('does not dispatch without an active Account', async () => {
        setAccountScope(null);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            expect(await hook.getCurrent().runNow({ runId: RUN_ID, source })).toBeNull();
        });

        expect(executeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });
});
