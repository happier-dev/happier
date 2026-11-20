import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, readDeploymentActionOperationRequestIdV1, isDeploymentEnvironmentPlacementActionV1, resolveDeploymentEnvironmentExecutionMachineIdV1, resolveDeploymentPreviewExecutionMachineIdV1, isDeploymentTemplatePreviewInputV1, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentCancelTransitionInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinkInputV1Schema, type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentEnvironmentCreateInputV1, type DeploymentEnvironmentCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_CANCEL_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1, DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, isDeploymentActionIdV1, isDeploymentReadActionIdV1, isDeploymentTargetLinkActionIdV1, type DeploymentTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { isActionOutcomeUnknownErrorCodeV1, ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTemplateInstantiateResultV1Schema, DeploymentMoveToRepositoryResultV1Schema, resolveDeploymentMoveToRepositoryExecutionMachineIdV1, type DeploymentTemplateInstantiateInputV1, type DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTemplateInstantiationPartialV1, resolveDeploymentTemplateExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { admitPresentUserConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withDeploymentEnvironmentRecipientDeliveryV1 } from '@happier-dev/deployments';
import { createUiDeploymentContentRecipientPorts } from './deploymentContentRecipients';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomUUID } from '@/platform/randomUUID';
import { observeActionOperationByRequestId } from '@/sync/domains/actionOperations/observeActionOperationByRequestId';
import { readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ProjectAccountWorkspaceRefKeyV1 } from '@happier-dev/protocol/projects/workspaceRefKeyV1';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { DeploymentPrepareResultV1Schema, type DeploymentPrepareInputV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { projectDeploymentCancellationConsequenceV1, readDeploymentReceiptActionFactsV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol/v1';
import { listDeploymentTargetsFromManifestsV1, projectDeploymentSuggestionTargetsV1 } from '@happier-dev/deployments';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { completeActionResult } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploySuggestionCatalogV1Schema } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { createUiAccountAction } from '@/sync/ops/actions/accountActionDeps';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';

/** Both deployment roots route through the person's admitted checkout census. */
/** Loose output members keep `errorCode` in their index signature, so `'errorCode' in` alone does not narrow them out. */
export function isDeploymentActionFailure<TRead extends object = DeploymentActionOutputV1>(read: TRead | ActionExecuteFailure): read is ActionExecuteFailure {
    return 'errorCode' in read;
}

export function createUiDeploymentWorkspaceMachineReader(account: LazyActionAccountContext, context: ActionExecutorContext) {
    return async (workspace: ProjectAccountWorkspaceRefKeyV1) => {
        account.assertCurrent();
        const rows = await createUiProjectAccountRowsClient(account).read(context.signal);
        const selected = rows.status === 'ready' && rows.coverage === 'complete'
            ? resolveWorkspaceRefById(rows.workspaceRefs, workspace.id, workspace.serverId) : null;
        return selected?.kind === 'resolved' ? { ok: true as const, machineId: selected.ref.machineId }
            : { ok: false as const, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
    };
}

function creationMachine(input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentCreateIntentInputV1) {
    return input.controllerMachineId ?? input.firstTargetLink?.machines[0]?.machineId;
}

/** Recover this issued native request's retained result without replaying its effect. */
export async function recoverUiDeploymentActionResult(params: Readonly<{
    account: LazyActionAccountContext; actionId: string; input: unknown; machineId: string;
    requestId: string; context: ActionExecutorContext; execution: ActionExecuteResult;
}>): Promise<ActionExecuteResult> {
    const { account, actionId, input, machineId, requestId, context, execution } = params;
    if (execution.ok || !isActionOutcomeUnknownErrorCodeV1(execution.errorCode)
        || !isDeploymentActionIdV1(actionId)) return execution;
    // The root returned its failed step and recovery; an uncertain child is not a lost root reply.
    if (readDeploymentTemplateInstantiationPartialV1(execution)) return execution;
    const spec = getActionSpec(actionId);
    if (!spec.operation || isDeploymentTemplatePreviewInputV1(actionId, input)) return execution;
    try {
        const operation = await withActionAccountRequestSignal(account, context.signal, signal => observeActionOperationByRequestId({
            serverId: account.serverId, accountId: account.accountId, machineId, signal,
            requestIdentity: { actionId, requestId: readDeploymentActionOperationRequestIdV1(actionId, input) ?? requestId },
        }));
        account.assertCurrent();
        if (!operation) return execution;
        const terminal = readActionOperationTerminalResultV1(operation);
        if (!terminal) return execution;
        if (!terminal.ok) return terminal;
        const settled = spec.outputSchema?.safeParse(terminal.result);
        if (settled?.success) return { ...terminal, ok: true, result: settled.data };
    } catch {
        // Observation can also be unavailable; preserve the original uncertainty.
    }
    return execution;
}

/** Account-bound storage and the existing Machine Action transport; no UI native effects. */
export function createUiDeploymentActionDeps(account: LazyActionAccountContext): Pick<ActionExecutorDeps,
    'deploymentAction' | 'deploymentSuggestionTargets' | 'deploymentSuggestionForges' | 'resolveEnvironmentApprovalScope' | 'prepareDeploymentEnvironmentCreate'
    | 'deploymentPrepare' | 'deploymentTemplateInstantiate' | 'prepareDeploymentTemplateInstantiation' | 'deploymentMoveToRepository'> & Readonly<{
        readEnvironmentCreateController(input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentCreateIntentInputV1, context: ActionExecutorContext):
            ReturnType<typeof resolveDeploymentPreviewExecutionMachineIdV1>;
        readEnvironmentController(input: Readonly<{ serverId: string; environmentId: string }>, context: ActionExecutorContext):
            Promise<Readonly<{ ok: true; machineId: string }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    }> {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    async function machine(actionId: DeploymentTransportActionIdV1 | typeof DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 | typeof DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 | 'deployments.prepare',
        input: DeploymentActionInputV1 | DeploymentTemplateInstantiateInputV1 | DeploymentMoveToRepositoryInputV1 | DeploymentPrepareInputV1,
        context: ActionExecutorContext, machineId: string) {
        // The receiving Machine consumes the original requester and completed
        // review through the same private Account carrier as other UI Actions.
        const needsInvocation = context.surface !== undefined && context.surface !== 'plugin';
        // An Account confirmation precedes controller selection. Consume its exact
        // original binding before the existing admitted-record projector targets the Machine.
        // The receiving Machine alone compares its fresh review with the carried digest.
        const confirmation = context.presentUserConfirmation;
        const admitted = confirmation?.target == null ? admitPresentUserConfirmationV1(actionId, input, context) : null;
        const requesterContext = admitted ? { ...context, presentUserConfirmation: undefined, presentUserApproval: {
            ...admitted, ...(confirmation?.reviewDigest ? { reviewDigest: confirmation.reviewDigest } : {}),
        } } : context;
        const invocation = needsInvocation ? projectExternalActionRequesterInvocationV1({ actionId, context: requesterContext, account,
            target: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : { kind: 'machine', machineId },
        }) : null;
        if (needsInvocation && !invocation) return failure('admission_unavailable');
        const requestId = context.actionRequestId ?? randomUUID();
        const result = await executeOriginalAccountMachineAction({ account, actionId, machineId,
            requestId, input,
            ...(context.externalActionTarget?.kind === 'machine' ? { machineTarget: context.externalActionTarget } : {}),
            actionCaller: context.actionCaller, authority: context.authority,
            ...(invocation ? { invocation } : {}), signal: context.signal,
            onTransportIssued: context.onTransportIssued });
        return recoverUiDeploymentActionResult({ account, actionId, input, machineId, requestId, context, execution: result });
    }
    async function storage(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1, context: ActionExecutorContext): Promise<DeploymentActionOutputV1 | ActionExecuteFailure> {
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
    const readEnvironmentController = async ({ serverId, environmentId }: Readonly<{ serverId: string; environmentId: string }>, context: ActionExecutorContext): Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure> => {
        const read = await storage('deployments.environments.get', { serverId, environmentId }, context);
        if (isDeploymentActionFailure(read)) return read;
        const current = DeploymentEnvironmentGetResultV1Schema.parse(read);
        return current.ok ? { ok: true as const, machineId: current.environment.controllerMachineId } : failure(current.error);
    };
    const readEnvironmentCreateController = async (input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentCreateIntentInputV1,
        context: ActionExecutorContext): ReturnType<typeof resolveDeploymentPreviewExecutionMachineIdV1> => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        // Prepared content already names its admitted controller. Only authored
        // previews need the canonical retained-child metadata selection.
        if (!('contentArtifactId' in input) && input.preview) {
            const preview = input.preview;
            return resolveDeploymentPreviewExecutionMachineIdV1(input, {
                listEnvironments: query => storage('deployments.environments.list', query, context),
                readTemplateController: () => readEnvironmentController({ serverId: input.serverId,
                    environmentId: preview.templateEnvironmentId }, context),
            });
        }
        const machineId = creationMachine(input);
        return machineId ? { ok: true, machineId } : failure('client_required');
    };
    const instantiateTemplate: NonNullable<ActionExecutorDeps['deploymentTemplateInstantiate']> = async (input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        const selected = await resolveDeploymentTemplateExecutionMachineIdV1(input, async selector => {
            const read = await storage('deployments.environments.get', selector, context);
            return isDeploymentActionFailure(read) ? read : DeploymentEnvironmentGetResultV1Schema.parse(read);
        }, ({ workspace }) => createUiDeploymentWorkspaceMachineReader(account, context)(workspace));
        if (!selected.ok) return selected;
        const result = await machine('deployments.templates.instantiate', input, context, selected.machineId);
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentTemplateInstantiateResultV1Schema.parse(result.result);
    };
    const moveToRepository: NonNullable<ActionExecutorDeps['deploymentMoveToRepository']> = async (input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        const selected = await resolveDeploymentMoveToRepositoryExecutionMachineIdV1(input,
            createUiDeploymentWorkspaceMachineReader(account, context));
        if (!selected.ok) return selected;
        const result = await machine(DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, input, context, selected.machineId);
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentMoveToRepositoryResultV1Schema.parse(result.result);
    };
    const deliverEnvironmentRecipients = (route: NonNullable<ActionExecutorDeps['deploymentAction']>) =>
        withDeploymentEnvironmentRecipientDeliveryV1(route, createUiDeploymentContentRecipientPorts(account, route));
    return { readEnvironmentController, readEnvironmentCreateController, resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(storage),
        deploymentSuggestionTargets: async () => {
            account.assertCurrent();
            const read = await readPluginAccountAvailability(account.accountLifetime.scope)
                .ensureCurrentAccountExecutionDeclarations({ family: 'deploymentTargets' });
            account.assertCurrent();
            if (read.kind !== 'available') throw Object.assign(new Error(read.code), { code: read.code });
            return projectDeploymentSuggestionTargetsV1(listDeploymentTargetsFromManifestsV1(read.declarations), read.declarations);
        },
        deploymentSuggestionForges: async context => {
            const execution = completeActionResult(await createUiAccountAction({ account })({
                actionId: DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, input: { projection: 'forges' }, context,
            }));
            requireActionSuccess(execution);
            const catalog = DeploySuggestionCatalogV1Schema.parse(execution.result);
            const issue = catalog.issues?.find(issue => issue.section === 'forges');
            if (issue) throw Object.assign(new Error(issue.code), { code: issue.code });
            return catalog.forges;
        },
        deploymentPrepare: async (input, context) => {
            const selected = await createUiDeploymentWorkspaceMachineReader(account, context)(input.workspace);
            if (!selected.ok) return selected;
            const result = await machine('deployments.prepare', input, context, selected.machineId);
            if (!result.ok) return result;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            return approval.success ? approval.data : DeploymentPrepareResultV1Schema.parse(result.result);
        },
        deploymentTemplateInstantiate: instantiateTemplate,
        deploymentMoveToRepository: moveToRepository,
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
            const selected = await readEnvironmentCreateController(input, context);
            if (!selected.ok) return selected;
            const result = await machine('deployments.environments.create', { ...input, mode: 'preview' }, context, selected.machineId);
            if (!result.ok) return result;
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.safeParse(result.result);
            if (!preview.success) return failure('invalid_action_output');
            account.assertCurrent();
            return { input: preview.data.input, preview: preview.data.review };
        },
        // A committed Permissions Save delivers the Environment's content to its Source audience.
        deploymentAction: deliverEnvironmentRecipients(async (actionId, input, context) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return failure('action_account_scope_changed');
        if (actionId === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 && 'projection' in input && input.projection === 'investigation') {
            const { projection, ...address } = DeploymentActionInputSchemasV1[actionId].parse(input);
            const read = await storage(actionId, address, context);
            if (isDeploymentActionFailure(read)) return read;
            const receipt = DeploymentReceiptGetResultV1Schema.parse(read);
            if (!receipt.ok) return receipt;
            return readDeploymentReceiptActionFactsV1(receipt, { ...address, projection }, async deployment => {
                const opened = readDeploymentReceiptArtifactV1(deployment,
                    await account.readArtifactContent(deployment.contentArtifactId, { signal: context.signal }));
                if (!opened.ok) return failure(opened.error);
                const detail = { deployment, content: opened.content };
                const cancellationConsequence = projectDeploymentCancellationConsequenceV1(detail);
                return { ...detail, ...(cancellationConsequence ? { cancellationConsequence } : {}) };
            });
        }
        const placement = resolveActionExecutionPlacementForInput(getActionSpec(actionId), input, context.actionCaller, context.surface ?? 'ui');
        if (actionId !== DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && actionId !== DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1
            && !isDeploymentEnvironmentPlacementActionV1(actionId, input, placement)) {
            return storage(actionId, input, context);
        }
        const selectedReadInput = isDeploymentReadActionIdV1(actionId)
            ? DeploymentActionInputSchemasV1[actionId].parse(input) : undefined;
        const effectInput = selectedReadInput ?? DeploymentActionInputSchemasV1[actionId].parse(input);
        let machineId: string;
        if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
            const create = DeploymentActionInputSchemasV1[actionId].parse(input);
            const selected = await readEnvironmentCreateController(create, context);
            if (!selected.ok) return selected;
            machineId = selected.machineId;
        }
        else {
            const selected = await resolveDeploymentEnvironmentExecutionMachineIdV1(actionId, effectInput, {
                readEnvironmentController: address => readEnvironmentController(address, context),
            });
            if (!selected.ok) return selected;
            machineId = selected.machineId;
        }
        // The controller owns preparation and approval. Preserve the sealed person/agent origin so its
        // existing review owner can carry a person's review back for native confirmation.
        const result = await machine(actionId, effectInput, context, machineId);
        if (!result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        return approval.success ? approval.data : DeploymentActionOutputSchemasV1[actionId].parse(result.result);
    }) };
}
