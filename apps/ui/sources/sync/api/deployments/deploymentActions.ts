import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, readDeploymentEnvironmentOperationRequestIdV1, DeploymentEnvironmentGetResultV1Schema, DeploymentCancelTransitionInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinkInputV1Schema, type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentEnvironmentCreateInputV1, type DeploymentEnvironmentCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_CANCEL_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1, isDeploymentMachineTransportActionIdV1, isDeploymentPromoteActionIdV1, isDeploymentReadActionIdV1, isDeploymentTargetLinkActionIdV1, type DeploymentTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { isActionOutcomeUnknownErrorCodeV1, ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resolveDeploymentTemplateExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomUUID } from '@/platform/randomUUID';
import { getActionOperation, listActionOperations } from '@/sync/ops/actionOperations';
import { prepareUiDeploymentTargetLink } from './prepareUiDeploymentTargetLink';
import { DeploymentInvalidV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

function creationMachine(input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentCreateIntentInputV1) {
    return input.controllerMachineId ?? input.firstTargetLink?.machines[0]?.machineId;
}

/** Account-bound storage and the existing Machine Action transport; no UI native effects. */
export function createUiDeploymentActionDeps(account: LazyActionAccountContext): Pick<ActionExecutorDeps,
    'deploymentAction' | 'resolveEnvironmentApprovalScope' | 'prepareDeploymentEnvironmentCreate'
    | 'deploymentTemplateInstantiate' | 'prepareDeploymentTemplateInstantiation'> {
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    async function machine(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1,
        context: ActionExecutorContext, machineId: string) {
        // The receiving Machine consumes the original requester and completed
        // review through the same private Account carrier as other UI Actions.
        const needsInvocation = context.surface !== undefined && context.surface !== 'plugin';
        const invocation = needsInvocation ? projectExternalActionRequesterInvocationV1({ actionId, context, account,
            target: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : { kind: 'machine', machineId },
        }) : null;
        if (needsInvocation && !invocation) return failure('admission_unavailable');
        const requestId = context.actionRequestId ?? randomUUID();
        const result = await executeOriginalAccountMachineAction({ account, actionId, machineId,
            requestId, input,
            actionCaller: context.actionCaller, authority: context.authority,
            ...(invocation ? { invocation } : {}), signal: context.signal,
            onTransportIssued: context.onTransportIssued });
        if (actionId !== DEPLOYMENT_TEARDOWN_ACTION_ID_V1 || result.ok
            || !isActionOutcomeUnknownErrorCodeV1(result.errorCode)) return result;
        // A lost HTTP response is not a failed teardown. Join this request's existing
        // runner; never resubmit the effect or infer success from Environment absence.
        try {
            const transport = { serverId: account.serverId, accountId: account.accountId, machineId, signal: context.signal };
            const retainedRequestId = ('environmentId' in input && 'requestKey' in input
                ? readDeploymentEnvironmentOperationRequestIdV1(input) : undefined) ?? requestId;
            const matches = (operation: import('@happier-dev/protocol/actions/operations/v1').ActionOperationSnapshotV1) =>
                operation.actionId === actionId && operation.requestId === retainedRequestId
                && operation.scope.accountId === account.accountId && operation.scope.machineId === machineId;
            const page = await listActionOperations({ ...transport, request: { requestIdentity: { actionId, requestId: retainedRequestId } } });
            const retained = page.items.find(matches);
            if (!retained) return result;
            const read = await getActionOperation({ ...transport, operationId: retained.operationId, waitForTerminal: true });
            account.assertCurrent();
            if (read.kind !== 'found' || !matches(read.operation) || read.operation.operationId !== retained.operationId
                || read.operation.revision < retained.revision) return result;
            if (read.operation.state === 'succeeded') {
                const settled = DeploymentActionOutputSchemasV1[actionId].safeParse(read.operation.result);
                if (settled.success && 'environmentId' in settled.data && 'environmentId' in input
                    && settled.data.environmentId === input.environmentId) return { ok: true as const, result: settled.data };
            } else if (read.operation.state === 'failed' && read.operation.error) {
                return { ok: false as const, ...read.operation.error };
            }
        } catch {
            // Observation can also be unavailable; keep the original uncertainty.
        }
        return result;
    }
    async function storage(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1, context: ActionExecutorContext) {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        const spec = getActionSpec(actionId);
        if (!spec.serverTransport) return failure('unsupported_action');
        const transportInput = { ...input, serverId: account.serverIdentityId ?? account.serverId };
        const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
            inputSchema: isDeploymentTargetLinkActionIdV1(actionId) ? DeploymentTargetLinkInputV1Schema
                : DeploymentActionInputSchemasV1[actionId], input: transportInput });
        const body = actionId === DEPLOYMENT_CANCEL_ACTION_ID_V1
            ? DeploymentCancelTransitionInputV1Schema.parse({ ...transportInput, kind: 'cancel' }) : bound.body;
        const response = await requestHomeDomain<DeploymentActionOutputV1>({ scope: account.accountLifetime.scope,
            path: bound.path, method: bound.method, input: body, schema: DeploymentActionOutputSchemasV1[actionId],
            effect: spec.sideEffectClass === 'read' ? 'read' : 'write', signal: context.signal,
            requestAuthority: { request: account.request,
                assertCurrent: () => account.assertResultCurrent(spec.sideEffectClass) },
        });
        if (!response.ok) return { ...failure(homeDomainFailureCode(response.failure)),
            ...(response.failure.details === undefined ? {} : { details: response.failure.details }) };
        return response.value;
    }
    const instantiateTemplate: NonNullable<ActionExecutorDeps['deploymentTemplateInstantiate']> = async (input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        const selected = await resolveDeploymentTemplateExecutionMachineIdV1(input, async selector => {
            const read = await storage('deployments.environments.get', selector, context);
            return 'errorCode' in read ? read : DeploymentEnvironmentGetResultV1Schema.parse(read);
        });
        if (!selected.ok) return selected;
        const result = await machine('deployments.templates.instantiate', input, context, selected.machineId);
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentTemplateInstantiateResultV1Schema.parse(result.result);
    };
    return { resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(storage),
        deploymentTemplateInstantiate: instantiateTemplate,
        prepareDeploymentTemplateInstantiation: async ({ input, context }) => {
            const preview = await instantiateTemplate({ ...input, mode: 'preview' }, context);
            if ('ok' in preview) return preview;
            if (preview.kind === 'partial') return failure(preview.errorCode);
            if (preview.kind !== 'preview') return failure('invalid_action_output');
            return { input: input.environment.kind === 'create' && input.deploy === undefined && preview.review.deploy
                ? { ...input, deploy: preview.review.deploy } : input,
                preview: projectNativeJsonValueForTransport(preview.review) };
        },
        prepareDeploymentEnvironmentCreate: async ({ input, context }) => {
            account.assertCurrent();
            if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
            const machineId = creationMachine(input);
            if (!machineId) return failure('client_required');
            const result = await machine('deployments.environments.create', { ...input, mode: 'preview' }, context, machineId);
            if (!result.ok) return result;
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.safeParse(result.result);
            if (!preview.success) return failure('invalid_action_output');
            account.assertCurrent();
            return { input: preview.data.input, preview: preview.data.review };
        },
        deploymentAction: async (actionId, input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        let linkControllerMachineId: string | undefined;
        if (isDeploymentTargetLinkActionIdV1(actionId) && !('contentArtifactId' in input)) {
            const intent = DeploymentActionInputSchemasV1[actionId].parse(input);
            const read = await storage('deployments.environments.get', {
                serverId: intent.serverId, environmentId: intent.environmentId,
            }, context);
            if ('errorCode' in read) return read;
            const current = DeploymentEnvironmentGetResultV1Schema.parse(read);
            if (!current.ok) return current;
            try {
                const prepared = await prepareUiDeploymentTargetLink(account, intent, context, current);
                if (!('contentArtifactId' in prepared)) return prepared;
                input = prepared;
                linkControllerMachineId = current.environment.controllerMachineId;
            }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
                    const invalid = DeploymentInvalidV1Schema.safeParse('details' in error ? error.details : undefined);
                    return invalid.success && invalid.data.error === error.code ? invalid.data : failure(error.code);
                }
                throw error;
            }
        }
        if (getActionSpec(actionId).executionPlacement !== 'machine'
            && !isDeploymentMachineTransportActionIdV1(actionId)) {
            return storage(actionId, input, context);
        }
        const selectedReadInput = isDeploymentReadActionIdV1(actionId)
            ? DeploymentActionInputSchemasV1[actionId].parse(input) : undefined;
        const effectInput = selectedReadInput ?? DeploymentActionInputSchemasV1[actionId].parse(input);
        let machineId: string;
        // Link completion belongs to the controller's enrollment owner, including
        // content authored here under the captured Account's encryption mode.
        if (linkControllerMachineId) machineId = linkControllerMachineId;
        else if (actionId === DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1) machineId = DeploymentActionInputSchemasV1[actionId].parse(input).machineId;
        else if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
            const create = DeploymentActionInputSchemasV1[actionId].parse(input);
            const selected = creationMachine(create);
            if (!selected) return failure('client_required');
            machineId = selected;
        }
        else if ('controllerMachineId' in effectInput && typeof effectInput.controllerMachineId === 'string') machineId = effectInput.controllerMachineId;
        else if ('environmentId' in effectInput) {
            const read = await storage('deployments.environments.get', {
                serverId: effectInput.serverId, environmentId: effectInput.environmentId,
            }, context);
            if ('errorCode' in read) return read;
            const current = DeploymentEnvironmentGetResultV1Schema.parse(read);
            if (!current.ok) return current;
            machineId = selectedReadInput ? selectedReadInput.machineId : current.environment.controllerMachineId;
        } else return failure('invalid_parameters');
        // A person's Deploy or Promote asks the controller to prepare its existing review,
        // rather than spending present-user authority before that review is confirmed.
        const reviewDeploy = (actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 || isDeploymentPromoteActionIdV1(actionId)) && context.surface === 'ui'
            && isPresentUserHostInvocation(context) && !context.approvedActionReplay;
        // Keep the deployment root: its admission owns candidate preparation and publication.
        const result = await machine(actionId, effectInput, reviewDeploy ? { ...context, authority: 'account_automation' } : context, machineId);
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentActionOutputSchemasV1[actionId].parse(result.result);
    } };
}
