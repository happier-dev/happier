import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { startProjectSetupAutostartServices } from './projectSetupAutostart';
import type { ProjectSetupExecutionOutcome } from './projectSetupExecution';

const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/project', projectKey: 'project', createdAtMs: 1 };
const parent = { actionId: 'projects.prepare' as const, input: { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/project' }, phase: 'setup' } };
const manifest = { version: 1 as const, services: {
    web: { source: { kind: 'command' as const, command: 'serve web' }, runtime: { autostart: true } },
    worker: { source: { kind: 'command' as const, command: 'serve worker' }, runtime: { autostart: true } },
    manual: { source: { kind: 'command' as const, command: 'serve manual' } },
} };
const finished: ProjectSetupExecutionOutcome = { kind: 'process_settled', result: { ok: true, result: {} },
    setupSettlement: { workspace, project: { serverId: 'home', projectId: 'project' }, operationId: 'setup', outcome: 'finished' } };

it('starts declared autostart services as reviewed children after successful setup and excludes the containing Service', async () => {
    const starts: unknown[] = [];
    const executor = createActionExecutor({
        // The addressed native host is the process boundary. Child issuance, Action policy and validation stay real.
        runtimeActionExecute: async ({ input }) => { starts.push(input); return { protocolVersion: 1, machineId: 'machine',
            targetId: 'started', status: 'succeeded', snapshot: { v: 1, machineId: 'machine', updatedAt: 1, targets: [] } }; },
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'person',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'localServices.launcher.start': { approvalRequiredSurfaces: ['agent'] } } }),
        executeHostReviewedChildAction: (actionId, input, childContext) => executor.execute(actionId, input, childContext) };
    expect(await startProjectSetupAutostartServices({ outcome: finished, manifest, context, parent, excludeServiceName: 'worker' })).toBeNull();
    expect(starts).toEqual([expect.objectContaining({ machineId: 'machine', workspace: parent.input.workspace,
        declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'web' } } })]);
});

it('retains the admitted caller authorization on the automatic Service child', async () => {
    const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
        accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
        actionId: 'projects.prepare', requestId: 'setup-request', target: { kind: 'machine', machineId: 'machine' },
        requestEnvelopeDigest: 'a'.repeat(43),
    } });
    let childContext: ActionExecutorContext | undefined;
    const executor = createActionExecutor({
        runtimeActionExecute: async ({ context }) => {
            childContext = context;
            return { protocolVersion: 1, machineId: 'machine', targetId: 'started', status: 'succeeded',
                snapshot: { v: 1, machineId: 'machine', updatedAt: 1, targets: [] } };
        },
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'person',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'localServices.launcher.start': { approvalRequiredSurfaces: ['agent'] } } }),
        executeHostReviewedChildAction: (actionId, input, current) => executor.execute(actionId, input, current) };
    expect(await startProjectSetupAutostartServices({ outcome: finished, manifest, context, callerInputAuthorization, parent })).toBeNull();
    expect(Reflect.get(childContext, 'callerInputAuthorization')).toBe(callerInputAuthorization);
});

it.each([
    { kind: 'no_launch' as const, result: { ok: true as const, result: {} } },
    { ...finished, result: { ok: false as const, errorCode: 'setup_failed', error: 'setup_failed' },
        setupSettlement: { ...finished.setupSettlement!, outcome: 'failed' as const, errorCode: 'setup_failed' } },
    { kind: 'outcome_uncertain' as const, result: { ok: false as const, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' } },
])('does not start services without a successful settled setup ($kind)', async outcome => {
    expect(await startProjectSetupAutostartServices({ outcome, manifest, parent, context: {} })).toBeNull();
});

it('reports unavailable child ingress instead of bypassing the Action owner', async () => {
    expect(await startProjectSetupAutostartServices({ outcome: finished, manifest, parent, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'project_service_action_context_unavailable' });
});

it('preserves the native Start failure rather than reporting successful autostart', async () => {
    const executor = createActionExecutor({
        // Addressed native host boundary; the reviewed child still crosses the real Action executor.
        runtimeActionExecute: async () => ({ protocolVersion: 1, machineId: 'machine', targetId: 'web',
            status: 'denied', reasonCode: 'deployment_port_in_use',
            snapshot: { v: 1, machineId: 'machine', updatedAt: 1, targets: [] } }),
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'person',
        executeHostReviewedChildAction: (actionId, value, childContext) => executor.execute(actionId, value, childContext) };
    expect(await startProjectSetupAutostartServices({ outcome: finished, manifest, parent, context }))
        .toMatchObject({ ok: false, errorCode: 'deployment_port_in_use' });
});
