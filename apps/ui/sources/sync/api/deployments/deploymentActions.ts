import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentEnvironmentGetResultV1Schema, DeploymentCancelTransitionInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinkInputV1Schema, type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentEnvironmentCreateInputV1, type DeploymentEnvironmentCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isDeploymentDomainChildActionIdV1, isDeploymentPromoteActionIdV1, type DeploymentTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { randomUUID } from '@/platform/randomUUID';
import { prepareUiDeploymentTargetLink } from './prepareUiDeploymentTargetLink';
import { DeploymentInvalidV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

function creationMachine(input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentCreateIntentInputV1) {
    return 'definition' in input && input.definition?.from === 'catalogApp'
        ? input.firstTargetLink?.machines[0]?.machineId
        : input.controllerMachineId ?? input.firstTargetLink?.machines[0]?.machineId;
}

/** Account-bound storage and the existing Machine Action transport; no UI native effects. */
export function createUiDeploymentActionDeps(account: LazyActionAccountContext): Pick<ActionExecutorDeps,
    'deploymentAction' | 'resolveEnvironmentApprovalScope' | 'prepareDeploymentEnvironmentCreate'
    | 'deploymentTemplateInstantiate' | 'prepareDeploymentTemplateInstantiation'> {
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    async function storage(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1, context: ActionExecutorContext) {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        const spec = getActionSpec(actionId);
        if (!spec.serverTransport) return failure('unsupported_action');
        const transportInput = { ...input, serverId: account.serverIdentityId ?? account.serverId };
        const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
            inputSchema: actionId === 'deployments.targets.link' ? DeploymentTargetLinkInputV1Schema
                : DeploymentActionInputSchemasV1[actionId], input: transportInput });
        const body = actionId === 'deployments.cancel'
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
        const result = await executeOriginalAccountMachineAction({ account, actionId: 'deployments.templates.instantiate',
            machineId: input.machineId, requestId: context.actionRequestId ?? randomUUID(), input,
            actionCaller: context.actionCaller, signal: context.signal, onTransportIssued: context.onTransportIssued });
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
            return { input, preview: projectNativeJsonValueForTransport(preview.review) };
        },
        prepareDeploymentEnvironmentCreate: async ({ input, context }) => {
            account.assertCurrent();
            if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
            const machineId = creationMachine(input);
            if (!machineId) return failure('client_required');
            const result = await executeOriginalAccountMachineAction({ account, actionId: 'deployments.environments.create', machineId,
                requestId: context.actionRequestId ?? randomUUID(), input: { ...input, mode: 'preview' },
                actionCaller: context.actionCaller, signal: context.signal });
            if (!result.ok) return result;
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.safeParse(result.result);
            if (!preview.success) return failure('invalid_action_output');
            account.assertCurrent();
            return { input: preview.data.input, preview: preview.data.review };
        },
        deploymentAction: async (actionId, input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        if (actionId === 'deployments.targets.link' && !('contentArtifactId' in input)) {
            const intent = DeploymentActionInputSchemasV1[actionId].parse(input);
            if ('contentArtifactId' in intent) return storage(actionId, intent, context);
            const read = await storage('deployments.environments.get', {
                serverId: intent.serverId, environmentId: intent.environmentId,
            }, context);
            if ('errorCode' in read) return read;
            const current = DeploymentEnvironmentGetResultV1Schema.parse(read);
            if (!current.ok) return current;
            try {
                const prepared = await prepareUiDeploymentTargetLink(account, intent, context, current);
                return 'contentArtifactId' in prepared ? await storage(actionId, prepared, context) : prepared;
            }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
                    const invalid = DeploymentInvalidV1Schema.safeParse('details' in error ? error.details : undefined);
                    return invalid.success && invalid.data.error === error.code ? invalid.data : failure(error.code);
                }
                throw error;
            }
        }
        if (!isDeploymentDomainChildActionIdV1(actionId) && actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback'
            && actionId !== 'deployments.promote' && actionId !== 'deployments.teardown'
            && actionId !== 'deployments.health.read' && actionId !== 'deployments.health.current'
            && actionId !== 'deployments.drift.read' && actionId !== 'deployments.logs.read'
            && actionId !== 'deployments.publish.prepare'
            && actionId !== 'deployments.environments.create' && actionId !== 'deployments.environments.update'
            && actionId !== 'deployments.bindings.set') {
            return storage(actionId, input, context);
        }
        const selectedReadInput = actionId === 'deployments.health.read' || actionId === 'deployments.health.current'
            || actionId === 'deployments.drift.read' || actionId === 'deployments.logs.read'
            ? DeploymentActionInputSchemasV1[actionId].parse(input) : undefined;
        const effectInput = selectedReadInput ?? DeploymentActionInputSchemasV1[actionId].parse(input);
        let machineId: string;
        if (actionId === 'deployments.publish.prepare') machineId = DeploymentActionInputSchemasV1[actionId].parse(input).machineId;
        else if (actionId === 'deployments.environments.create') {
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
        const reviewDeploy = (actionId === 'deployments.deploy' || isDeploymentPromoteActionIdV1(actionId)) && context.surface === 'ui'
            && isPresentUserHostInvocation(context) && !context.approvedActionReplay;
        // Keep the deployment root: its admission owns candidate preparation and publication.
        const result = await executeOriginalAccountMachineAction({ account, actionId,
            machineId,
            requestId: context.actionRequestId ?? randomUUID(), input: effectInput,
            actionCaller: context.actionCaller, signal: context.signal,
            ...(reviewDeploy || actionId === 'deployments.logs.read' ? {
                authority: reviewDeploy || context.approvedActionReplay ? 'account_automation' as const : context.authority,
            } : {}),
            onTransportIssued: context.onTransportIssued,
        });
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentActionOutputSchemasV1[actionId].parse(result.result);
    } };
}
