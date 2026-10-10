import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import type {
    AutomationRunNowAdmission,
} from '@/sync/domains/automations/automationTypes';

function admission(
    run: Readonly<{ id: string; state: AutomationRunNowAdmission['run']['state'] }>,
    workflowRun?: AutomationRunNowAdmission['workflowRun'],
): AutomationRunNowAdmission {
    return {
        run: { automationId: 'automation-1', revision: 1, triggerId: null, triggerRetired: false,
            cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1, claimedAt: null, startedAt: null,
            finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null, attempt: 0,
            errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
            replyHandoffState: 'none', replyHandoffAttempt: 0, replyHandoffDueAt: null,
            createdAt: 1, updatedAt: 1, ...run },
        ...(workflowRun === undefined ? {} : { workflowRun }),
    };
}

const runAutomationNowMock = vi.hoisted(() => vi.fn());

type AccountLifetimeState = {
    value: { scope: { serverId: string; accountId: string }; isCurrent: () => boolean } | null;
};

const activeAccountLifetime = vi.hoisted((): AccountLifetimeState => ({ value: null }));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

// Metro's lazy loader and the remote Workflow host port are system boundaries;
// schema admission, Action dispatch and transient-command behavior remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
    const { isApprovalRequiredByActionsSettings } = await import('@happier-dev/protocol/actions/actionApprovalPolicy');
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'workflow.trigger.run_now': ['ui'] } });
    return { ...original, createFrontDoorActionExecute: () => original.createFrontDoorActionExecute(createActionExecutor({
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
        workflowAction: async (args) => runAutomationNowMock('automationId' in args.input ? args.input.automationId : null),
    })) };
});
vi.mock('@/modal', () => ({ Modal: { alert: modalAlertSpy } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
}));

function accountLifetime(scope: { serverId: string; accountId: string }): AccountLifetimeState['value'] {
    return Object.freeze({
        scope,
        isCurrent: () => activeAccountLifetime.value?.scope === scope
            || (activeAccountLifetime.value !== null
                && activeAccountLifetime.value.scope.serverId === scope.serverId
                && activeAccountLifetime.value.scope.accountId === scope.accountId),
    });
}

describe('useAutomationRunNowController', () => {
    afterEach(() => {
        vi.useRealTimers();
        runAutomationNowMock.mockReset();
        modalAlertSpy.mockClear();
        activeAccountLifetime.value = null;
    });

    it('uses command-state vocabulary and never presents its acknowledgement as a canonical Run state', async () => {
        vi.useFakeTimers();
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const request = createDeferred<AutomationRunNowAdmission>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocation!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            invocation = hook.getCurrent().runNow('automation-1', 'existingSession');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        await act(async () => {
            request.resolve(admission({ id: 'run-1', state: 'running' }));
            await expect(invocation).resolves.toMatchObject({ run: { id: 'run-1', state: 'running' } });
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('acknowledged');

        await act(async () => {
            vi.advanceTimersByTime(2_500);
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
    });

    it('partitions transient state by the Account/server scope for one Automation id', async () => {
        const scopeA = { serverId: 'server-a', accountId: 'account-a' };
        const scopeB = { serverId: 'server-b', accountId: 'account-b' };
        activeAccountLifetime.value = accountLifetime(scopeA);
        const heldA = createDeferred<AutomationRunNowAdmission>();
        runAutomationNowMock.mockReturnValueOnce(heldA.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocationA!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            invocationA = hook.getCurrent().runNow('automation-1', 'existingSession');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        // The same opaque Automation id under another Account/server must not
        // inherit A's submission presentation nor be suppressed by it.
        activeAccountLifetime.value = accountLifetime(scopeB);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');

        const heldB = createDeferred<AutomationRunNowAdmission>();
        runAutomationNowMock.mockReturnValueOnce(heldB.promise);
        let invocationB!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            invocationB = hook.getCurrent().runNow('automation-1', 'existingSession');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');
        expect(runAutomationNowMock).toHaveBeenCalledTimes(2);

        // A's late success is retired by the authority change, so swapping back
        // to A must not resurface an acknowledged presentation; B's own run is
        // still submitting under B's key.
        await act(async () => {
            heldA.resolve(admission({ id: 'run-a', state: 'running' }));
            await expect(invocationA).resolves.toBeNull();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        activeAccountLifetime.value = accountLifetime(scopeA);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
        await act(async () => {
            heldB.resolve(admission({ id: 'run-b', state: 'queued' }));
            await invocationB;
        });
    });

    it('does not invoke or publish unscoped state without an active Account', async () => {
        activeAccountLifetime.value = null;
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let result: AutomationRunNowAdmission | null | undefined;
        await act(async () => {
            result = await hook.getCurrent().runNow('automation-1', 'existingSession');
        });

        expect(result).toBeNull();
        expect(runAutomationNowMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
    });

    it('returns null for a duplicate activation while preserving the first exact admitted handle', async () => {
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const request = createDeferred<AutomationRunNowAdmission>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let first!: Promise<AutomationRunNowAdmission | null>;
        let duplicate!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            first = hook.getCurrent().runNow('automation-1', 'existingSession');
            duplicate = hook.getCurrent().runNow('automation-1', 'existingSession');
        });

        await expect(duplicate).resolves.toBeNull();
        expect(runAutomationNowMock).toHaveBeenCalledTimes(1);

        const admitted = admission({ id: 'run-exact', state: 'queued' });
        await act(async () => {
            request.resolve(admitted);
            await expect(first).resolves.toEqual(admitted);
        });
    });

    it('does not return a late handle to a retired route invocation', async () => {
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const request = createDeferred<AutomationRunNowAdmission>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());
        let invocationCurrent = true;

        let invocation!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            invocation = hook.getCurrent().runNow('automation-1', 'existingSession', {
                isInvocationCurrent: () => invocationCurrent,
            });
        });

        invocationCurrent = false;
        await act(async () => {
            request.resolve(admission({ id: 'run-late', state: 'queued' }));
            await expect(invocation).resolves.toBeNull();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('acknowledged');
    });

    it('publishes idle without an error surface when the Account authority retires mid-request', async () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        activeAccountLifetime.value = accountLifetime(scope);
        const request = createDeferred<unknown>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocation!: Promise<AutomationRunNowAdmission | null>;
        await act(async () => {
            invocation = hook.getCurrent().runNow('automation-1', 'existingSession');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        request.reject(new Error('request lost'));
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-b', accountId: 'account-b' });
        await act(async () => {
            await invocation;
        });
        // Back on the original Account, the retired request left no lingering
        // submission state and surfaced no error alert.
        activeAccountLifetime.value = accountLifetime(scope);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('returns the exact workflow correspondence the receipt declared, and none when it did not', async () => {
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        runAutomationNowMock.mockResolvedValueOnce(admission(
            { id: 'run-managed', state: 'running' },
            { recipeKind: 'workflow-v2', workflowRunId: 'run-managed' },
        ));
        let managed: AutomationRunNowAdmission | null | undefined;
        await act(async () => {
            managed = await hook.getCurrent().runNow('automation-managed', null);
        });
        expect(managed).not.toBeNull();
        expect(managed?.workflowRun).toEqual({ recipeKind: 'workflow-v2', workflowRunId: 'run-managed' });

        runAutomationNowMock.mockResolvedValueOnce(admission({ id: 'run-legacy', state: 'running' }));
        let legacy: AutomationRunNowAdmission | null | undefined;
        await act(async () => {
            legacy = await hook.getCurrent().runNow('automation-legacy', 'existingSession');
        });
        expect(legacy).not.toBeNull();
        // A legacy receipt keeps the incumbent contract: no correspondence is
        // manufactured for it, so no consumer can open a managed Run from it.
        expect(legacy?.workflowRun).toBeUndefined();
    });
    it('surfaces a lost Action receipt as uncertain without acknowledging or replaying the occurrence', async () => {
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());
        runAutomationNowMock.mockResolvedValueOnce({ ok: false, errorCode: 'workflow_outcome_unresolved', error: 'private server detail' });
        let result: AutomationRunNowAdmission | null | undefined;
        await act(async () => { result = await hook.getCurrent().runNow('automation-uncertain', null); });
        expect(result).toBeNull();
        expect(hook.getCurrent().stateFor('automation-uncertain')).toBe('idle');
        expect(runAutomationNowMock).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'projects.scripts.run.unknown common.refresh');
    });
});
