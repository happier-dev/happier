import { PET_IMPORT_ACTION_ID_V1 } from '../actionIdsPetsV1.js';
import { PetImportInputV1Schema } from '../../pets/importActionV1.js';
import { ACCOUNT_DELETE_ACTION_ID_V1, HOME_ACCOUNTS_DELETE_ACTION_ID_V1 } from '../accountLifecycleActionIdsV1.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionPreparedOperation, HostReviewedChildrenPlanV1, HostReviewedChildrenPreparationV1 } from './types.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { SessionStatusResultSchema } from '../../sessions/control/contract.js';
import { resolveSessionIdFromInput, resolveServerIdForSession } from './sessionScope.js';
import { isPresentUserHostInvocation, isSignedSessionSpawnWithoutRequesterTeam } from '../invocationAuthority.js';
import { type ApprovalRequestV1 } from '../../approvals/approvalRequestV1.js';
import { getActionSpec, type ActionSpec } from '../actionSpecs.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { WidgetLayoutFragmentActionIdV1Schema } from '../../widgets/fragmentActionIdsV1.js';
import { readWidgetLayoutFragmentActionAccountV1, readWidgetLayoutFragmentApprovalNameV1 } from '../../widgets/fragmentActionsV1.js';
import { machineAccessApprovalDisclosure } from '../specs/machine/access.js';
import type { ApprovalPresentationContext } from '../actionSpecs.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { ActionInvokeInputSchema } from '../actionInvokeInput.js';
import { formatQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { ComputerSelectedTargetResponseV1Schema, type ComputerApprovalDisplayV1 } from '../../computer/v1.js';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { DeploymentActionInputSchemasV1, DeploymentDeployInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentEnvironmentCreateInputV1Schema,
  DeploymentEnvironmentCreationReviewV1Schema, DeploymentTeardownPreparedInputV1Schema, DeploymentPromoteInputV1Schema,
  DeploymentDeployIntentInputV1Schema, DeploymentRollbackIntentInputV1Schema, DeploymentPromoteIntentInputV1Schema,
  DeploymentTeardownAuthoredInputV1Schema } from '../../deployments/deploymentActionsV1.js';
import { DeploymentTemplateInstantiationReviewV1Schema } from '../../deployments/deploymentTemplateInstantiationV1.js';
import { WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1 } from '../../widgets/actionsV1.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import type { ActionExecuteFailure } from './types.js';
import { LocalServiceStartApprovalReviewV1Schema, type DaemonLocalServiceLauncherStartRequestV1 } from '../../local/services/launcher/v1.js';
import { admitWidgetActionSurfaceV1, readWidgetActionSurfaceAdmissionV1 } from '../../widgets/widgetActionScopeV1.js';
import { WidgetInstanceV1Schema } from '../../widgets/widgetInstanceV1.js';
import { isSameWidgetDefinitionV1, readBuiltinWidgetDescriptorV1 } from '../../widgets/builtinWidgetDescriptorV1.js';
import { projectPublicProfilePreparedReview } from '../specs/accountProfile.js';
import { ProjectPrepareInputV1Schema, readProjectSetupTrustRequestOperationV1 } from '../projectActionFamily.js';
import { ProjectDefinitionInspectOutputSchema } from '../projectDefinitionActionFamily.js';
import { TeamInvitationAcceptApprovalPrepareResultV1Schema, TeamInvitationAcceptInputV1Schema } from '../../teams/invitation.js';
import { MachineSetupApplyInputV1Schema, ManagedAcquireInputV1Schema,
  readManagedAcquireAccountSignInReviewV1 } from '../../machines/managed/actionsV1.js';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { MachinePoolDeleteInputV1Schema, MachinePoolDeleteReviewV1Schema } from '../../machines/pools/v1.js';
import { parseProviderActionRequestV1, PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '../../providers/providerActionsV1.js';
import { DaemonProviderConnectionsDescribeResponseV1Schema } from '../../rpc/providers.js';
import { prepareProviderEndpointPolicyReviewFromViewV1, summarizeProviderEndpointPolicyReviewV1 } from '../../providers/connections/endpointPolicyReviewV1.js';
import { ProviderErrorV1Schema } from '../../providers/errors.js';
import { areProviderContributionKeysEqualV1 } from '../../providers/contributionIdentityV1.js';
import { projectApprovalReviewInput } from '../actionApprovalPresentation.js';
import { appendTeamCredentialSourceSummary, prepareTeamCredentialSources, readTeamCredentialApprovalSources } from '../specs/teamCredentialApproval.js';
import { SAVED_HEALTH_ALERT_TEST_ACTION_ID } from '../notificationConfigurationActionIds.js';
import { NotificationConfigurationActionInputSchemas, SavedHealthAlertTestApprovalReviewSchema } from '../notificationConfigurationActionFamily.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { invokeHostReviewedChildV1 } from './deploymentRoleChild.js';
import { DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1 } from '../specs/deploymentPreparationScope.js';
import { readReviewedDeploymentDomainRemovalsV1 } from './hostReviewedChildrenV1.js';
import { DeploymentRemovalApprovalReviewV1Schema } from '../../deployments/deploymentReviewV1.js';
import { prepareTeamMemberApprovalPresentation } from '../specs/teamMemberApproval.js';

export function mapApprovalCreatedBySurface(surface: ActionExecutorContext['surface']): ApprovalRequestV1['createdBy']['surface'] {
  if (surface === 'voice') return 'voice';
  if (surface === 'agent') return 'agent';
  if (surface === 'mcp') return 'mcp';
  if (surface === 'cli') return 'cli';
  // UI surfaces (and unknown surfaces) map to `system`.
  return 'system';
}

/**
 * The approval's human title. The target Session travels as the request's own `sessionId` (readers
 * name it from there), so it is never appended to the title as a raw id.
 */
export function buildApprovalSummary(spec: ActionSpec, input?: unknown, preview?: unknown): string {
  const previewSummary = readRecord(preview).summary;
  const summary = typeof previewSummary === 'string' && previewSummary.trim()
    ? previewSummary.trim()
    : buildApprovalPreviewSummary(spec, input);
  const fragmentName = WidgetLayoutFragmentActionIdV1Schema.safeParse(spec.id).success
    ? readWidgetLayoutFragmentApprovalNameV1(input, preview) : null;
  if (fragmentName) return `${summary} · ${fragmentName}`;
  const disclosure = machineAccessApprovalDisclosure(spec.id, input);
  return disclosure ? `${summary}\n\n${disclosure.description}` : summary;
}

function sentenceTerminated(value: string): string {
  return /[.!?\u2026\u3002\uff01\uff1f]$/u.test(value) ? value : `${value}.`;
}

/** One canonical summary source for every approval and present-user confirmation; domain presenters refine exact effects. */
export function buildApprovalPreviewSummary(spec: ActionSpec, input: unknown, context?: ApprovalPresentationContext): string {
  let domainSummary: string | null = null;
  try {
    domainSummary = spec.approvalPresentation?.summary?.(input, context)?.trim() || null;
  } catch {
    // Presentation cannot become a second effect-admission failure.
  }
  const fallback = String(spec.title ?? spec.id).trim();
  return appendTeamCredentialSourceSummary(sentenceTerminated(domainSummary ?? (fallback || String(spec.id))), context?.teamCredentialSources ?? []);
}

/** Project from the same normalized operand that admission and dispatch consume. */
export function projectPreparedActionOperation(actionId: ActionId, input: unknown,
  context: ActionExecutorContext, classification: Pick<ActionPreparedOperation, 'safety'>): ActionPreparedOperation {
  const spec = getActionSpec(actionId);
  const normalizedInput = projectNativeJsonValueForTransport(input);
  const capturedTargets = context.sessionTargetsV1;
  const sessionTargetsV1 = capturedTargets ? { ...capturedTargets,
    targets: capturedTargets.targets.map(target => ({ ...target })),
    ...(capturedTargets.operands ? { operands: capturedTargets.operands.map(operand => ({ ...operand,
      target: { ...operand.target } })) } : {}) } : undefined;
  return { actionId, normalizedInput,
    inputDigest: computeActionInputApprovalDigestV1(actionId, normalizedInput, sessionTargetsV1),
    summary: buildApprovalPreviewSummary(spec, normalizedInput),
    ...(classification.safety ? { safety: classification.safety } : {}), irreversible: spec.irreversible === true,
    canConfirmInFlow: isPresentUserHostInvocation(context),
    ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
    ...(context.agentStartWorkDepth === undefined ? {} : { agentStartAdmission: { workDepth: context.agentStartWorkDepth,
      ...(context.agentStartWorkspaceWrites ? { workspaceWrites: context.agentStartWorkspaceWrites } : {}) } }) };
}

export async function resolveComputerActionSelection(
  deps: ActionExecutorDeps,
  input: unknown,
  context: ActionExecutorContext,
) {
  if (!deps.runtimeActionExecute) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const requested = readRecord(input);
  const rawSelection = await deps.runtimeActionExecute({ actionId: 'computer.target.get',
    input: { machineId: requested.machineId, ...(requested.provider === undefined ? {} : { provider: requested.provider }) }, context });
  const failure = readActionFailureEnvelope(rawSelection);
  if (failure) return failure;
  const selection = ComputerSelectedTargetResponseV1Schema.safeParse(rawSelection);
  return selection.success
    ? { ok: true as const, selection: selection.data }
    : { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}

type ExecutePreparationAction = (actionId: ActionId, input: unknown, context?: ActionExecutorContext) =>
  Promise<import('./types.js').ActionExecuteResult>;

export async function readDeploymentPreparation(deps: ActionExecutorDeps, actionId: ActionId, input: unknown,
  context: ActionExecutorContext, retainedReview?: JsonValue,
  executeCanonicalAction?: ExecutePreparationAction,
): Promise<
  | Readonly<{ input: unknown; preview: JsonValue; hostReviewedChildren?: HostReviewedChildrenPreparationV1 }>
  | ActionExecuteFailure
  | Extract<Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareDeploymentAction']>>>, { observePendingOperation: unknown }>
  | null
> {
  if (actionId === 'deployments.environments.create' && deps.prepareDeploymentEnvironmentCreate) {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    // Prepared/replayed refs are the reviewed operands. Preview dispatch reaches
    // the installed host directly, following the template preview pattern.
    if ('contentArtifactId' in parsed.data || parsed.data.mode === 'preview') return null;
    const prepared = await deps.prepareDeploymentEnvironmentCreate({ input: parsed.data, context,
      ...(retainedReview === undefined ? {} : { creationReview: DeploymentEnvironmentCreationReviewV1Schema.parse(retainedReview) }) });
    if ('errorCode' in prepared) return prepared;
    const reviewed = DeploymentActionInputSchemasV1['deployments.environments.create'].safeParse(prepared.input);
    const review = DeploymentEnvironmentCreationReviewV1Schema.safeParse(prepared.preview);
    if (!reviewed.success || !review.success) return { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const authored = parsed.data;
    const candidate = reviewed.data;
    const values = review.data.creationDefaults.values;
    const { provenance: _provenance, headSha: _headSha, ...previewReference } = authored.preview ?? {};
    if (candidate.serverId !== authored.serverId || candidate.projectSourceId !== authored.projectSourceId
      || !sameStrictJsonValue(candidate.newProject ?? null, authored.newProject ?? null)
      || candidate.requestKey !== authored.requestKey || candidate.protection !== authored.protection
      || candidate.purpose !== authored.purpose || candidate.deployerMode !== authored.deployerMode
      || candidate.previewCompanionOfEnvironmentId !== authored.previewCompanionOfEnvironmentId
      || candidate.managedRetention !== authored.managedRetention
      || !sameStrictJsonValue(candidate.deployerPrincipals ?? null, authored.deployerPrincipals ?? null)
      || !sameStrictJsonValue(candidate.copyFrom ?? null, authored.copyFrom ?? null)
      || !sameStrictJsonValue(candidate.preview ?? null, authored.preview === undefined ? null : previewReference)
      // Preview placement comes from this exact template admission at the host.
      // Ordinary creation retains the person's explicit runtime selection.
      || authored.preview === undefined
        && !sameStrictJsonValue(candidate.firstTargetLink?.machines ?? null, authored.firstTargetLink?.machines ?? null)
      || candidate.controllerMachineId !== values.controllerMachineId || candidate.buildMachineId !== values.buildMachineId
      || review.data.creationDefaultsBasis?.projectSourceId !== authored.projectSourceId
      || authored.controllerMachineId !== undefined && values.controllerMachineId !== authored.controllerMachineId
      || authored.buildMachineId !== undefined && values.buildMachineId !== authored.buildMachineId
      || authored.retainPreviousDeployments !== undefined && values.retainPreviousDeployments !== authored.retainPreviousDeployments)
      return { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' };
    if (context.signal?.aborted) return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
    return { input: reviewed.data, preview: projectNativeJsonValueForTransport(review.data),
      ...(prepared.hostReviewedChildren ? { hostReviewedChildren: prepared.hostReviewedChildren } : {}) };
  }
  if (actionId === 'deployments.backups.restore' && deps.prepareDeploymentRestore) {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const prepared = await deps.prepareDeploymentRestore({ input: parsed.data, context });
    if ('errorCode' in prepared) return prepared;
    const reviewed = DeploymentActionInputSchemasV1[actionId].safeParse(prepared.input);
    return reviewed.success ? { input: reviewed.data, preview: prepared.preview }
      : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  }
  if (actionId === 'deployments.teardown' && deps.prepareDeploymentTeardown) {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if ('mode' in parsed.data && parsed.data.mode === 'preview') return { input: parsed.data,
      preview: projectNativeJsonValueForTransport(parsed.data) };
    const confirmed = context.presentUserConfirmation?.actionId === actionId
      && context.presentUserConfirmation.reviewDigest !== undefined;
    const prepared = await deps.prepareDeploymentTeardown({ input: parsed.data, context,
      ...(executeCanonicalAction && !confirmed && retainedReview === undefined ? {
        invokePreview: child => invokeHostReviewedChildV1({
          parent: { actionId, input: projectNativeJsonValueForTransport(parsed.data) as Record<string, JsonValue> },
          context,
          child: { ...child, role: DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1 },
          // This declared read is part of preparation. It uses the root's existing read ceiling.
          admittedReview: { action: child.action, role: DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1,
            surface: context.surface ?? 'ui' },
          execute: (childInput, childContext, childId) => executeCanonicalAction(childId, childInput, childContext),
        }),
      } : {}),
      readWorkflowInvocation: async reference => deps.workflowAction
        ? deps.workflowAction({ actionId: 'workflow.run.invocations.get', input: reference, context })
        : { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' } });
    if ('errorCode' in prepared) return prepared;
    const reviewed = DeploymentTeardownPreparedInputV1Schema.safeParse(prepared.input);
    if (!reviewed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    return { ...prepared, input: reviewed.data };
  }
  if (actionId === 'machines.setup.apply' && deps.prepareMachineSetupApply
    && context.actionCaller?.kind !== 'workflowRun'
    && !context.externalActionExecutionAuthorization?.binding.managedContinuation) {
    const parsed = MachineSetupApplyInputV1Schema.safeParse(input);
    if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const prepared = await deps.prepareMachineSetupApply({ input: parsed.data, context });
    if ('errorCode' in prepared) return prepared;
    if (!sameStrictJsonValue(parsed.data, prepared.input)) return { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' };
    return { input: prepared.input, preview: prepared.preview };
  }
  if (actionId === 'deployments.templates.instantiate' && deps.prepareDeploymentTemplateInstantiation) {
    const schema = DeploymentActionInputSchemasV1[actionId];
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if (parsed.data.mode === 'preview') return null;
    const prepared = await deps.prepareDeploymentTemplateInstantiation({ input: parsed.data, context, executeCanonicalAction });
    if ('errorCode' in prepared) return prepared;
    const review = DeploymentTemplateInstantiationReviewV1Schema.safeParse(prepared.preview);
    if (!review.success) return { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    // The template owner may request deployment while reviewing a new Environment.
    // Every authored operand remains exact; only its reviewed deploy can be added.
    const expectedInput = parsed.data.environment.kind === 'create' && parsed.data.deploy === undefined && review.data.deploy
      ? { ...parsed.data, deploy: review.data.deploy } : parsed.data;
    const reviewed = schema.safeParse(prepared.input);
    if (!reviewed.success || !sameStrictJsonValue(reviewed.data, expectedInput))
      return { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' };
    if (context.signal?.aborted) return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
    return { input: reviewed.data, preview: projectNativeJsonValueForTransport(review.data),
      ...(prepared.hostReviewedChildren ? { hostReviewedChildren: prepared.hostReviewedChildren } : {}) };
  }
  if ((actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback' && actionId !== 'deployments.promote') || !deps.prepareDeploymentAction) return null;
  const schema = DeploymentActionInputSchemasV1[actionId];
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const prepared = await deps.prepareDeploymentAction({ actionId, input: parsed.data, context });
  if ('errorCode' in prepared) return prepared;
  if ('observePendingOperation' in prepared) return actionId === 'deployments.deploy' && !('contentArtifactId' in parsed.data)
    ? prepared : { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  const reviewed = (actionId === 'deployments.deploy' ? DeploymentDeployInputV1Schema
    : actionId === 'deployments.rollback' ? DeploymentRollbackInputV1Schema : DeploymentPromoteInputV1Schema).safeParse(prepared.input);
  if (!reviewed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  if (context.signal?.aborted) return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
  return { input: reviewed.data, preview: prepared.preview,
    ...(prepared.hostReviewedChildren ? { hostReviewedChildren: prepared.hostReviewedChildren } : {}) };
}

/** The pressed contribution's own title, verb, description and field names, read once from the receiver's catalog. */
function readContributedActionReview(deps: ActionExecutorDeps, input: unknown) {
  const invocation = ActionInvokeInputSchema.safeParse(input);
  if (!invocation.success) return null;
  const id = formatQualifiedPluginActionId(invocation.data.action);
  const definition = deps.listContributedActionDefinitions?.({ id }).find(candidate => candidate.id === id);
  if (!definition) return null;
  return {
    title: definition.title,
    ...(definition.confirmVerb === undefined ? {} : { confirmVerb: definition.confirmVerb }),
    ...(definition.description ? { description: definition.description } : {}),
    fields: (definition.inputHints?.fields ?? []).map(field => ({ path: field.path, title: field.title })),
  };
}

/** Compact rollout operands supply operation identity across a persisted approval. */
export function readDeploymentRolloutSemanticInput(actionId: ActionId, input: unknown) {
  switch (actionId) {
    case 'deployments.deploy': return DeploymentDeployIntentInputV1Schema.safeParse(input).data;
    case 'deployments.promote': return DeploymentPromoteIntentInputV1Schema.safeParse(input).data;
    case 'deployments.rollback': return DeploymentRollbackIntentInputV1Schema.safeParse(input).data;
    default: return undefined;
  }
}

export function readDeploymentApprovalSemanticInput(actionId: ActionId, input: unknown) {
  return actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
    ? DeploymentTeardownAuthoredInputV1Schema.safeParse(input).data
    : readDeploymentRolloutSemanticInput(actionId, input);
}

export async function prepareApprovalRequest(params: Readonly<{
  deps: ActionExecutorDeps;
  actionId: ActionId;
  input: unknown;
  actionArgs: unknown;
  context: ActionExecutorContext;
  computerApprovalDisplay?: ComputerApprovalDisplayV1;
  widgetSurfaceRead?: ReturnType<typeof WidgetSurfaceReadV1Schema.parse>;
  deploymentReview?: JsonValue;
  semanticInput?: unknown;
  hostReviewedChildren?: HostReviewedChildrenPlanV1;
  hostReviewedContent?: JsonValue;
  forCarriedReview?: boolean;
  handoffTargetReplacementApproval?: NonNullable<ActionExecutorContext['handoffTargetReplacementApproval']>;
  executeCanonicalAction?: ExecutePreparationAction;
}>): Promise<Readonly<{ actionArgs: unknown; preview: unknown }> | ActionExecuteFailure | null> {
  const spec = getActionSpec(params.actionId);
  if (params.actionId === 'machines.pools.delete') {
    if (!params.deps.machinePoolAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const { poolId, expectedRevision } = MachinePoolDeleteInputV1Schema.parse(params.input);
    const input = { poolId, expectedRevision };
    const prepared = await params.deps.machinePoolAction({
      actionId: 'machines.pools.delete', input: { poolId, prepareDelete: true },
      context: params.context, signal: params.context.signal,
    });
    const failure = readActionFailureEnvelope(prepared);
    if (failure) return failure;
    const review = MachinePoolDeleteReviewV1Schema.safeParse(prepared).data;
    if (!review) return { ok: false, errorCode: 'machine_pool_request_failed', error: 'machine_pool_request_failed' };
    return {
      actionArgs: { ...input, expectedBrokerReferencesWitness: review.witness },
      preview: {
        actionId: params.actionId, actionArgs: input, summary: buildApprovalPreviewSummary(spec, input),
        ...(review.teamCredentialBrokerAssignments ? { teamCredentialBrokerAssignments: review.teamCredentialBrokerAssignments } : {}),
      },
    };
  }
  if (params.actionId === PET_IMPORT_ACTION_ID_V1) {
    const input = PetImportInputV1Schema.parse(params.input);
    if (input.source.kind === 'machine' && params.deps.preparePetImport) {
      const prepared = await params.deps.preparePetImport({ input, context: params.context });
      if ('ok' in prepared) return prepared;
      return { actionArgs: prepared.input, preview: prepared.preview };
    }
  }
  if (params.actionId === SAVED_HEALTH_ALERT_TEST_ACTION_ID) {
    const unavailable = { ok: false as const, errorCode: 'notification_test_preparation_unavailable',
      error: 'notification_test_preparation_unavailable' };
    if (!params.deps.prepareNotificationTestApproval) return unavailable;
    const input = NotificationConfigurationActionInputSchemas[SAVED_HEALTH_ALERT_TEST_ACTION_ID].safeParse(params.input);
    if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const prepared = await params.deps.prepareNotificationTestApproval({ input: input.data, context: params.context });
    const failure = readActionFailureEnvelope(prepared);
    if (failure) return failure;
    const review = SavedHealthAlertTestApprovalReviewSchema.safeParse(prepared);
    if (!review.success || !sameStrictJsonValue(review.data.request, input.data)
      || review.data.controllerMachineId !== input.data.machineId) return unavailable;
    return { actionArgs: input.data, preview: { actionId: params.actionId, actionArgs: input.data,
      summary: `Send a saved health alert test. Sent from ${review.data.controllerMachineId}. Destination: ${createCanonicalJsonSigningInput(review.data.destination)}. ${review.data.disclosure}`,
      notificationTestReview: review.data } };
  }
  const teamCredentialSources = [
    ...readTeamCredentialApprovalSources(params.hostReviewedContent),
    ...await prepareTeamCredentialSources({ deps: params.deps, context: params.context,
      selection: spec.approvalPresentation?.teamCredentialSources?.(params.input) }),
  ];
  if (params.actionId === 'machines.reboot') {
    const [{ MachineRebootInputV1Schema }, { MachineServicesListResultV1Schema }, { readMachineDeploymentReferencesV1 }] = await Promise.all([
      import('../specs/machine/reboot.js'), import('../specs/machine/services.js'), import('../../machines/machineReferenceCensusV1.js'),
    ]);
    const parsed = MachineRebootInputV1Schema.safeParse(params.input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const input = parsed.data;
    const [deploymentReferences, services] = await Promise.all([
      params.deps.machineRebootReferences ? readMachineDeploymentReferencesV1({
        homeId: params.context.serverIdentityId ?? input.serverId, machineId: input.machineId, signal: params.context.signal,
      }, selection => params.deps.machineRebootReferences!({ input, context: params.context,
        ...(selection.cursor ? { cursor: selection.cursor } : {}), signal: params.context.signal })) : null,
      (async () => {
        try {
          const raw = await params.deps.machineServiceAction?.({ actionId: 'machines.services.list',
            input: { serverId: input.serverId, machineId: input.machineId }, context: params.context, signal: params.context.signal });
          const result = MachineServicesListResultV1Schema.safeParse(raw);
          return result.success ? result.data : null;
        } catch { params.context.signal?.throwIfAborted(); return null; }
      })(),
    ]);
    params.context.signal?.throwIfAborted();
    // Missing/partial roles and service facts are honest review warnings, never
    // another maintenance decision or an approval floor.
    return { actionArgs: params.actionArgs, preview: { actionId: params.actionId, actionArgs: params.input,
      summary: buildApprovalPreviewSummary(spec, params.input), machineRebootReview: { kind: 'machineReboot',
        ...input, deploymentReferences, services } } };
  }
  if (params.actionId === 'providers.connections.secrets.bind' || params.actionId === 'providers.connections.create_contribution') {
    if (!params.deps.providerActionExecute) return { ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable' };
    const input = params.actionId === 'providers.connections.secrets.bind'
      ? PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.secrets.bind'].parse(params.input)
      : PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.create_contribution'].parse(params.input);
    params.context.signal?.throwIfAborted();
    // Account declaration metadata is sufficient: setup review must not probe a vendor,
    // resolve Saved Secret material, or require an already configured endpoint.
    const read = await params.deps.providerActionExecute(parseProviderActionRequestV1('providers.connections.describe',
      input.action === 'bindSecret' ? { connectionId: input.connectionId } : {}), params.context);
    if (!read.ok) return read;
    const described = DaemonProviderConnectionsDescribeResponseV1Schema.safeParse(read.result);
    if (!described.success || described.data.status !== 'success') return { ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable' };
    const view = input.action === 'bindSecret'
      ? described.data.connections.find(connection => connection.connectionId === input.connectionId)
      : described.data.connections.find(connection => connection.contributionKey !== null
        && areProviderContributionKeysEqualV1(connection.contributionKey, input.contributionKey));
    const credential = input.action === 'bindSecret' ? view?.credential
      : view?.credential ?? described.data.available.find(contribution => areProviderContributionKeysEqualV1(contribution.contributionKey, input.contributionKey))?.credential;
    const authorityDescription = credential?.authorityDescription;
    const observedInput = spec.projectObservationInput?.(params.input) ?? params.input;
    const summary = buildApprovalPreviewSummary(spec, observedInput);
    return { actionArgs: params.actionArgs, preview: { actionId: params.actionId, actionArgs: projectApprovalReviewInput(spec, params.input),
      summary: authorityDescription ? `${summary}\n\n${typeof authorityDescription === 'string' ? authorityDescription : authorityDescription.fallback}` : summary,
      ...(authorityDescription ? { providerCredentialAuthority: { authorityDescription } } : {}) } };
  }
  if (params.actionId === 'providers.connections.endpoint.set') {
    if (!params.deps.providerActionExecute) return { ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable' };
    const input = PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.endpoint.set'].parse(params.input);
    params.context.signal?.throwIfAborted();
    const read = await params.deps.providerActionExecute(parseProviderActionRequestV1('providers.connections.describe', {
      connectionId: input.connectionId, ...(input.scope === 'machine' ? { machineId: input.machineId } : {}),
    }), params.context);
    if (!read.ok) return read;
    const described = DaemonProviderConnectionsDescribeResponseV1Schema.safeParse(read.result);
    const view = described.success && described.data.status === 'success' ? described.data.connections.find(connection => connection.connectionId === input.connectionId) : undefined;
    if (!view) return { ok: false, errorCode: 'provider_connection_not_found', error: 'provider_connection_not_found' };
    try {
      const review = prepareProviderEndpointPolicyReviewFromViewV1(view, input);
      const actionArgs = input;
      return { actionArgs, preview: { actionId: params.actionId, actionArgs,
        summary: summarizeProviderEndpointPolicyReviewV1(review), providerEndpointPolicyReview: review } };
    } catch (error) {
      const failure = ProviderErrorV1Schema.safeParse(error);
      const code = failure.success ? failure.data.code : 'provider_connection_invalid';
      return { ok: false, errorCode: code, error: code };
    }
  }
  const deployment = params.deploymentReview === undefined
    ? params.actionId === 'machines.setup.apply' && params.deps.prepareMachineSetupApply
      || params.actionId === 'deployments.templates.instantiate' && params.deps.prepareDeploymentTemplateInstantiation
      || params.actionId === 'deployments.environments.create' && params.deps.prepareDeploymentEnvironmentCreate
      || params.actionId === 'deployments.backups.restore' && params.deps.prepareDeploymentRestore
      || params.actionId === 'deployments.teardown' && params.deps.prepareDeploymentTeardown
      || (params.actionId === 'deployments.deploy' || params.actionId === 'deployments.rollback' || params.actionId === 'deployments.promote') && params.deps.prepareDeploymentAction
      ? await readDeploymentPreparation(params.deps, params.actionId, params.input, params.context, undefined, params.executeCanonicalAction) : null
    : { input: params.actionArgs, preview: params.deploymentReview };
  // Observation callbacks stay host-private; review only the ordinary Action input.
  if (deployment && !('observePendingOperation' in deployment)) {
    if ('errorCode' in deployment) return deployment;
    const originalInput = readDeploymentApprovalSemanticInput(params.actionId, params.semanticInput ?? params.input);
    const deferredCreate = params.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
      && typeof readRecord(deployment.preview).definitionCommitment === 'string';
    let displayArgs = deployment.input;
    if (deferredCreate) {
      // Compact Create has no stored reference before consent. Its commitment
      // binds the normalized definition, including private copied content.
      const input = readRecord(deployment.input);
      displayArgs = projectNativeJsonValueForTransport({
        serverId: input.serverId, projectSourceId: input.projectSourceId, newProject: input.newProject,
        requestKey: input.requestKey, name: input.name, controllerMachineId: input.controllerMachineId,
        buildMachineId: input.buildMachineId, protection: input.protection, purpose: input.purpose,
        deployerMode: input.deployerMode, firstTargetLink: input.firstTargetLink,
      });
    }
    const domains = params.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
      ? readReviewedDeploymentDomainRemovalsV1(params.hostReviewedChildren) : [];
    const summary = [buildApprovalSummary(spec, displayArgs, deployment.preview),
      ...domains.map(({ hostname }) => `Also removes the Domain ${hostname}.`)].join(' ');
    const review = domains.length ? DeploymentRemovalApprovalReviewV1Schema.safeParse(deployment.preview) : undefined;
    const deploymentReview = review?.success
      ? { ...review.data, removal: { ...review.data.removal, domains: domains.map(({ hostname }) => hostname) } }
      : deployment.preview;
    return { actionArgs: params.forCarriedReview ? displayArgs : deployment.input,
      preview: { actionId: params.actionId, actionArgs: displayArgs,
      summary: appendTeamCredentialSourceSummary(summary, teamCredentialSources),
      ...(teamCredentialSources.length ? { teamCredentialSources } : {}), deploymentReview,
      ...(originalInput === undefined ? {} : { deploymentRolloutSemanticInput: originalInput }),
      ...(params.hostReviewedChildren ? { hostReviewedChildren: params.hostReviewedChildren } : {}) } };
  }
  if (params.actionId === 'localServices.launcher.start') {
    if (!params.deps.prepareLocalServiceStartApproval) return null;
    const input = params.input as DaemonLocalServiceLauncherStartRequestV1;
    const prepared = await params.deps.prepareLocalServiceStartApproval({ input, context: params.context,
      ...(params.executeCanonicalAction ? { executeCanonicalAction: params.executeCanonicalAction } : {}) });
    const failure = readActionFailureEnvelope(prepared);
    if (failure) return failure;
    const review = LocalServiceStartApprovalReviewV1Schema.safeParse(prepared);
    // The launcher may fill omitted workspace/declaration operands from its
    // published target. It must preserve every operand supplied by the caller;
    // approval and replay bind the completed request and the reviewed effect.
    if (!review.success || !sameStrictJsonValue(review.data.request, { ...review.data.request, ...input })) return null;
    return { actionArgs: review.data.request, preview: { actionId: params.actionId, actionArgs: review.data.request,
      summary: buildApprovalPreviewSummary(spec, review.data.request), serviceStartReview: review.data } };
  }
  let computerApprovalDisplay = params.computerApprovalDisplay;
  if (!computerApprovalDisplay && (params.actionId === 'computer.target.select'
    || params.actionId === 'computer.capture' || params.actionId === 'computer.query' || params.actionId === 'computer.input')) {
    const selection = await resolveComputerActionSelection(params.deps, params.input, params.context);
    if (!selection.ok) return null;
    computerApprovalDisplay = selection.selection.approvalDisplay;
  }
  if (computerApprovalDisplay && params.actionId === 'computer.target.select') {
    computerApprovalDisplay = { machineDisplayName: computerApprovalDisplay.machineDisplayName, requiresTargetSelection: true };
  }
  const observedInput = spec.projectObservationInput
    ? spec.projectObservationInput(params.input)
    : params.input;
  const fragmentAction = WidgetLayoutFragmentActionIdV1Schema.safeParse(params.actionId);
  if (fragmentAction.success) {
    const account = readWidgetLayoutFragmentActionAccountV1(params.input);
    if (!account) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
    const failure = await admitWidgetActionSurfaceV1(params.deps, { ...account, owner: { kind: 'home' } }, params.context);
    if (failure) return failure;
  }
  const libraryItem = fragmentAction.success && ['widgets.fragment.update', 'widgets.fragment.delete', 'widgets.fragment.duplicate'].includes(params.actionId)
    && typeof readRecord(params.input).artifactId === 'string' && params.deps.widgetLayoutFragmentArtifacts
    ? await params.deps.widgetLayoutFragmentArtifacts.get(String(readRecord(params.input).artifactId), params.context.signal) : null;
  const widgetLibraryName = fragmentAction.success
    ? libraryItem?.name ?? readWidgetLayoutFragmentApprovalNameV1(params.input) : null;
  const summaryInput = libraryItem ? { ...readRecord(params.input), fragment: { name: libraryItem.name } } : params.input;
  const nativePermissionAnswer = params.actionId === 'session.permission.respond'
    && readRecord(params.input).nativeChoice !== undefined;
  let sessionPermissionRequest: Record<string, unknown> | null = null;
  if (nativePermissionAnswer && params.deps.sessionStatusGet) {
    const sessionId = resolveSessionIdFromInput(params.input, params.context);
    if (sessionId) {
      try {
        const serverId = resolveServerIdForSession(params.deps, params.context, sessionId);
        const status = SessionStatusResultSchema.safeParse(await params.deps.sessionStatusGet({ sessionId,
          context: params.context, ...(serverId ? { serverId } : {}), ...(params.context.signal ? { signal: params.context.signal } : {}) }));
        const request = status.success && status.data.session.id === sessionId
          ? status.data.pendingRequests?.find(request => request.kind === 'permission'
            && request.requestId === readRecord(params.input).requestId) : undefined;
        if (request?.nativeChoices) sessionPermissionRequest = { sessionId, requestId: request.requestId,
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          nativeChoices: { ...request.nativeChoices,
            choices: request.nativeChoices.choices.map(({ response: _response, ...choice }) => choice) } };
      } catch {
        // Unavailable display context uses the presenter's existing unavailable result.
        params.context.signal?.throwIfAborted();
      }
    }
  }
  let widgetPresentation: ApprovalPresentationContext['widgetPresentation'];
  if (params.actionId === 'widgets.item.add' || params.actionId === 'widgets.item.remove') {
    const surface = readWidgetActionSurfaceV1(params.input);
    if (surface) {
      try {
        const admitted = params.widgetSurfaceRead ? { ok: true as const, read: params.widgetSurfaceRead }
          : await readWidgetActionSurfaceAdmissionV1(params.deps, surface, params.context,
            params.actionId === 'widgets.item.remove' ? { readPlacement: true } : undefined);
        if (!admitted.ok) return admitted;
        const ref = readRecord(readRecord(params.input).ref);
        const instance = WidgetInstanceV1Schema.safeParse(params.actionId === 'widgets.item.add' ? readRecord(params.input).instance
          : admitted.read?.instances.find(entry => entry.instance.id === ref.instanceId)?.instance);
        const knownWidgetName = instance.success ? instance.data.displayName
          || readBuiltinWidgetDescriptorV1(instance.data.definition)?.title : undefined;
        // A known widget's exact Action must not await unrelated library
        // inventory (which can be yielding to background bootstrap).
        const entries = !knownWidgetName && instance.success && params.deps.widgetCatalog
          ? await params.deps.widgetCatalog.list(surface, params.context, params.context.signal) : null;
        const catalog = entries && !('ok' in entries) ? entries : null;
        const widgetName = knownWidgetName || (instance.success
          ? catalog?.find(entry => isSameWidgetDefinitionV1(entry.definition, instance.data.definition))?.title : undefined);
        const surfaceNames = await params.deps.widgetCatalog?.describeSurface?.(surface, params.context, params.context.signal);
        if (widgetName || surfaceNames) widgetPresentation = { ...surfaceNames, ...(widgetName ? { widgetName } : {}) };
      } catch {
        // Optional display data cannot become a second execution/admission requirement.
        params.context.signal?.throwIfAborted();
      }
    }
  }
  const teamMemberPresentation = params.actionId === 'teams.members.add'
    ? await prepareTeamMemberApprovalPresentation(params) : null;
  // A pressed contributed Action is reviewed by its own declaration, not by the generic `action.invoke` host Action.
  const contributedAction = params.actionId === 'action.invoke' ? readContributedActionReview(params.deps, observedInput) : null;
  const defaultPreview = {
    actionId: params.actionId,
    ...(contributedAction ? { contributedAction } : {}),
    ...(params.hostReviewedContent === undefined ? {} : { hostReviewedContent: params.hostReviewedContent }),
    ...(params.hostReviewedChildren ? { hostReviewedChildren: params.hostReviewedChildren } : {}),
    actionArgs: observedInput,
    summary: buildApprovalPreviewSummary(spec, summaryInput, { ...(widgetPresentation ? { widgetPresentation } : {}),
      ...(teamMemberPresentation ? { teamMemberPresentation } : {}), teamCredentialSources }),
    ...(teamMemberPresentation ? { teamMemberPresentation } : {}),
    ...(teamCredentialSources.length ? { teamCredentialSources } : {}),
    ...(widgetPresentation ? { widgetPresentation } : {}),
    ...(widgetLibraryName ? { widgetLibraryName } : {}),
    ...(params.context.publicProfilePreparedAction?.actionId === params.actionId
      ? { publicProfileRequest: projectPublicProfilePreparedReview(params.context.publicProfilePreparedAction.request), destination: { serverId: params.context.serverId,
          accountId: params.context.expectedAccountId } } : {}),
  } as const;
  if (params.actionId === 'computer.secret.fill' || params.actionId === 'browser.automation.secret.fill') {
    return { actionArgs: observedInput, preview: { actionId: params.actionId, actionArgs: observedInput } };
  }
  const customized = await params.deps.buildApprovalPreview?.({
    actionId: params.actionId,
    input: spec.approvalInputCustody === 'live_only' ? observedInput : params.input,
    context: params.context,
    defaultPreview,
  }) ?? defaultPreview;
  const preparationFailure = readActionFailureEnvelope(customized);
  if (preparationFailure) return preparationFailure;
  const { accountErasure: _untrustedErasure, ...customizedRecord } = readRecord(customized);
  const erasureAccountId = readRecord(params.input).accountId;
  const accountErasure = (params.actionId === ACCOUNT_DELETE_ACTION_ID_V1 || params.actionId === HOME_ACCOUNTS_DELETE_ACTION_ID_V1)
    && typeof erasureAccountId === 'string'
    ? await params.deps.readAccountErasureReview?.({ accountId: erasureAccountId, context: params.context }) : null;
  if (accountErasure && 'ok' in accountErasure) return accountErasure;
  // The target's passive inspection owns setup review. Caller-provided preview
  // fields cannot become commands, consent, or an independent effect calculator.
  const setupInput = params.actionId === 'projects.prepare' ? ProjectPrepareInputV1Schema.safeParse(params.input) : null;
  const retainedSetupResponse = setupInput?.success && setupInput.data.consentScope === 'untilChanged' && params.deps.actionOperationAction
    ? await params.deps.actionOperationAction({ actionId: 'action.operations.get', input: {
      serverId: setupInput.data.workspace.serverId, machineId: setupInput.data.workspace.machineId,
      operationId: setupInput.data.heldOperationId!, refreshSetupReview: true,
    }, context: params.context, signal: params.context.signal }) : undefined;
  const retainedSetupFailure = readActionFailureEnvelope(retainedSetupResponse);
  if (retainedSetupFailure) return retainedSetupFailure;
  const retainedSetup = setupInput?.success && setupInput.data.consentScope === 'untilChanged'
    ? readProjectSetupTrustRequestOperationV1(setupInput.data, retainedSetupResponse) : null;
  if (setupInput?.success && setupInput.data.consentScope === 'untilChanged' && !retainedSetup) return {
    ok: false, errorCode: 'project_setup_review_unavailable', error: 'project_setup_review_unavailable',
  };
  const inspectedSetup = setupInput?.success && setupInput.data.consentScope !== 'untilChanged' && setupInput.data.phase === 'setup' && params.deps.projectDefinitionAction
    ? ProjectDefinitionInspectOutputSchema.safeParse(await params.deps.projectDefinitionAction({ actionId: 'projects.inspect',
      input: { workspace: setupInput.data.workspace, read: { kind: 'setup' } }, context: params.context })) : null;
  const setupReview = retainedSetup?.setupReview ? {
    reviewedEffectDigest: retainedSetup.setupReview.reviewedEffectDigest,
    reviewedEffect: retainedSetup.setupReview.reviewedEffect,
  } : inspectedSetup?.success ? inspectedSetup.data.setupReview : undefined;
  if (setupReview && setupInput?.success && setupInput.data.expectedEffectDigest
    && setupInput.data.expectedEffectDigest !== setupReview.reviewedEffectDigest) return {
      ok: false, errorCode: 'project_setup_effect_changed', error: 'project_setup_effect_changed',
      details: { kind: 'pendingApproval', code: 'project_setup_effect_changed', ...setupReview,
        ...(setupInput.data.consentScope ? { consentScope: setupInput.data.consentScope } : {}) },
    };
  const customizedSummary = typeof customizedRecord.summary === 'string'
    ? customizedRecord.summary.trim()
    : '';
  const summary = customizedSummary && customizedSummary !== defaultPreview.summary
    ? appendTeamCredentialSourceSummary(customizedSummary, teamCredentialSources) : defaultPreview.summary;
  const teamCredentialDefaults = params.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && isSignedSessionSpawnWithoutRequesterTeam(params.context)
    ? 'unavailable_without_requester_team' as const : undefined;
  const accountSignIn = params.actionId === MANAGED_ACQUIRE_ACTION_ID_V1
    ? readManagedAcquireAccountSignInReviewV1(ManagedAcquireInputV1Schema.parse(params.input).selection) : undefined;
  const preview = {
    ...customizedRecord,
    actionId: params.actionId,
    ...(params.handoffTargetReplacementApproval ? { handoffTargetReplacementApproval: params.handoffTargetReplacementApproval } : {}),
    ...(params.hostReviewedChildren ? { hostReviewedChildren: params.hostReviewedChildren } : {}),
    ...(params.context.sessionTargetsV1 ? { sessionTargets: params.context.sessionTargetsV1.targets } : {}),
    // This private preview is distinct from shared observations. A declared
    // review schema validates its safe projection, including live-only inputs
    // whose raw operands stay with the originating waiter.
    actionArgs: projectApprovalReviewInput(spec, params.input),
    summary,
    ...(accountSignIn ? { accountSignIn } : {}),
    ...(teamCredentialDefaults ? { teamCredentialDefaults } : {}),
    ...(teamCredentialSources.length ? { teamCredentialSources } : {}),
    // The host's scoped read owns these labels; custom previews cannot replace them.
    ...(nativePermissionAnswer ? { sessionPermissionRequest } : {}),
    ...(widgetLibraryName ? { widgetLibraryName } : {}),
    ...(computerApprovalDisplay ? { computerApprovalDisplay } : {}),
    ...(widgetPresentation ? { widgetPresentation } : {}),
    ...(setupReview ? { setupReview } : {}),
    ...(accountErasure ? { accountErasure } : {}),
    ...(machineAccessApprovalDisclosure(params.actionId, params.input)
      ? { machineAccessDisclosure: machineAccessApprovalDisclosure(params.actionId, params.input) } : {}),
  };

  // Declared live-only input custody: the durable record carries only this
  // Action's own safe observation projection. `resolveActionApprovalRouting`
  // keeps the admitted invocation as the blocking waiter, so the raw input
  // never leaves it, and a replay without that invocation fails closed.
  if (spec.approvalInputCustody === 'live_only') {
    return { actionArgs: observedInput, preview };
  }

  if (params.actionId !== 'teams.invitations.accept' || !params.deps.homeDomainAction) {
    return { actionArgs: params.actionArgs, preview };
  }
  const admission = TeamInvitationAcceptInputV1Schema.safeParse(params.input);
  if (!admission.success || !('token' in admission.data)) {
    return { actionArgs: params.actionArgs, preview };
  }

  // A token-bearing acceptance must not cross the durable Approval boundary.
  // The authenticated Home atomically exchanges it for the existing Account-bound
  // post-auth continuation and returns the bounded invitation preview. This happens
  // before execution-origin signing so external callers bind the exact continuation
  // that will later be replayed. Failure is fail-closed: no Approval Artifact exists.
  let rawPrepared: unknown;
  try {
    rawPrepared = await params.deps.homeDomainAction({
      actionId: 'teams.invitations.accept.prepareApproval',
      input: { v: 1, token: admission.data.token },
      context: {
        ...(params.context.serverId ? { serverId: params.context.serverId } : {}),
        ...(params.context.surface ? { surface: params.context.surface } : {}),
        ...(params.context.signal ? { signal: params.context.signal } : {}),
      },
      ...(params.context.signal ? { signal: params.context.signal } : {}),
    });
  } catch {
    return null;
  }
  const resolved = TeamInvitationAcceptApprovalPrepareResultV1Schema.safeParse(rawPrepared);
  if (!resolved.success || resolved.data.outcome !== 'ok') return null;
  const invitation = resolved.data.preview;
  return {
    actionArgs: { v: 1, continuation: resolved.data.continuation },
    // Do not retain caller/adapter customization for the bearer-bearing form: a
    // custom summary-like field could otherwise become a parallel secret-bearing
    // presentation channel. Only Home-owned bounded facts cross this boundary.
    preview: {
      actionId: params.actionId,
      actionArgs: {
        v: 1,
        homeServerId: invitation.home.serverId,
        continuation: { teamId: invitation.team.teamId },
        teamName: invitation.team.name,
        role: invitation.role,
        historyAccess: invitation.historyAccess,
        state: invitation.state,
        expiresAt: invitation.expiresAt,
        recipientEmailMask: invitation.recipientEmailMask,
      },
    },
  };
}
