import { describe, expect, it } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { dispatchPluginSurfaceAction, preparePluginSurfaceHostRead } from './pluginSurfaceActionDispatch';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

const action = { pluginId: 'acme.preparation', localId: 'prepare' };
const projected = PluginProjectedActionV2Schema.parse({
    id: action.localId, pluginId: action.pluginId, occurrenceId: 'preparation-1',
    title: 'Prepare', scopes: ['global'], surfaces: ['ui'],
    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate',
        presentation: { onStart: 'activity' } },
});

describe('plugin finite admission lifetime', () => {
    it('keeps the admitted transport alive when its requesting view detaches', async () => {
        const caller = new AbortController();
        let current = true;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'prepared-request', signal: caller.signal,
            isCurrent: () => current,
            resolveContributedAction: () => projected,
            onDaemonActionOperationAdmitted: () => { current = false; caller.abort(); },
            contributedAction: { machineId: 'machine-a',
                // Machine RPC is the system boundary. Respect its actual
                // cancellation/currentness inputs rather than mocking dispatch.
                execute: async (_machineId, options) => options?.signal?.aborted || options?.isCurrent?.() === false
                    ? { supported: false, reason: 'error' }
                    : { supported: true, result: { ok: true, result: { kind: 'prepared', repositoryPath: '/review' } } },
            },
        });
        expect(result).toEqual({ ok: true, result: { kind: 'prepared', repositoryPath: '/review' } });
    });

    it('does not issue work when the requesting view aborts before admission', async () => {
        const caller = new AbortController();
        caller.abort();
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'unadmitted-request', signal: caller.signal,
            resolveContributedAction: () => projected,
            contributedAction: { machineId: 'machine-a', execute: async () => {
                effects++;
                return { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(result.ok).toBe(false);
        expect(effects).toBe(0);
    });

    it('keeps the view cancellation attached to transient requests', async () => {
        const caller = new AbortController();
        const { operation: _operation, ...transient } = projected;
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, signal: caller.signal,
            resolveContributedAction: () => transient,
            contributedAction: { machineId: 'machine-a', execute: async (_machineId, options) => {
                effects++;
                caller.abort();
                return options.signal?.aborted
                    ? { supported: false, reason: 'error' }
                    : { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(effects).toBe(1);
        expect(result.ok).toBe(false);
    });

    it('honors a view abort while Machine admission is still being verified', async () => {
        const caller = new AbortController();
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'verifying-request', signal: caller.signal,
            resolveContributedAction: () => projected,
            hostAction: { execute: async () => ({ ok: true, result: null }), context: {
                verifyMachineAdmissionCurrent: async () => { caller.abort(); return true; },
            } },
            contributedAction: { machineId: 'machine-a', execute: async () => {
                effects++;
                return { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(result.ok).toBe(false);
        expect(effects).toBe(0);
    });
});

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { PluginError } from '@happier-dev/plugin-sdk';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

it('retains the real host executor refusal through dispatch and presentation', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsBackendsList: async () => { throw new PluginError({ code: 'credential_scope_denied', message: 'Choose another credential', remediation: { kind: 'retry' }, details: { reason: 'credential_scope_denied' } }); },
    }));
    const outcome = await dispatchPluginSurfaceAction({ action: 'agents.backends.list', input: {},
        callerPluginId: 'acme.preparation', callerContributionLocalId: 'preview', actionRequestId: 'host-refusal',
        callerBinding: { pluginId: 'acme.preparation', contributionLocalId: 'preview', occurrenceId: 'preview-1',
            sourceCustody: { kind: 'development', registeredRootId: 'preview-root' } },
        hostAction: { execute: executor.execute, context: { runtimeAccountId: 'account', serverId: 'home' } },
    });
    expect(outcome).toMatchObject({ ok: false, code: 'credential_scope_denied', requestId: 'host-refusal', remediation: { kind: 'retry' } });
    if (outcome.ok) throw new Error('Expected refusal');
    const presentation = presentActionExecutionFailure({ ...outcome, errorCode: outcome.code });
    expect(presentation.technicalDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'requestId', value: 'host-refusal' }),
        expect.objectContaining({ key: 'causePhase' }),
    ]));
});

it('retains a daemon RPC refusal through dispatch and presentation', async () => {
    const refusal = { ok: false, code: 'credential_scope_denied', message: 'Choose another credential',
        requestId: 'daemon-refusal', effectAttempted: false,
        failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null },
        remediation: { kind: 'retry' } } as const;
    const outcome = await dispatchPluginSurfaceAction({ action, actionRequestId: 'daemon-refusal',
        resolveContributedAction: () => projected,
        contributedAction: { machineId: 'machine-a', execute: async () => ({ supported: true, result: refusal }) },
    });
    expect(outcome).toMatchObject(refusal);
    if (outcome.ok) throw new Error('Expected refusal');
    const presentation = presentActionExecutionFailure({ ...outcome, errorCode: outcome.code });
    expect(presentation.reason).toContain(refusal.message);
    expect(presentation.technicalDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'requestId', value: refusal.requestId }),
        expect.objectContaining({ key: 'causePhase', value: refusal.failureCause.phase }),
        expect.objectContaining({ key: 'effectAttempted', value: 'false' }),
    ]));
});

it('retains the typed Action refusal during host read admission', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture());
    const outcome = await preparePluginSurfaceHostRead({ action: 'usage.query', input: { queries: [{}] },
        actionRequestId: 'host-read-refusal', callerPluginId: 'acme.preparation', callerContributionLocalId: 'preview',
        callerBinding: { pluginId: 'acme.preparation', contributionLocalId: 'preview', occurrenceId: 'preview-1',
            sourceCustody: { kind: 'development', registeredRootId: 'preview-root' } },
        hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }),
            context: { runtimeAccountId: 'account', serverId: 'home', actionsSettings: normalizeActionsSettingsV1({ v: 1,
                actions: { 'usage.query': { enabled: false } } }) } },
    }, 'usage.query');
    expect(outcome).toMatchObject({ ok: false, requestId: 'host-read-refusal' });
    if (outcome.ok) throw new Error('Expected read admission refusal');
    expect(outcome.code).not.toBe('unavailable');
    expect(presentActionExecutionFailure({ ...outcome, errorCode: outcome.code }).technicalDetails)
        .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'requestId', value: 'host-read-refusal' })]));
});
