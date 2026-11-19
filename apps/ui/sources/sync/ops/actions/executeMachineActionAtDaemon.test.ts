import { expect, it, vi } from 'vitest';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { confirmOwnUiRefusal, isUiMachineOwnedAdmissionAction } from './executeMachineActionAtDaemon';

const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } };
const reviewDigest = 'M'.repeat(43);
const refused = (actionArgs: unknown): ActionExecuteResult => ({ ok: false,
    errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
    details: { reviewDigest, review: { actionArgs, preview: { summary: 'Review the prepared effect' } } } });

it('returns the exact Environment creation repair issues before dispatching the Machine Action', async () => {
    const execute = vi.fn();
    const result = await executeMachineActionAtDaemon('deployments.environments.create', {
        serverId: 'home', requestKey: 'create-preview', protection: 'nonProduction', purpose: 'preview',
        deployerMode: 'managers', name: 'private-preview-title',
    }, context, execute);
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [
        { path: [], message: 'Select an existing or reviewed new Project.' },
        { path: [], message: 'A preview or its named companion derives from one template and existing Source.' },
        { path: [], message: 'Create selects an authored definition or an exact source copy.' },
    ] } });
    expect(JSON.stringify(result)).not.toContain('private-preview-title');
    expect(execute).not.toHaveBeenCalled();
});

it('keeps approval creation on the originating account executor', () => {
    expect(isUiMachineOwnedAdmissionAction('approval.request.create', {
        actionId: 'session.spawn_new', actionArgs: {}, summary: 'Create a Session', createdBy: 'voice',
    })).toBe(false);
    expect(isUiMachineOwnedAdmissionAction('session.spawn_new', {})).toBe(true);
});

it('confirms a saved Environment deploy against its original compact intent', async () => {
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { DeploymentDeployInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { bindPresentUserActionConfirmation } = await import('./presentUserConfirmation');
    const actionId = 'deployments.deploy';
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target' };
    const candidate = DeploymentDeployInputV1Schema.parse({ ...input, expectedRevision: 1, expectedTargetLinkRevision: 1,
        requestKey: 'prepared-request', contentArtifactId: 'prepared-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 });
    const receivingContext: ActionExecutorContext = { ...context, serverId: 'home', runtimeAccountId: 'owner',
        actionRequestId: 'original-press', interactivePresentation: 'unavailable' };
    const deploymentBoundary = { ok: false, errorCode: 'deployment_boundary_observed', error: 'deployment_boundary_observed' } as const;
    const executor = createActionExecutor({
        // Stub the host's stable candidate/target inspection and the deployment effect. Review admission stays real.
        prepareDeploymentAction: async () => ({ input: candidate, preview: { kind: 'fixture' } }),
        resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: input.environmentId } }),
        deploymentAction: async () => deploymentBoundary,
    } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const initial = await executor.execute(actionId, input, receivingContext);
    expect(initial).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required', details: {
        review: { actionArgs: candidate, preview: { deploymentRolloutSemanticInput: input } },
        reviewDigest: expect.any(String),
    } });
    if (initial.ok) throw new Error('Expected a carried review');
    const initialDigest = (initial.details as { reviewDigest: string }).reviewDigest;
    const replay = (operands: unknown, digest: string) => executor.execute(actionId, operands,
        bindPresentUserActionConfirmation(actionId, operands, { ...receivingContext, actionRequestId: 'confirmed-press' }, digest));
    const confirm = vi.fn(async () => true);
    const result = await confirmOwnUiRefusal(actionId, input, context, initial, confirm, replay);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ actionId, input, context, preview: expect.objectContaining({
        actionArgs: candidate, deploymentRolloutSemanticInput: input,
    }) });
    expect(result).toMatchObject(deploymentBoundary);
});

it('replays the receiving Machine’s prepared Open destination after confirmation', async () => {
    const actionId = 'projects.open';
    const materialization = { kind: 'clone', destinationParentPath: '/requested', destinationDirectoryName: 'repo',
        authentication: 'connected_account' };
    const input = getActionSpec(actionId).inputSchema.parse({ serverId: 'home', machineId: 'machine',
        source: { kind: 'folder', path: '/source' }, materialization });
    const prepared = getActionSpec(actionId).inputSchema.parse({ ...input,
        materialization: { ...materialization, destinationParentPath: '/member/private' } });
    const execute = vi.fn(async (operands: unknown, digest: string): Promise<ActionExecuteResult> =>
        digest === reviewDigest && sameStrictJsonValue(operands, prepared)
            ? { ok: true, result: { kind: 'opened' } } : refused(prepared));
    const confirm = vi.fn(async () => true);
    const result = await confirmOwnUiRefusal(actionId, input, context, refused(prepared), confirm, execute);
    expect(result).toMatchObject({ ok: true, result: { kind: 'opened' } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ actionId, input: prepared, context,
        preview: { summary: 'Review the prepared effect' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(prepared, reviewDigest);
});

it('presents a value-free carried review while retaining private operands under the declared live custody', async () => {
    const input = getActionSpec('secrets.create').inputSchema.parse({ name: 'Private token', kind: 'token', value: 'private-value' });
    const review = { name: 'Private token', kind: 'token' };
    const confirm = vi.fn(async () => true);
    const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: { secretId: 'created-secret' } }));
    const result = await confirmOwnUiRefusal('secrets.create', input, context, refused(review), confirm, execute);
    expect(result).toMatchObject({ ok: true, result: { secretId: 'created-secret' } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ actionId: 'secrets.create', input: review, context,
        preview: { summary: 'Review the prepared effect' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(input, reviewDigest);
});

it.each([false, true])('settles a carried review before dispatch when aborted=%s', async aborted => {
    const controller = new AbortController();
    const input = { action: { pluginId: 'acme.tasks', localId: 'create' }, input: { title: 'A task' } };
    const execute = vi.fn();
    const result = await confirmOwnUiRefusal('action.invoke', input, { ...context, signal: controller.signal },
        refused(input), async () => {
            if (aborted) controller.abort();
            return false;
        }, execute);
    expect(result).toMatchObject({ ok: false, errorCode: aborted ? 'cancelled' : 'approval_canceled', effectAttempted: false });
    expect(execute).not.toHaveBeenCalled();
});
