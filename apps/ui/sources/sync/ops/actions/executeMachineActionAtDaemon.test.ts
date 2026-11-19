import { expect, it, vi } from 'vitest';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { confirmOwnUiRefusal, executeMachineActionAtDaemon, isUiMachineOwnedAdmissionAction } from './executeMachineActionAtDaemon';

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

it.each([false, true])('executes only the candidate reviewed for a first Deploy of a saved Compose Environment (intent changed: %s)', async changed => {
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { computeActionReviewDigestV1 } = await import('@happier-dev/protocol/actions/decisionAuthority');
    const { DeploymentDeployInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { createDeploymentCandidatePublicationV1 } = await import('@happier-dev/protocol/deployments/deploymentCandidatePublicationV1');
    const { bindPresentUserActionConfirmation } = await import('./presentUserConfirmation');
    const actionId = 'deployments.deploy';
    // Environment detail's Deploy button supplies only the Environment and target; the Action adds Home.
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target' };
    const candidateFor = (requestId: string) => {
        const publication = createDeploymentCandidatePublicationV1({
            actionId, accountId: 'owner', serverIdentityId: input.serverId, environmentId: input.environmentId,
            requestId, requestEnvelopeDigest: `signed-envelope-${requestId}`, source: { id: 'source', revision: 1 },
        });
        return DeploymentDeployInputV1Schema.parse({ ...input, expectedRevision: 1, expectedTargetLinkRevision: 1,
            requestKey: `generated-key-${requestId}`, contentArtifactId: publication.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 3 });
    };
    const receivingContext: ActionExecutorContext = { ...context, serverId: 'home', runtimeAccountId: 'owner',
        actionRequestId: 'original-press', interactivePresentation: 'unavailable' };
    const deploymentBoundary = { ok: false, errorCode: 'deployment_boundary_observed', error: 'deployment_boundary_observed' } as const;
    const effectInputs: unknown[] = [];
    const preview = { kind: 'ownServer', services: ['web'] };
    const executor = createActionExecutor({
        // Stand in for the daemon's artifact I/O. Compact input authors a candidate for this
        // signed request. Prepared input opens the existing reviewed artifact at its pinned versions.
        prepareDeploymentAction: async ({ input: operands, context: invocation }) => {
            if ('contentArtifactId' in operands) return { input: operands, preview };
            if (!invocation.actionRequestId) throw new Error('Expected a signed request identity');
            return { input: candidateFor(invocation.actionRequestId), preview };
        },
        resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: input.environmentId } }),
        deploymentAction: async (_actionId, operands) => {
            effectInputs.push(operands);
            return deploymentBoundary;
        },
    } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const confirm = vi.fn(async () => true);
    const received: ActionExecuteResult[] = [];
    const result = await executeMachineActionAtDaemon(actionId, input, context, async (operands, digest, reviewedInput) => {
        const submitted = changed && digest ? { ...input, onFailure: 'keepPartial' } : operands;
        const invocation = digest === undefined ? receivingContext : bindPresentUserActionConfirmation(actionId, submitted,
            { ...receivingContext, actionRequestId: 'confirmed-press' }, digest, reviewedInput);
        const reply = await executor.execute(actionId, submitted, invocation);
        received.push(reply);
        return reply;
    }, confirm);
    const candidate = candidateFor('original-press');
    const shownPreview = expect.objectContaining({ actionArgs: candidate, deploymentRolloutSemanticInput: input });
    expect(received[0]).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required', details: {
        review: { actionArgs: candidate, preview: shownPreview }, reviewDigest: expect.any(String),
    } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId, preview: shownPreview }));

    // Diagnose the loop without accepting the second refusal as the expected outcome.
    if (!result.ok && result.errorCode === 'action_interactive_review_required') {
        const first = received[0];
        if (first.ok) throw new Error('Expected a carried review');
        const firstDigest = (first.details as { reviewDigest: string }).reviewDigest;
        const second = result.details as { reviewDigest: string; review: Parameters<typeof computeActionReviewDigestV1>[1] };
        expect(second.reviewDigest).toBe(computeActionReviewDigestV1(actionId, second.review));
        expect(second.reviewDigest).not.toBe(firstDigest);
    }
    expect({ result: result.ok ? 'ok' : result.errorCode, effectInputs }).toEqual({
        result: changed ? 'action_interactive_review_required' : deploymentBoundary.errorCode,
        effectInputs: changed ? [] : [candidate],
    });
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
