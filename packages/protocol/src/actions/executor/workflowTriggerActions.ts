import { isPluginAutomationActionSubjectV1, readPluginAutomationSubjectV1 } from '../../automations/automationPluginSubjectV1.js';
import { encodeBase64 } from '../../crypto/base64.js';
import { collectWorkflowTriggerEventReferencesV1, createWorkflowActionTriggerEventDeclarationV1, type WorkflowTriggerEventDeclarationV1 } from '../../workflows/workflowTriggerEventReferenceV1.js';
import type {
  AutomationDefinitionCreateRequest, AutomationDefinitionDetail, AutomationTriggerDetail, AutomationDefinitionListResponse,
  AutomationDefinitionDetailsResponse, AutomationTriggerEventDeclarationsRequest, AutomationTriggerEventDeclarationsResponse,
  AutomationDefinitionReconcileRequest, AutomationTriggerReconcileExistingItem, AutomationDefinitionListRequest, AutomationDeleteResponse,
} from '../../automations/automationApiV3.js';
import { AutomationV3RunMutationResponseSchema, type AutomationV3RunMutationResponse } from '../../automations/automationApiV3.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { isDeploymentReceiptEventSourceV1, readDeploymentReceiptEventSubjectV1 } from '../../deployments/deploymentReceiptEventsV1.js';
import { HealthCheckSourceConfigV1Schema, isHealthCheckEventSourceV1, readHealthCheckEventSubjectV1 } from '../../deployments/healthCheckSourceV1.js';
import type { AutomationEventTriggerDefinitionStoredPayloadV1 } from '../../automations/automationEventV1.js';
import { createActionAutomationPrivateMatchingV1 } from './actionAutomationPrivateMatching.js';
import type { ActionAutomationPrepareMatchingV1 } from './actionAutomationAdmission.js';
import { readAutomationTemplateStoredEnvelopeV1 } from '../../automations/automationTemplateStoredV1.js';
import {
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationStoredWorkflowDefinitionV2ReadSchema,
  type AutomationStoredWorkflowDefinitionRecipeV2, type WorkflowTriggerContextV1,
} from '../../automations/automationWorkflowRecipeV2.js';
import { isKeepGoingTriggerTargetV1, readTriggerTargetV1, type TriggerTargetV1 } from '../../workflows/triggers/triggerTargetV1.js';
import { parseWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '../../artifacts/artifactListSelectionV1.js';
import { resolveInheritedApprovalProfileIdV1 } from '../approvalProfiles.js';
import { ActionRefusalDiagnosticV1Schema } from '../actionRefusalDiagnostic.js';
import { resolveWorkflowRunVisibleTeamV1 } from '../../workflows/workflowRunVisibilityV1.js';
import {
  WorkflowTriggerAddRequestV1Schema, WorkflowTriggerListRequestV1Schema,
  WorkflowSubjectsListRequestV1Schema, type WorkflowSubjectsListRequestV1, type WorkflowSubjectsListResultV1,
  WorkflowAttachedTriggerPageV1Schema,
  WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerRemoveRequestV1Schema,
  WorkflowTriggerRunNowRequestV1Schema, type WorkflowTriggerRunNowRequestV1,
  type WorkflowTriggerAddRequestV1, type WorkflowTriggerListRequestV1,
  type WorkflowTriggerUpdateRequestV1, type WorkflowTriggerRemoveRequestV1,
  type WorkflowTriggerSetV1,
  type WorkflowTriggerWriteResultV1Schema,
  type WorkflowTriggerListResultV1Schema, type WorkflowTriggerRemoveResultV1Schema,
  type SessionTriggerListResultV1Schema,
  SessionTriggerListRequestV1Schema, SessionTriggerAddRequestV1Schema,
  SessionTriggerUpdateRequestV1Schema, SessionTriggerRemoveRequestV1Schema,
  type SessionTriggerListRequestV1, type SessionTriggerAddRequestV1,
  type SessionTriggerUpdateRequestV1, type SessionTriggerRemoveRequestV1,
  type SessionPullRequestLinkV1, type SessionTriggerDefinitionV1, type SessionTriggerPullRequestLinksV1,
  type WorkflowTriggerSummaryInputV1, type WorkflowIntendedTriggerV1, type WorkflowIntendedPluginEventV1,
  type WorkflowTriggerHealthSourceV1,
  WorkflowDeploymentBackupTargetV1Schema,
  summarizeWorkflowTriggerRowsV1,
  isWorkflowTriggerSourceGoneV1,
  SessionInitialTriggerV1Schema, type SessionInitialTriggerV1, type SessionInitialTriggerDefinitionV1,
} from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionInitialTriggerAdmissionV1Schema, type SessionInitialTriggerAdmissionV1 } from '../../sessions/creation/sessionInitialTriggerAdmissionV1.js';
import { AutomationTriggerDefinitionInputSchema, type AutomationTriggerDefinition, type AutomationTriggerDefinitionInput } from '../../automations/automationTriggerDefinition.js';
import { ActionIdSchema } from '../actionIds.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import type { AutomationActionConsentTrigger } from '../../automations/automationActionTriggerV1.js';
import { AutomationPullRequestTriggerSchema, type AutomationPullRequestTrigger } from '../../automations/pullRequestTrigger.js';
import { admitAgentStartV1, type AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { bindWorkflowLeafInputsV1, materializeWorkflowAcceptedSnapshotV1, materializeWorkflowDefinitionAuthorityV1, readWorkflowRunLeafStartRequestV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import { resolveWorkflowProjectTargetMachineV1, type WorkflowProjectTargetV1 } from '../../workflows/workflowWorkspaceV1.js';
import { collectWorkflowLeavesV1, resolveWorkflowDestinationsV1 } from '../../workflows/workflowDestinationsV1.js';
import { resolveWorkflowRunStartInputsV1 } from '../../workflows/workflowStartPreparationV1.js';
import type { ActionExecutorDeps, WorkflowActionExecuteArgs } from './types.js';
import { admitActionAgentStartV1, isActionCallerOwnSessionV1, resolveActionAgentStartContextV1 } from './agentStartAdmission.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { canonicalizeAutomationSessionLifecycleStructuralConfiguration, projectAutomationSessionLifecycleStructuralConfiguration } from '../../automations/automationSessionLifecycle.js';
import type { AutomationRunLifecycleSource } from '../../automations/automationRunLifecycle.js';
import { ManagedPowerInputV1Schema, ManagedDeleteInputV1Schema } from '../../machines/managed/actionsV1.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import type { ManagedMachineV1 } from '../../machines/managed/managedMachineV1.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import type { WorkflowActionFailureV1 } from '../../workflows/workflowProgressV1.js';
import type { WorkflowApprovedOperationV1 } from '../../actions/approvedOperationV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { readWorkflowTriggerConsentSteps, readWorkflowTriggerActorConsentSteps, normalizeStoredWorkflowTriggerConsent } from './workflowTriggerConsent.js';
import type { WorkflowApprovedOperationNativeAccountV1 } from './workflowRunActions.js';
import type { WorkflowDefinitionSavedByV1 } from '../../workflows/workflowDefinitionV1.js';
import { resolveInitialDeploymentApprovalV1 } from '../../deployments/deploymentApprovalScopeV1.js';
import type { DeploymentDeploySemanticInputV1 } from '../../deployments/deploymentDeployIntentV1.js';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { readDeploymentBackupOccurrenceV1 } from '../../workflows/builtins/backupExamples.js';
import { DeploymentEnvironmentGetInputV1Schema } from '../../deployments/deploymentActionsV1.js';
import { WORKFLOW_TRIGGER_SET_STORAGE_NAME, workflowTriggerDisplayNameV1 } from '../../workflows/workflowStepLabel.js';
import type { ApprovalRequestDecideInputSchema } from '../specs/approvals.js';
import type { ActionAutomationAllowConsentV1, ActionAutomationSelectedTriggerV1,
  ActionAutomationTriggerReferenceV1, ActionAutomationConsentResolutionV1 } from './actionAutomationAdmission.js';
import type { ActionAutomationConsentReviewV1 } from '../../approvals/approvalAutomaticChecks.js';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID, WORKFLOW_TRIGGER_UPDATE_ACTION_ID, WORKFLOW_TRIGGER_REMOVE_ACTION_ID,
  type WorkflowTriggerMutationActionId } from '../workflowTriggerActionIds.js';

type Caller = WorkflowActionExecuteArgs['context'];
type AdmittedSessionWrite = Readonly<{
  sessionId: string; project: WorkflowProjectTargetV1; authority?: AgentStartContextV1;
  onComplete?: WorkflowTriggerContextV1['onComplete'];
}>;
type WorkflowTriggerWriteResult = ReturnType<typeof WorkflowTriggerWriteResultV1Schema.parse>;

export type WorkflowActorConsentSelection = Readonly<{
  workflow: string;
  workflowRevision: number;
  matching: Omit<NonNullable<WorkflowTriggerContextV1['actorConsent']>, 'agentSteps'>;
  project: WorkflowProjectTargetV1;
  /** Own consent identity selected once by the host's consentFor index. */
  saved?: Readonly<{ automationId: string; triggerId: string; workflowRevision: number }>;
}>;
export type WorkflowActorConsentReadSelection = Omit<WorkflowActorConsentSelection, 'project'> & Readonly<
  { project: WorkflowProjectTargetV1 } | { resolveProject: () => Promise<WorkflowProjectTargetV1> }
>;
export type WorkflowActorConsentReference = Readonly<{
  automationId: string;
  triggerId: z.infer<typeof AutomationTriggerIdSchema>;
  triggerRevision: number;
  workflowRevision: number;
}>;

function actorConsentMatching(selection: Pick<WorkflowActorConsentSelection, 'matching'>) {
  return { ...selection.matching, actionIds: [...new Set(selection.matching.actionIds)].sort() };
}

export type WorkflowTriggerAutomationOperations = Readonly<{
  list: (input: Readonly<Partial<AutomationDefinitionListRequest>>) => Promise<AutomationDefinitionListResponse>;
  listDetails: (input: Readonly<Partial<AutomationDefinitionListRequest>>) => Promise<AutomationDefinitionDetailsResponse>;
  readTriggerEventDeclarations?: (input: AutomationTriggerEventDeclarationsRequest) => Promise<AutomationTriggerEventDeclarationsResponse>;
  get: (automationId: string) => Promise<AutomationDefinitionDetail | null>;
  /** Awaited encoding adapters re-run this owner-supplied check immediately before transport. */
  create: (input: AutomationDefinitionCreateRequest, beforeWrite?: () => Promise<void>, signal?: AbortSignal) => Promise<AutomationDefinitionDetail>;
  reconcile: (automationId: string, input: AutomationDefinitionReconcileRequest,
    current?: AutomationDefinitionDetail, beforeWrite?: () => Promise<void>, signal?: AbortSignal) => Promise<AutomationDefinitionDetail>;
  delete: (automationId: string, current?: AutomationDefinitionListResponse['automations'][number], signal?: AbortSignal) => Promise<AutomationDeleteResponse>;
  runNow?: (automationId: string, options?: Readonly<{ idempotencyKey?: string }>, caller?: Caller) => Promise<AutomationV3RunMutationResponse>;
}>;
export type WorkflowTriggerActionsDependencies = Readonly<{
  automations: WorkflowTriggerAutomationOperations;
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
  nativeAccount?: WorkflowApprovedOperationNativeAccountV1;
  deploymentAction?: ActionExecutorDeps['deploymentAction'];
  /** Existing Home-bound Session-list transport; the shared resolver owns current led access. */
  sessionList?: ActionExecutorDeps['sessionList'];
  sessionRead?: ActionExecutorDeps['sessionRead'];
  resolveServerProfileScopeId?: ActionExecutorDeps['resolveServerProfileScopeId'];
  openContext: (automation: AutomationDefinitionDetail) => Promise<unknown>;
  sealContext: (input: Readonly<{ automationId: string; templateVersion: number; context: WorkflowTriggerContextV1 }>) => Promise<AutomationStoredWorkflowDefinitionRecipeV2>;
  newId: (kind: 'automation' | 'trigger') => string;
  /** One authorized current-definition read supplies both execution content and display provenance. */
  resolveWorkflow: (ref: string) => Promise<Readonly<{
    definition: WorkflowDefinitionV1; savedBy?: WorkflowDefinitionSavedByV1; savedAt?: number;
  }>>;
  /** Authorized Artifact grant transport; visibility policy remains shared with Run admission. */
  resolveWorkflowTeamIds?: (artifactId: string) => Promise<readonly string[]>;
  /** Session transport authorizes and opens the Session; callers cannot choose placement. */
  resolveSession?: (sessionId: string, caller?: Caller, options?: Readonly<{ checkNativeGoalOwner: boolean }>) => Promise<Readonly<{
    project: WorkflowProjectTargetV1; nativeGoalOwner: boolean | null;
    /** Current Session-owned execution facts, used when converting its retained Automation. */
    executionSelection?: WorkflowDefinitionV1['defaults'];
  }>>;
  resolveRunTrigger?: (runId: string) => Promise<Readonly<{ sessionId: string; triggerId: string; automationId: string }> | null>;
  /** Exact authorized Run read; no caller-created lifecycle or placement facts. */
  resolveRunSource?: (source: AutomationRunLifecycleSource, caller?: Caller) => Promise<Readonly<{ terminal: boolean }>>;
  /** Authenticated Home row read; inline managed Actions never acquire caller-selected controller placement. */
  resolveManagedMachine?: (input: Readonly<{ homeId: string; managedId: string }>, caller?: Caller) => Promise<ManagedMachineV1>;
  resolveMaterializer?: (target: WorkflowProjectTargetV1, caller: Caller) => Promise<Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'effects' | 'roleSelection'>>;
  /** The legacy owner supplies its typed conversion; no second mapping here. */
  convertLegacy?: (automation: AutomationDefinitionDetail, caller?: Caller) => Promise<Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1;
    project?: WorkflowProjectTargetV1 }>>;
  /** Framing and authenticated Account mode only; never opens retained private content. */
  requiresLegacyReview?: (automation: AutomationDefinitionDetail) => Promise<boolean>;
  openPullRequestTrigger?: (automation: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'prComment' | 'ciFailed' }>) => Promise<AutomationPullRequestTrigger>;
  openSessionLifecycleTrigger?: (automation: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'sessionLifecycle' }>) => Promise<import('../../automations/automationTriggerDefinition.js').AutomationSessionLifecycleTrigger>;
  prepareBirthTrigger?: (automationId: string, triggerId: string, trigger: AutomationTriggerDefinitionInput) => Promise<AutomationTriggerDefinitionInput>;
  openActionTrigger?: (automation: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'action' }>) => Promise<import('../../automations/automationActionTriggerV1.js').AutomationActionTrigger>;
  openPluginEventTrigger?: (automation: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'pluginEvent' }>) => Promise<AutomationEventTriggerDefinitionStoredPayloadV1>;
  pullRequests?: Readonly<{
    listLinks: (sessionId: string, caller?: Caller) => Promise<SessionPullRequestLinkV1[]>;
    attach: (input: Readonly<{ sessionId: string; automationId: string; triggerId: string; triggerRevision: number;
      triggerKind: 'prComment' | 'ciFailed'; pullRequest: AutomationPullRequestTrigger['pullRequest'] }>, caller?: Caller) => Promise<void>;
    removeTrigger: (input: Readonly<{ sessionId: string; triggerId: string }>, caller?: Caller) => Promise<void>;
  }>;
}>;

export interface WorkflowTriggerActions {
  /** Host-private selected envelope reader; no editor projection or Workflow resolution. */
  prepareActionMatching(accountId: string): ActionAutomationPrepareMatchingV1;
  prepareMutation: (args: WorkflowActionExecuteArgs<WorkflowTriggerMutationActionId>)
    => Promise<Pick<Caller, 'workflowTriggerMutationAdmission'>>;
  readActorConsent: (input: WorkflowActorConsentReadSelection & Readonly<{
    /** The canonical action-trigger owner supplies the revision update arm. */
    consentTrigger: AutomationActionConsentTrigger & Readonly<{ enabled: boolean }>;
  }>, caller: Caller) => Promise<Readonly<{ current: false; review?: ActionAutomationConsentReviewV1 }> | (WorkflowActorConsentReference & Readonly<{ current: true }>)>;
  saveActorConsent: (input: WorkflowActorConsentSelection & Readonly<{
    consentTrigger: AutomationActionConsentTrigger & Readonly<{ enabled: boolean }>;
    decisionInput: z.infer<typeof ApprovalRequestDecideInputSchema>;
  }>, caller: Caller) => Promise<WorkflowActorConsentReference>;
  readWorkflowTriggerEvents: (input: Readonly<{ workflow: string; intendedTriggers?: readonly WorkflowIntendedTriggerV1[] }>)
    => Promise<readonly WorkflowTriggerEventDeclarationV1[]>;
  readSavedConsent: (input: Readonly<{ automationId: string; triggerId: string; ownerAccountId: string;
    operation: WorkflowApprovedOperationV1;
  }>, caller: Caller) => Promise<WorkflowApprovedOperationV1 | null>;
  runNow: (raw: WorkflowTriggerRunNowRequestV1, caller?: Caller) => Promise<AutomationV3RunMutationResponse>;
  readWorkflowSummaries: (workflowDefinitionIds: readonly string[]) => Promise<ReadonlyMap<string, Readonly<{
    triggers: readonly WorkflowTriggerSummaryInputV1[]; nextRunAt: number | null;
  }>>>;
  listSubjects: (raw: WorkflowSubjectsListRequestV1) => Promise<WorkflowSubjectsListResultV1>;
  list: (raw: WorkflowTriggerListRequestV1, caller?: Caller) => Promise<ReturnType<typeof WorkflowTriggerListResultV1Schema.parse>>;
  add: (raw: WorkflowTriggerAddRequestV1, caller?: Caller) => Promise<WorkflowTriggerWriteResult>;
  update: (raw: WorkflowTriggerUpdateRequestV1, caller?: Caller) => Promise<WorkflowTriggerWriteResult>;
  remove: (raw: WorkflowTriggerRemoveRequestV1, caller?: Caller) => Promise<ReturnType<typeof WorkflowTriggerRemoveResultV1Schema.parse>>;
  removeForWorkflow: (workflow: string, signal?: AbortSignal) => Promise<void>;
  prepareSessionInitialTriggers: (input: Readonly<{
    initialTriggers: readonly SessionInitialTriggerV1[]; project: WorkflowProjectTargetV1; preparedFinalSessionId: string; caller?: Caller;
  }>) => Promise<SessionInitialTriggerAdmissionV1[]>;
  sessionList: (raw: SessionTriggerListRequestV1, caller?: Caller) => Promise<ReturnType<typeof SessionTriggerListResultV1Schema.parse>>;
  sessionAdd: (raw: SessionTriggerAddRequestV1, caller?: Caller) => Promise<WorkflowTriggerWriteResult>;
  sessionUpdate: (raw: SessionTriggerUpdateRequestV1, caller?: Caller) => Promise<WorkflowTriggerWriteResult>;
  sessionRemove: (raw: SessionTriggerRemoveRequestV1, caller?: Caller) => Promise<WorkflowTriggerWriteResult>;
  /** Native Goal handoff uses the incumbent Session trigger writer. */
  removeSessionKeepGoingTriggers: (raw: SessionTriggerListRequestV1, caller?: Caller) => Promise<void>;
}

/** Both Account hosts bind their workspace reader to this one consent owner. */
export function createWorkflowActorConsentPortV1(options: Readonly<{
  actions: Pick<WorkflowTriggerActions, 'readActorConsent' | 'saveActorConsent' | 'prepareActionMatching'>;
  accountId: string;
  resolveProject(context: Caller): Promise<WorkflowProjectTargetV1>;
}>): Readonly<{
  resolveConsent(args: Readonly<{ selection: ActionAutomationSelectedTriggerV1; context: Caller }>): Promise<ActionAutomationConsentResolutionV1>;
  allowConsent(args: Parameters<ActionAutomationAllowConsentV1>[0] & Readonly<{ executionContext: Caller }>): Promise<ActionAutomationTriggerReferenceV1>;
  prepareMatching: ActionAutomationPrepareMatchingV1;
}> {
  const selectionInput = (selection: ActionAutomationSelectedTriggerV1) => {
    const saved = selection.consent?.row;
    return { workflow: selection.workflowId, workflowRevision: selection.workflowRevision,
      matching: { actionIds: [...selection.actionIds], phase: selection.phase,
        ...(selection.subject ? { subject: selection.subject } : {}) },
      ...(saved ? { saved: { automationId: saved.automationId, triggerId: saved.triggerId,
        workflowRevision: saved.consentedWorkflowRevision ?? saved.workflowRevision } } : {}),
      consentTrigger: { kind: 'action' as const, enabled: true,
        consentFor: { automationId: selection.automationId, triggerId: selection.triggerId },
        consentedWorkflowRevision: selection.workflowRevision },
    };
  };
  const reference = (selection: ActionAutomationSelectedTriggerV1, saved: WorkflowActorConsentReference): ActionAutomationTriggerReferenceV1 => {
    const { consent: _consent, subject: _subject, ...matching } = selection;
    return { ...matching, automationId: saved.automationId, triggerId: saved.triggerId,
      triggerRevision: saved.triggerRevision, workflowRevision: saved.workflowRevision, ownerAccountId: options.accountId,
      consentFor: { automationId: selection.automationId, triggerId: selection.triggerId },
      consentedWorkflowRevision: saved.workflowRevision };
  };
  return {
    prepareMatching: options.actions.prepareActionMatching(options.accountId),
    async resolveConsent({ selection, context }) {
      if (!selection.consent?.row) return { current: false };
      const current = await options.actions.readActorConsent({ ...selectionInput(selection),
        resolveProject: () => options.resolveProject(context) }, context);
      return current.current ? { current: true, row: reference(selection, current) } : current;
    },
    async allowConsent({ selection, context, executionContext, decisionInput }) {
      const saved = await options.actions.saveActorConsent({ ...selectionInput(selection),
        project: await options.resolveProject(executionContext), decisionInput }, context);
      return reference(selection, saved);
    },
  };
}

/** Inline managed scope effects are identified from the incumbent executable target, never extra scope metadata. */
export function readManagedMachineTriggerAction(target: TriggerTargetV1) {
  if (target.kind !== 'inline' || target.definition.blocks.length !== 1) return null;
  const block = target.definition.blocks[0];
  if (block?.kind !== 'action' || (block.actionId !== 'machines.managed.power.set' && block.actionId !== 'machines.managed.delete')) return null;
  const input: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(block.input)) {
    if (binding.kind !== 'literal') return null;
    input[key] = binding.value;
  }
  const parsed = (block.actionId === 'machines.managed.delete' ? ManagedDeleteInputV1Schema : ManagedPowerInputV1Schema).safeParse(input);
  return parsed.success && parsed.data.when === 'after-idle'
    ? { actionId: block.actionId, input: parsed.data } : null;
}

function refuse(code: string, details?: unknown): never {
  throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}
function refuseInput(code: NonNullable<NonNullable<Extract<WorkflowActionFailureV1, { errorCode: 'invalid_input' }>['details']>['code']>): never {
  return refuse('invalid_input', { code });
}
function unresolvedWriteReceipt(cause: unknown): never {
  throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
}
/** Shared host-routing predicate for trigger operations that consume Agent-start authority. */
export function isWorkflowTriggerAgentCallerV1(caller?: Caller) {
  return caller?.surface === 'agent' || caller?.actionCaller?.kind === 'session' || caller?.actionCaller?.kind === 'workflowRun'
    || caller?.actionCaller?.kind === 'automationRun';
}
function retainedTriggers(row: AutomationDefinitionDetail): AutomationTriggerReconcileExistingItem[] {
  return row.triggers.map((trigger) => ({ kind: 'existing', triggerId: trigger.id, expectedRevision: trigger.revision }));
}

async function automationRows<T>(readPage: (input: Readonly<Partial<AutomationDefinitionListRequest>>) => Promise<Readonly<{
  automations: readonly T[]; nextCursor: string | null;
}>>,
  filter: Readonly<Partial<AutomationDefinitionListRequest>>) {
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage({ ...filter, ...(cursor ? { cursor } : {}) });
    rows.push(...page.automations);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** The retained Event owner supplies saved health configuration and the actual remote watcher together. */
export async function readSavedHealthCheckSourceSnapshotV1(deps: Readonly<{
  automations: Pick<WorkflowTriggerAutomationOperations, 'listDetails'>;
  openPluginEventTrigger?: WorkflowTriggerActionsDependencies['openPluginEventTrigger'];
}>, selection: Pick<WorkflowSubjectsListRequestV1, 'sources'> = {}): Promise<ReadonlyMap<string, WorkflowTriggerHealthSourceV1>> {
  if (!deps.openPluginEventTrigger) refuse('source_unavailable');
  const candidates = new Map<string, WorkflowTriggerHealthSourceV1>();
  const priority = (candidate: WorkflowTriggerHealthSourceV1) => candidate.enabled ? candidate.observer ? 2 : 1 : 0;
  for (const row of await automationRows(deps.automations.listDetails, { healthCheckSources: selection })) {
    for (const trigger of row.triggers) {
      if (trigger.kind !== 'pluginEvent' || !isHealthCheckEventSourceV1(trigger)) continue;
      const definition = await deps.openPluginEventTrigger(row, trigger);
      // Transition listeners use these Events without defining saved probes.
      const source = HealthCheckSourceConfigV1Schema.safeParse(definition.sourceConfig);
      if (!source.success) continue;
      const sourceInstanceId = definition.sourceInstanceId;
      const candidate = { sourceInstanceId, revision: `${row.id}:${trigger.id}:${trigger.revision}`,
        source: source.data, enabled: row.enabled && trigger.enabled,
        observer: trigger.observation.kind === 'checkpointedPull' ? trigger.observation.watcher : null,
        automationId: row.id, triggerId: trigger.id } satisfies WorkflowTriggerHealthSourceV1;
      const previous = candidates.get(sourceInstanceId);
      if (!previous || priority(candidate) > priority(previous)) candidates.set(sourceInstanceId, candidate);
    }
  }
  return candidates;
}

export async function readSavedHealthCheckSourcesV1(sourceInstanceIds: readonly string[],
  deps: Parameters<typeof readSavedHealthCheckSourceSnapshotV1>[0]): Promise<WorkflowTriggerHealthSourceV1[]> {
  if (sourceInstanceIds.length === 0) return [];
  const snapshot = await readSavedHealthCheckSourceSnapshotV1(deps);
  return [...new Set(sourceInstanceIds)].flatMap(id => {
    const source = snapshot.get(id);
    return source ? [source] : [];
  });
}
async function scopedRows(automations: Pick<WorkflowTriggerAutomationOperations, 'list'>, sessionId: string | null = null,
  filter: Readonly<Partial<AutomationDefinitionListRequest>> = {}) {
  return (await automationRows(automations.list, { ...filter, ...(sessionId ? { scopeSessionId: sessionId } : {}) }))
    .filter((row) => (row.scopeSessionId ?? null) === sessionId);
}

/** Definition deletion needs the Automation census, not private trigger context. */
export async function removeWorkflowTriggersForDefinition(
  automations: Pick<WorkflowTriggerAutomationOperations, 'list' | 'delete'>,
  workflow: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const row of await automationRows(automations.list, { workflowDefinitionId: workflow })) {
    if (row.workflowDefinitionId === workflow) await automations.delete(row.id, row, signal);
  }
}

/** Trigger semantics compose the one Automation owner; no trigger storage or claim policy lives here. */
export function createWorkflowTriggerActions(deps: WorkflowTriggerActionsDependencies): WorkflowTriggerActions {
  const assertSessionAdmission = async (
    sessionId: string, caller?: Caller, removalTriggerId?: string,
  ): Promise<Readonly<{ authority?: AgentStartContextV1;
    firingTrigger?: NonNullable<Awaited<ReturnType<NonNullable<WorkflowTriggerActionsDependencies['resolveRunTrigger']>>>>;
  }>> => {
    caller?.signal?.throwIfAborted();
    if (!isWorkflowTriggerAgentCallerV1(caller)) return {};
    const admission = caller?.workflowTriggerMutationAdmission;
    const exact = admission?.actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID ? admission.exactFiringCleanup : undefined;
    if (exact && exact.lifetimeSessionId === sessionId && exact.triggerId === removalTriggerId) {
      return { firingTrigger: { automationId: exact.automationId, triggerId: exact.triggerId, sessionId: exact.lifetimeSessionId } };
    }
    if (isActionCallerOwnSessionV1(caller, sessionId)) return {};
    const authority = caller ? await resolveActionAgentStartContextV1(deps, caller, sessionId) : null;
    caller?.signal?.throwIfAborted();
    const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller?.sessionAgentSpawnPolicyV1);
    if (authority && 'ok' in authority) refuse(authority.errorCode, authority.details);
    if (!authority || !policy.success) refuse('target_unavailable');
    if (authority.caller.kind === 'originless') refuse('run_access_denied');
    const admitted = admitAgentStartV1(policy.data, { kind: 'session_target', targetSessionId: sessionId }, authority);
    if (!admitted.ok) refuse(admitted.refusal.code, admitted.refusal);
    return { authority };
  };
  const session = async (sessionId: string, caller?: Caller, removalTriggerId?: string) => {
    const admission = await assertSessionAdmission(sessionId, caller, removalTriggerId);
    if (!deps.resolveSession) refuse('target_unavailable');
    const resolved = await deps.resolveSession(sessionId, caller, { checkNativeGoalOwner: false });
    return { ...resolved, ...admission };
  };
  const readRetained = async (automationId: string, caller?: Caller) => {
    const admission = caller?.workflowTriggerMutationAdmission;
    const admitted = admission && 'row' in admission ? admission.row : undefined;
    const row = admitted?.id === automationId ? admitted : await deps.automations.get(automationId);
    if (!row) refuse('content_unavailable');
    return row;
  };
  const read = async (automationId: string, sessionId: string | null = null, caller?: Caller) => {
    const row = await readRetained(automationId, caller);
    if ((row.scopeSessionId ?? null) !== sessionId) refuse('content_unavailable');
    return row;
  };
  const readRemovalSet = async (automationId: string, caller?: Caller) => {
    // The Account census also exposes Session-scoped Manual sets. Authorize
    // their scope without opening private recipes or requiring a live runtime.
    const row = await deps.automations.get(automationId);
    if (!row) refuse('content_unavailable');
    if (row.scopeSessionId) await assertSessionAdmission(row.scopeSessionId, caller);
    return row;
  };
  const opened = async (row: AutomationDefinitionDetail, _projectionOnly = false, caller?: Caller): Promise<Readonly<{
    target: TriggerTargetV1; context: WorkflowTriggerContextV1; placements?: NonNullable<WorkflowTriggerSetV1['legacy']>['placements'];
    storedContext?: unknown;
  }>> => {
    if (row.executionRecipe?.v !== 2) {
      if (await deps.requiresLegacyReview?.(row)) refuse('legacy_conversion_unsupported', { reason: 'review_required' });
      if (!deps.convertLegacy) refuse('legacy_conversion_unsupported', { reason: 'runtime_descriptor_unsupported' });
      return deps.convertLegacy(row, caller);
    }
    const context = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(await deps.openContext(row));
    const target = readTriggerTargetV1(row, context.success ? context.data : null);
    if (!context.success || target.kind !== 'available') refuse('source_unavailable');
    const normalized = context.data.deploymentTriggers?.some(trigger => trigger.approval)
      ? await normalizeStoredWorkflowTriggerConsent({ automationId: row.id, context: context.data,
        project: project(row, context.data) }) : { context: context.data };
    return { ...normalized, target: target.target, storedContext: context.data };
  };
  const project = (row: AutomationDefinitionDetail, context: WorkflowTriggerContextV1) => {
    if (row.assignments.length !== 1) refuse('source_unavailable');
    return { machineId: row.assignments[0]!.machineId, ...context.workspace };
  };
  const resolveDefinition = async (ref: string) => (await deps.resolveWorkflow(ref)).definition;
  const readTriggerEventDeclarations = async (
    events: readonly (WorkflowTriggerEventDeclarationV1 | WorkflowIntendedPluginEventV1)[],
  ): Promise<readonly WorkflowTriggerEventDeclarationV1[]> => {
    const pending = events.filter((event): event is WorkflowIntendedPluginEventV1 => 'observationTransport' in event);
    const readDeclarations = deps.automations.readTriggerEventDeclarations;
    if (pending.length && !readDeclarations) refuse('source_unavailable');
    const declared = pending.length && readDeclarations
      ? (await readDeclarations({ triggerEventDeclarations: pending })).triggerEvents : [];
    let pendingIndex = 0;
    return events.flatMap(event => {
      if (!('observationTransport' in event)) return [event];
      const declaration = declared[pendingIndex++];
      return declaration ? [declaration] : [];
    });
  };
  const readInlineTriggerEvents = async (target: TriggerTargetV1,
    triggers: readonly (AutomationTriggerDefinition | AutomationTriggerDetail)[]) => {
    if (target.kind !== 'inline' || collectWorkflowTriggerEventReferencesV1(target.definition).length === 0) return undefined;
    return readTriggerEventDeclarations(triggers.flatMap((trigger): (WorkflowTriggerEventDeclarationV1 | WorkflowIntendedPluginEventV1)[] => {
      if (trigger.kind === 'action' && 'phase' in trigger) return [createWorkflowActionTriggerEventDeclarationV1(trigger.phase)];
      if (trigger.kind !== 'pluginEvent') return [];
      return 'observationTransport' in trigger
        ? [{ kind: 'pluginEvent', eventRef: trigger.eventRef, observationTransport: trigger.observationTransport }]
        : [{ event: trigger.eventRef, payloadSchema: trigger.payloadSchema ?? null }];
    }));
  };
  const resolveTarget = async (target: TriggerTargetV1, validate = true, triggerEvents?: readonly WorkflowTriggerEventDeclarationV1[]) => {
    const source: Awaited<ReturnType<WorkflowTriggerActionsDependencies['resolveWorkflow']>> = target.kind === 'inline'
      ? { definition: target.definition } : await deps.resolveWorkflow(target.ref);
    if (validate) {
      const checked = validateWorkflowDefinition(source.definition, { triggerEvents });
      if (!checked.valid) refuse('invalid_input', { code: 'invalid_trigger_target', issues: checked.issues });
    }
    return source;
  };
  type TriggerWrite = Readonly<{ triggerId: string; trigger: AutomationTriggerDefinition | AutomationTriggerDefinitionInput }>;
  const assertTargetAccess = async (target: TriggerTargetV1, context: WorkflowTriggerContextV1,
    triggerEvents?: readonly WorkflowTriggerEventDeclarationV1[], triggerWrites: readonly TriggerWrite[] = []) => {
    for (const { trigger } of triggerWrites) {
      if (trigger.kind !== 'action' || 'consentFor' in trigger) continue;
      // Structural headers are host output. A caller cannot author admission facts.
      if ('triggerDefinitionEnvelope' in trigger) refuseInput('trigger_definition_envelope_not_allowed');
      const { getActionSpec, isActionEffectHookableV1 } = await import('../actionSpecs.js');
      const subject = trigger.subject;
      let declaredPluginSubject = false;
      for (const actionId of trigger.actionIds) {
        const core = ActionIdSchema.safeParse(actionId);
        const contributed = core.success ? null : parseQualifiedPluginActionId(actionId);
        const contributedDefinition = contributed
          ? deps.listContributedActionDefinitions?.({ id: formatQualifiedPluginActionId(contributed) })
            .find(definition => definition.id === actionId) : undefined;
        const spec = core.success ? getActionSpec(core.data) : contributedDefinition;
        if (!spec) refuse('target_unavailable');
        if (!isActionEffectHookableV1(spec.sideEffectClass)) refuseInput('invalid_trigger_target');
        if (subject?.kind === 'plugin' && contributed && contributedDefinition
          && isPluginAutomationActionSubjectV1(subject, { pluginId: contributed.pluginId,
            approvalScope: contributedDefinition.approvalScope })) {
          const kind = contributedDefinition.subjectKindDefinition;
          if (!kind) refuse('target_unavailable');
          const admitted = readPluginAutomationSubjectV1({ ...subject,
            subjectKinds: [{ pluginId: subject.pluginId, definition: kind }] });
          if (!admitted.ok) {
            if (admitted.code === 'subject_kind_unavailable') refuse('target_unavailable');
            refuseInput('invalid_trigger_target');
          }
          declaredPluginSubject = true;
        }
      }
      if (subject?.kind === 'plugin' && !declaredPluginSubject) refuse('target_unavailable');
    }
    const resolved = await resolveTarget(target, true, triggerEvents);
    const source = target.kind === 'workflow' ? parseWorkflowDefinitionRefV1(target.ref) : null;
    const resolveTeamIds = deps.resolveWorkflowTeamIds;
    if (source?.kind === 'artifact' && !resolveTeamIds) refuse('target_unavailable');
    const teamIds = source?.kind === 'artifact' && resolveTeamIds ? await resolveTeamIds(source.artifactId) : [];
    const visibility = resolveWorkflowRunVisibleTeamV1(teamIds, context.visibleTeamId);
    if (!visibility.ok) refuse(visibility.code);
    if (source?.kind === 'artifact') context.visibleTeamId = visibility.visibleTeamId;
    return resolved;
  };
  const assertWrite = async (target: TriggerTargetV1, context: WorkflowTriggerContextV1, targetProject: WorkflowProjectTargetV1, caller?: Caller, sessionId?: string, creatingSession = false, runNow = false, admittedSession?: AdmittedSessionWrite, triggerEvents?: readonly WorkflowTriggerEventDeclarationV1[], triggerWrites?: readonly TriggerWrite[]) => {
    const source = await assertTargetAccess(target, context, triggerEvents, triggerWrites);
    const managed = readManagedMachineTriggerAction(target);
    if (managed) {
      if (!deps.resolveManagedMachine) refuse('target_unavailable');
      const row = await deps.resolveManagedMachine({ homeId: managed.input.homeId, managedId: managed.input.managedId }, caller);
      caller?.signal?.throwIfAborted();
      if (row.homeId !== managed.input.homeId || row.id !== managed.input.managedId || row.creationState !== 'active'
        || row.allocation !== 'bound' || !row.enrolledMachineId || row.controller?.machineId !== targetProject.machineId) refuse('target_unavailable');
      if (admittedSession && admittedSession.project.machineId !== row.enrolledMachineId) refuse('target_unavailable');
    }
    if (isWorkflowTriggerAgentCallerV1(caller)) {
      const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller?.sessionAgentSpawnPolicyV1);
      if (!caller || !policy.success || !deps.resolveMaterializer) refuse('target_unavailable');
      const definition = source.definition;
      const materializer = await deps.resolveMaterializer(targetProject, caller);
      const materialization = { definition, ...materializer,
        effects: { ...materializer.effects, admitSessionAuthority: async (target: Parameters<NonNullable<typeof materializer.effects.admitSessionAuthority>>[0]) => {
          if (caller.serverId && !areServerProfileIdentifiersEquivalent(target.address.serverId, caller.serverId,
            identifier => identifier === caller.serverId || identifier === caller.serverIdentityId
              ? caller.serverIdentityId : deps.resolveServerProfileScopeId?.(identifier))) return false;
          // Typed targets spend the author's start authority, independently of
          // the trigger's own scope Session and ordinary readable-child access.
          const authority = admittedSession?.sessionId === target.address.sessionId && admittedSession.authority
            ? admittedSession.authority : await resolveActionAgentStartContextV1(deps, caller, target.address.sessionId);
          return admitActionAgentStartV1(caller, { kind: 'session_target', targetSessionId: target.address.sessionId }, authority).ok;
        } },
        roleOverrides: context.roleOverrides,
        context: { actionCaller: caller.actionCaller, source: { kind: 'inline' as const }, inputs: context.inputs ?? {}, machineId: targetProject.machineId,
          executionTarget: context.executionTarget, workspaceTarget: { project: { ...targetProject, checkoutRootPath: targetProject.directory } },
          origin: { kind: 'direct' as const, ...(sessionId ? { originSessionId: sessionId } : {}) }, authorization: { principal: { kind: 'host' as const } } },
      };
      // Birth has no origin id or first turn yet. The existing definition-authority
      // materializer validates concrete leaves without inventing future Run inputs.
      const materialized = creatingSession ? await materializeWorkflowDefinitionAuthorityV1(materialization)
        : await materializeWorkflowAcceptedSnapshotV1({ ...materialization, admission: { kind: 'user' } });
      if (!materialized.ok) refuse(materialized.error.code, materialized.error);
      const authority = admittedSession?.authority ?? await resolveActionAgentStartContextV1(deps, caller, sessionId);
      caller.signal?.throwIfAborted();
      if (authority && 'ok' in authority) refuse(authority.errorCode, authority.details);
      if (!authority) refuse('target_unavailable');
      const materializedLeaves = 'snapshot' in materialized ? materialized.snapshot.materializedLeaves : materialized.materializedLeaves;
      const sourceKeys = new Set(materialized.agentStartLeaves.map((leaf) => leaf.sourceKey ?? '$root'));
      if (sourceKeys.size === 0) sourceKeys.add('$root');
      for (const sourceKey of sourceKeys) {
        const roles = { ...authority.roles };
        for (const leaf of materializedLeaves) {
          if (leaf.sourceKey === sourceKey && leaf.role) roles[leaf.role.roleId] = leaf.role;
        }
        if (runNow) {
          for (const leaf of materialized.agentStartLeaves.filter((leaf) => (leaf.sourceKey ?? '$root') === sourceKey)) {
            const admitted = admitAgentStartV1(policy.data, { ...readWorkflowRunLeafStartRequestV1(leaf),
              ...(sessionId ? { targetSessionId: sessionId } : {}) }, { ...authority, roles });
            if (!admitted.ok) refuse(admitted.refusal.code, admitted.refusal);
          }
          continue;
        }
        const admitted = admitAgentStartV1(policy.data, { kind: 'trigger_write', scope: sessionId || creatingSession ? 'session' : 'workflow',
          permissionCeiling: 'snapshot' in materialized ? materialized.snapshot.authorization.admittedPermissionCeiling : materialized.permissionCeiling,
          ...(sessionId ? { targetSessionId: sessionId } : {}),
          leaves: materialized.agentStartLeaves.filter((leaf) => (leaf.sourceKey ?? '$root') === sourceKey) }, { ...authority, roles });
        if (!admitted.ok) refuse(admitted.refusal.code, admitted.refusal);
      }
    }
    return source;
  };
  const triggerContext = (input: Partial<Omit<WorkflowTriggerContextV1, 'workspace' | 'inlineDefinition'>>, target: TriggerTargetV1,
    targetProject: WorkflowProjectTargetV1, caller?: Caller) => {
    const { machineId: _machineId, ...workspace } = targetProject;
    const approvalProfileId = resolveInheritedApprovalProfileIdV1(input.approvalProfileId, caller?.approvalProfileId);
    return AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace, executionTarget: input.executionTarget ?? { kind: 'session' },
      ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      ...(input.roleOverrides === undefined ? {} : { roleOverrides: input.roleOverrides }),
      ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
      ...(input.visibleTeamId === undefined ? {} : { visibleTeamId: input.visibleTeamId }),
      ...(input.onComplete === undefined ? {} : { onComplete: input.onComplete }),
      ...(input.deploymentPreview === undefined ? {} : { deploymentPreview: input.deploymentPreview }),
      ...(target.kind === 'inline' ? { inlineDefinition: target.definition } : {}) });
  };
  const withoutTriggerApprovals = (context: WorkflowTriggerContextV1) => {
    delete context.actionApprovals;
  };
  const approvalInput = (input: unknown) => {
    return z.record(z.string(), StrictJsonValueSchema).parse(projectNativeJsonValueForTransport(input));
  };
  const prepareActionConsent = async (input: Readonly<{
    context: WorkflowTriggerContextV1; definition: WorkflowDefinitionV1; project: WorkflowProjectTargetV1;
    triggerId: string; enabled: boolean; mode?: 'automatic' | 'ask'; initialDeployment?: boolean;
    parent: Readonly<{ actionId: 'workflow.trigger.add' | 'workflow.trigger.update'; input: WorkflowApprovedOperationV1['parent']['input'] }>;
    caller?: Caller;
  }>) => {
    if (input.mode === undefined && input.enabled && !input.initialDeployment) return;
    const retained = input.context.actionApprovals?.filter(row => row.triggerId !== input.triggerId) ?? [];
    if (retained.length) input.context.actionApprovals = retained;
    else delete input.context.actionApprovals;
    if (!input.enabled || input.mode === 'ask') return;
    if (!input.caller) {
      if (input.mode === 'automatic') refuse('approval_required');
      return;
    }
    const steps = await readWorkflowTriggerConsentSteps({
      definition: input.definition, context: input.context, project: input.project,
      triggerId: input.triggerId, resolveWorkflow: resolveDefinition,
    });
    let mode: 'automatic' | 'ask' | undefined = input.mode;
    if (mode === undefined) {
      const step = steps[0];
      // Preserve the predecessor's one-deployment default, not a new aggregate policy.
      if (steps.length !== 1 || step?.actionId !== 'deployments.deploy' || step.binding?.kind !== 'deployment_sha') return;
      // The materializer already admitted this input through the strict SHA-binding schema.
      const authored = step.input as DeploymentDeploySemanticInputV1;
      const initial = await resolveInitialDeploymentApprovalV1({ serverId: authored.serverId,
        environmentId: authored.environmentId, context: input.caller, read: deps.deploymentAction });
      if (!initial.ok) refuse(initial.errorCode, initial.details);
      mode = initial.mode;
    }
    if (mode !== 'automatic') return;
    if (steps.length === 0) refuse('approval_required');
    const { prepareWorkflowApprovedOperation } = await import('./workflowRunActions.js');
    const operation = await prepareWorkflowApprovedOperation({ parent: input.parent, steps, context: input.caller,
      ...(deps.nativeAccount ? { nativeAccount: deps.nativeAccount } : {}) });
    input.context.actionApprovals = [...retained, { triggerId: AutomationTriggerIdSchema.parse(input.triggerId), operation }];
  };
  type PreparedTriggerProjection = Readonly<{
    fields: Pick<WorkflowTriggerSetV1, 'health' | 'target' | 'context' | 'destinations' | 'sourceSavedBy' | 'sourceSavedAt' | 'legacy'>;
    definition?: WorkflowDefinitionV1;
    children?: ReadonlyMap<string, WorkflowDefinitionV1>;
  }>;
  const prepareTriggerProjection = async (value: Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1 }>,
    scopeSessionId: string | null | undefined,
    source: Awaited<ReturnType<typeof resolveTarget>>): Promise<PreparedTriggerProjection> => {
    const definition = source.definition;
    const children = new Map<string, WorkflowDefinitionV1>();
    const destinations = await resolveWorkflowDestinationsV1({ definition, inputs: value.context.inputs,
      originSessionId: scopeSessionId ?? undefined }, async ref => {
        const child = await resolveDefinition(ref);
        children.set(ref, child);
        return child;
      });
    return { definition, children, fields: {
      ...(source.savedBy ? { sourceSavedBy: { kind: source.savedBy.kind, accountId: source.savedBy.accountId } } : {}),
      ...(source.savedAt === undefined ? {} : { sourceSavedAt: source.savedAt }),
      health: 'available', target: value.target, context: value.context, destinations,
    } };
  };
  const projectedDefinition = async (row: AutomationDefinitionDetail, reviewed?: Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1;
    project?: WorkflowProjectTargetV1 }>, prepared?: PreparedTriggerProjection, sourceUnavailable = false): Promise<Readonly<{ set: WorkflowTriggerSetV1; definition?: WorkflowDefinitionV1;
      children?: ReadonlyMap<string, WorkflowDefinitionV1> }>> => {
    const triggers: WorkflowTriggerSetV1['triggers'] = [];
    for (const trigger of row.triggers) {
      const readSubject = trigger.kind !== 'pluginEvent' ? null
        : isDeploymentReceiptEventSourceV1(trigger) ? readDeploymentReceiptEventSubjectV1
        : isHealthCheckEventSourceV1(trigger) ? readHealthCheckEventSubjectV1 : null;
      if (trigger.kind === 'sessionLifecycle') {
        if (!deps.openSessionLifecycleTrigger) refuse('target_unavailable');
        const definition = await deps.openSessionLifecycleTrigger(row, trigger);
        triggers.push({ ...trigger, ...definition });
      } else if (trigger.kind === 'action' && !('consentFor' in trigger)) {
        if (!deps.openActionTrigger) refuse('target_unavailable');
        const definition = await deps.openActionTrigger(row, trigger);
        triggers.push({ id: trigger.id, revision: trigger.revision, enabled: trigger.enabled,
          createdAt: trigger.createdAt, updatedAt: trigger.updatedAt, ...definition });
      } else if (trigger.kind === 'prComment' || trigger.kind === 'ciFailed') {
        if (!deps.openPullRequestTrigger) refuse('target_unavailable');
        const definition = AutomationPullRequestTriggerSchema.parse(await deps.openPullRequestTrigger(row, trigger));
        if (definition.kind !== trigger.kind) refuse('source_unavailable');
        triggers.push({ ...trigger, ...definition });
      } else if (trigger.kind === 'pluginEvent' && readSubject && deps.openPluginEventTrigger) {
        let subject: ReturnType<typeof readHealthCheckEventSubjectV1> = null;
        try {
          subject = readSubject((await deps.openPluginEventTrigger(row, trigger)).sourceConfig);
        } catch (error) {
          const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (code !== 'content_unavailable' && code !== 'source_unavailable') throw error;
        }
        triggers.push({ ...trigger, ...(subject ? { subject } : {}) });
      } else triggers.push(trigger);
    }
    // The storage label every executable set is created with is not a name anyone chose: readers name
    // such a Workflow by what it runs. A 0.2 Automation or a named observation keeps its own name.
    const name = workflowTriggerDisplayNameV1({ name: row.name });
    const now = Date.now();
    const missedSchedules = row.enabled && row.scheduleOccurrences !== undefined ? triggers.flatMap(trigger => {
      if (trigger.kind !== 'schedule' || !trigger.enabled) return [];
      const occurrence = row.scheduleOccurrences!.find(item => item.triggerId === trigger.id && item.triggerRevision === trigger.revision);
      const dueAt = trigger.nextRunAt !== null && trigger.nextRunAt < now
        ? Math.max(trigger.nextRunAt, occurrence?.scheduledFor ?? 0) : occurrence?.scheduledFor;
      if (dueAt === undefined || dueAt >= now) return [];
      if (occurrence?.scheduledFor === dueAt && (occurrence.startedAt !== null || occurrence.held)) return [];
      return [{ triggerId: trigger.id, dueAt, lastRunAt: null }];
    }) : [];
    const base = { automationId: row.id, ...(name === undefined ? {} : { name }), updatedAt: row.updatedAt,
      ...(row.scheduleOccurrences === undefined ? {} : { missedSchedules }),
      revision: row.templateVersion, enabled: row.enabled, triggers, scopeSessionId: row.scopeSessionId ?? null,
      ...(row.templateCiphertext !== undefined && !row.observationOnly ? { legacy: { editable: false as const, reason: 'created_in_0_2' as const } } : {}) };
    if (row.observationOnly) return { set: { ...base, observationOnly: row.observationOnly, health: 'available' } };
    if (prepared) {
      const context = prepared.fields.context;
      return { definition: prepared.definition, children: prepared.children, set: { ...base, ...prepared.fields,
        ...(context ? { ...(row.assignments.length === 1 ? { project: project(row, context) } : {}),
          placements: row.assignments.filter(assignment => assignment.enabled).map(({ machineId }) => ({
          machineId, directory: context.workspace.directory,
        })) } : {}),
      } };
    }
    try {
      if (base.legacy && !reviewed && await deps.requiresLegacyReview?.(row)) {
        return { set: { ...base, health: 'source_unavailable', legacy: { ...base.legacy, lockedReason: 'review_required' } } };
      }
      const value = reviewed ?? await opened(row, true);
      // Source selection already resolved this reference. Still open through the Account codec before disclosure.
      if (sourceUnavailable) refuse('source_unavailable');
      const targetProject = reviewed?.project ?? (row.assignments.length !== 1 ? undefined : project(row, value.context));
      // Retained templates are readable even when their settings cannot become a current Workflow.
      const prepared = await prepareTriggerProjection(value, row.scopeSessionId, await resolveTarget(value.target, !base.legacy));
      return { definition: prepared.definition, children: prepared.children, set: { ...base, ...prepared.fields,
        ...(targetProject ? { project: targetProject } : {}),
        ...(reviewed && base.legacy ? { legacy: { ...base.legacy, lockedReason: 'review_required' as const } } : {}),
        placements: row.assignments.filter((assignment) => assignment.enabled).map(({ machineId }) => ({ machineId, directory: value.context.workspace.directory })),
      } };
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const lockedReason = code === 'session_key_required' || code === 'encryption_material_unavailable' ? 'session_key_required' as const
        : code === 'encryption_mode_mismatch' ? 'migration_required' as const
        : code === 'invalid_template' ? 'decryption_failed' as const : undefined;
      if (base.legacy && lockedReason) return { set: { ...base, health: 'source_unavailable', legacy: { ...base.legacy, lockedReason } } };
      // A retained existing-Session target may have lost its Session. It does not block listing or removal.
      if (code !== 'source_unavailable' && code !== 'invalid_input'
        && !(base.legacy && (code === 'target_unavailable' || code === 'legacy_conversion_unsupported'))) throw error;
      return { set: { ...base, health: 'source_unavailable' } };
    }
  };
  const backupTargets = (value: Awaited<ReturnType<typeof projectedDefinition>>) => {
    const { set, definition, children } = value;
    const environments = new Map<string, { serverId: string; environmentId: string }>();
    const captures: z.infer<typeof WorkflowDeploymentBackupTargetV1Schema>[] = [];
    if (!definition || !set.context) return { environments: [], captures };
    const pending = [{ definition, inputs: resolveWorkflowRunStartInputsV1(definition, set.context.inputs), refs: new Set<string>() }];
    while (pending.length) {
      const frame = pending.pop()!;
      for (const leaf of collectWorkflowLeavesV1(frame.definition)) {
        if (leaf.kind !== 'action' && leaf.kind !== 'workflow') continue;
        const occurrence = leaf.kind === 'action'
          ? readDeploymentBackupOccurrenceV1(frame.definition, leaf) : null;
        if (occurrence) {
          for (const bound of bindWorkflowLeafInputsV1(frame.definition, occurrence.producer, { inputs: frame.inputs,
            origin: { kind: 'direct', ...(set.scopeSessionId ? { originSessionId: set.scopeSessionId } : {}) } }, 'definition')) {
            const selected = DeploymentEnvironmentGetInputV1Schema.safeParse(bound);
            if (selected.success) {
              const environment = { serverId: selected.data.serverId, environmentId: selected.data.environmentId };
              environments.set(JSON.stringify(environment), environment);
            }
          }
        }
        for (const bound of bindWorkflowLeafInputsV1(frame.definition, leaf, { inputs: frame.inputs,
          origin: { kind: 'direct', ...(set.scopeSessionId ? { originSessionId: set.scopeSessionId } : {}) } }, 'definition')) {
          if (leaf.kind === 'action' && leaf.actionId === DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1) {
            const target = WorkflowDeploymentBackupTargetV1Schema.safeParse(Object.fromEntries(
              Object.keys(WorkflowDeploymentBackupTargetV1Schema.shape).map(key => [key, bound[key]])));
            if (target.success) {
              captures.push(target.data);
              const environment = { serverId: target.data.serverId, environmentId: target.data.environmentId };
              environments.set(JSON.stringify(environment), environment);
            }
          } else if (leaf.kind === 'workflow' && !frame.refs.has(leaf.workflowRef)) {
            const child = children?.get(leaf.workflowRef);
            if (child) pending.push({ definition: child, inputs: resolveWorkflowRunStartInputsV1(child, bound),
              refs: new Set([...frame.refs, leaf.workflowRef]) });
          }
        }
      }
    }
    return { environments: [...environments.values()], captures };
  };
  const projection = async (row: AutomationDefinitionDetail, reviewed?: Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1;
    project?: WorkflowProjectTargetV1 }>, prepared?: PreparedTriggerProjection) => (await projectedDefinition(row, reviewed, prepared)).set;
  const eventDefinition = async (row: AutomationDefinitionDetail, triggerId: string) => {
    const trigger = row.triggers.find(item => item.id === triggerId);
    if (!trigger || trigger.kind !== 'pluginEvent' || !deps.openPluginEventTrigger) refuse('source_unavailable');
    return { triggerId: trigger.id, definition: await deps.openPluginEventTrigger(row, trigger) };
  };
  const writeResult = async (row: AutomationDefinitionDetail, triggerId?: ReturnType<typeof AutomationTriggerIdSchema.parse>, includeEventDefinition = false, prepared?: PreparedTriggerProjection): Promise<WorkflowTriggerWriteResult> => {
    const trigger = triggerId ? row.triggers.find((item) => item.id === triggerId) : undefined;
    try {
      return { set: await projection(row, undefined, prepared), ...(triggerId ? { triggerId } : {}), ...(trigger ? { triggerRevision: trigger.revision } : {}),
        ...(includeEventDefinition && triggerId ? { triggerDefinition: await eventDefinition(row, triggerId) } : {}) };
    } catch (cause) {
      // The Automation write already returned. A failed private projection is
      // no evidence that the committed trigger disappeared or was rolled back.
      return unresolvedWriteReceipt(cause);
    }
  };
  const reconcile = async (row: AutomationDefinitionDetail, context: WorkflowTriggerContextV1, target: TriggerTargetV1,
    targetProject: WorkflowProjectTargetV1, changes: Pick<AutomationDefinitionReconcileRequest, 'triggers' | 'removedTriggers'>,
    enabled = row.enabled, preserveAssignments = false, storedContext?: unknown, signal?: AbortSignal) => deps.automations.reconcile(row.id, {
      expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled,
      workflowDefinitionId: target.kind === 'workflow' ? target.ref : null,
      ...(storedContext !== undefined && sameStrictJsonValue(storedContext, context)
        && (row.executionRecipe?.v !== 2 || (row.executionRecipe.visibleTeamId ?? null) === (context.visibleTeamId ?? null)) ? {} : {
        executionRecipe: await deps.sealContext({ automationId: row.id, templateVersion: row.templateVersion + 1, context }),
      }),
      assignments: preserveAssignments
        ? row.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority }))
        : [{ machineId: targetProject.machineId, enabled: row.assignments[0]?.enabled ?? true,
          ...(row.assignments[0]?.priority === undefined ? {} : { priority: row.assignments[0].priority }) }],
      ...changes,
    }, row, undefined, signal);
  const actions = {
    prepareActionMatching: (accountId: string) => createActionAutomationPrivateMatchingV1({ accountId,
      readDefinition: readRetained,
      openTrigger: async (row, trigger) => {
        if (!deps.openActionTrigger) refuse('target_unavailable');
        return deps.openActionTrigger(row, trigger);
      },
    }),
    prepareMutation: async (args: WorkflowActionExecuteArgs<WorkflowTriggerMutationActionId>) => {
      if (args.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID) {
        const input = WorkflowTriggerAddRequestV1Schema.parse(args.input);
        return { workflowTriggerMutationAdmission: { actionId: args.actionId,
          changesProfile: 'subject' in input.trigger && input.trigger.subject?.kind === 'approvalProfile' } };
      }
      const update = args.actionId === WORKFLOW_TRIGGER_UPDATE_ACTION_ID
        ? WorkflowTriggerUpdateRequestV1Schema.parse(args.input) : undefined;
      const input = update ?? WorkflowTriggerRemoveRequestV1Schema.parse(args.input);
      // Move the mutation's authorized row read before routing; dispatch keeps its snapshot and normal CAS.
      const row = args.actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID && input.triggerId === undefined
        ? await readRemovalSet(input.automationId, args.context) : await readRetained(input.automationId, args.context);
      const incumbentProfile = row.triggers.some(trigger => (input.triggerId === undefined || trigger.id === input.triggerId)
        && 'subjectKind' in trigger && trigger.subjectKind === 'approvalProfile');
      const next = update?.patch.trigger;
      const runId = args.context.actionCaller?.kind === 'workflowRun' || args.context.actionCaller?.kind === 'automationRun'
        ? args.context.actionCaller.runId : undefined;
      const firing = args.actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID && input.triggerId !== undefined
        && row.scopeSessionId && runId ? await deps.resolveRunTrigger?.(runId) : undefined;
      args.context.signal?.throwIfAborted();
      const exactFiringCleanup = firing && firing.automationId === row.id && firing.triggerId === input.triggerId
        && firing.sessionId === row.scopeSessionId
        ? { automationId: row.id, triggerId: firing.triggerId, lifetimeSessionId: firing.sessionId } : undefined;
      return { workflowTriggerMutationAdmission: { actionId: args.actionId, row,
        ...(exactFiringCleanup === undefined ? {} : { exactFiringCleanup }), changesProfile: incumbentProfile
        || next !== undefined && 'subject' in next && next.subject?.kind === 'approvalProfile' } };
    },
    readActorConsent: async (input: Parameters<WorkflowTriggerActions['readActorConsent']>[0], caller: Caller): ReturnType<WorkflowTriggerActions['readActorConsent']> => {
      if (!input.saved) return { current: false };
      const row = await read(input.saved.automationId);
      const context = AutomationStoredWorkflowDefinitionV2Schema.parse(await deps.openContext(row));
      const pinned = context.actorConsent;
      const operation = context.actionApprovals?.find(item => item.triggerId === input.saved!.triggerId)?.operation;
      const trigger = row.triggers.find(item => item.id === input.saved!.triggerId);
      if (!row.enabled || !trigger?.enabled || !pinned || !operation
        || operation.approvedBy.accountId !== caller.runtimeAccountId) return { current: false };
      const { agentSteps, ...matching } = pinned;
      if (!sameStrictJsonValue(matching, actorConsentMatching(input))) return { current: false, review: { reason: 'match' } };
      if (input.saved.workflowRevision === input.workflowRevision) {
        return { current: true, automationId: row.id, triggerId: trigger.id,
          triggerRevision: trigger.revision, workflowRevision: input.workflowRevision };
      }
      // R16: exactly one authorized definition read only after revision differs.
      const project = 'project' in input ? input.project : await input.resolveProject();
      const source = await deps.resolveWorkflow(input.workflow);
      const current = await readWorkflowTriggerActorConsentSteps({ definition: source.definition, context,
        project, triggerId: input.saved.triggerId, resolveWorkflow: resolveDefinition,
        materializer: await deps.resolveMaterializer?.(project, caller) });
      const changedActions = current.steps.flatMap((step, index) => sameStrictJsonValue(step, operation.steps[index])
        ? [] : [current.actionStepRefs[index]!]);
      const changedAgents = current.agentSteps.filter((step, index) => !sameStrictJsonValue(step, agentSteps[index]));
      if (current.steps.length !== operation.steps.length || current.agentSteps.length !== agentSteps.length
        || changedActions.length > 0 || changedAgents.length > 0) return { current: false, review: { reason: 'steps',
        changedSteps: [...changedActions, ...changedAgents.map(({ sourceKey, blockId }) => ({ sourceKey, blockId }))] } };
      const { enabled, ...consentTrigger } = input.consentTrigger;
      const saved = await deps.automations.reconcile(row.id, {
        expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled: row.enabled,
        assignments: [], triggers: [{ kind: 'existing', triggerId: trigger.id, expectedRevision: trigger.revision,
          enabled, trigger: consentTrigger }], removedTriggers: [],
      }, row, undefined, caller.signal);
      const revised = saved.triggers.find(item => item.id === trigger.id);
      if (!revised) refuse('content_unavailable');
      return { current: true, automationId: saved.id, triggerId: revised.id,
        triggerRevision: revised.revision, workflowRevision: input.workflowRevision };
    },
    saveActorConsent: async (input: Parameters<WorkflowTriggerActions['saveActorConsent']>[0], caller: Caller): ReturnType<WorkflowTriggerActions['saveActorConsent']> => {
      // Only the decide owner admits Allow. This owner stamps the real deciding
      // person through the incumbent operation producer, never another Account.
      const source = await deps.resolveWorkflow(input.workflow);
      const row = input.saved ? await read(input.saved.automationId) : undefined;
      const automationId = row?.id ?? deps.newId('automation');
      const triggerId = input.saved?.triggerId ?? AutomationTriggerIdSchema.parse(deps.newId('trigger'));
      const context: WorkflowTriggerContextV1 = { workspace: { directory: input.project.directory },
        executionTarget: { kind: 'detached_run' } };
      const projected = await readWorkflowTriggerActorConsentSteps({ definition: source.definition, context,
        project: input.project, triggerId, resolveWorkflow: resolveDefinition,
        materializer: await deps.resolveMaterializer?.(input.project, caller) });
      context.actorConsent = { ...actorConsentMatching(input), agentSteps: projected.agentSteps };
      const { prepareWorkflowApprovedOperation } = await import('./workflowRunActions.js');
      const operation = await prepareWorkflowApprovedOperation({ parent: { actionId: 'approval.request.decide',
        input: Object.fromEntries(Object.entries(input.decisionInput).filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, projectNativeJsonValueForTransport(value)])) },
        steps: projected.steps, materializedLeaves: projected.materializedLeaves,
        context: caller, ...(deps.nativeAccount ? { nativeAccount: deps.nativeAccount } : {}) });
      context.actionApprovals = [{ triggerId: AutomationTriggerIdSchema.parse(triggerId), operation }];
      const executionRecipe = await deps.sealContext({ automationId, templateVersion: (row?.templateVersion ?? 0) + 1, context });
      let saved: AutomationDefinitionDetail;
      if (row) {
        const trigger = row.triggers.find(item => item.id === triggerId);
        if (!trigger) refuse('content_unavailable');
        const { enabled, ...consentTrigger } = input.consentTrigger;
        saved = await deps.automations.reconcile(row.id, { expectedTemplateVersion: row.templateVersion, name: row.name,
          description: row.description, enabled: true, executionRecipe, assignments: [],
          triggers: [{ kind: 'existing', triggerId: trigger.id, expectedRevision: trigger.revision, enabled, trigger: consentTrigger }],
          removedTriggers: [] }, row, undefined, caller.signal);
      } else {
        saved = await deps.automations.create({ automationId, name: WORKFLOW_TRIGGER_SET_STORAGE_NAME, description: null,
          enabled: true, workflowDefinitionId: input.workflow, executionRecipe, assignments: [],
          triggers: [{ triggerId: AutomationTriggerIdSchema.parse(triggerId), trigger: input.consentTrigger }] }, undefined, caller.signal);
      }
      const trigger = saved.triggers.find(item => item.id === triggerId);
      if (!trigger) refuse('content_unavailable');
      return { automationId: saved.id, triggerId: trigger.id,
        triggerRevision: trigger.revision, workflowRevision: input.workflowRevision };
    },
    readSavedConsent: async (input: Parameters<WorkflowTriggerActions['readSavedConsent']>[0], caller: Caller): Promise<WorkflowApprovedOperationV1 | null> => {
      const row = await read(input.automationId);
      if (!row.enabled || row.executionRecipe?.v !== 2 || !row.triggers.some(item => item.id === input.triggerId && item.enabled)) return null;
      const value = await opened(row, false, caller);
      if (input.operation.parent.actionId !== 'workflow.trigger.add' && input.operation.parent.actionId !== 'workflow.trigger.update'
        && !(value.context.actorConsent && input.operation.parent.actionId === 'approval.request.decide')) return null;
      const approval = value.context.actionApprovals?.find(item => item.triggerId === input.triggerId);
      const operation = approval?.operation;
      if (!operation || operation.approvedBy.accountId !== input.ownerAccountId) return null;
      // The predecessor accepted Run carries empty steps even after its selected
      // private consent is rewritten. Preserve only that same original proof;
      // exact authored and concrete effect matching remains with the Run reader.
      const selected = operation.steps[0];
      const incoming = input.operation.steps.length === 0 && operation.steps.length === 1
        && selected?.actionId === 'deployments.deploy' && selected.binding?.kind === 'deployment_sha'
        ? { ...input.operation, steps: operation.steps } : input.operation;
      return sameStrictJsonValue(operation, incoming) ? operation : null;
    },
    runNow: async (raw: WorkflowTriggerRunNowRequestV1, caller?: Caller): Promise<AutomationV3RunMutationResponse> => {
      const input = WorkflowTriggerRunNowRequestV1Schema.parse(raw);
      const runNow = deps.automations.runNow;
      if (!runNow) refuse('target_unavailable');
      if (isWorkflowTriggerAgentCallerV1(caller)) {
        const row = await deps.automations.get(input.automationId);
        if (!row) refuse('content_unavailable');
        const sessionId = row.scopeSessionId ?? undefined;
        const admittedSession = sessionId ? { ...await session(sessionId, caller), sessionId } : undefined;
        // Legacy opening is read-only. Manual admission never upgrades or reconciles a definition.
        const value = await opened(row, false, caller);
        const placements = row.assignments.filter((assignment) => assignment.enabled);
        if (placements.length === 0) refuse('target_unavailable');
        for (const placement of placements) {
          await assertWrite(value.target, value.context, { machineId: placement.machineId, ...value.context.workspace },
            caller, sessionId, false, true, admittedSession);
        }
      }
      caller?.signal?.throwIfAborted();
      const options = input.idempotencyKey === undefined ? undefined : { idempotencyKey: input.idempotencyKey };
      const admitted = await runNow(input.automationId, options, caller);
      try {
        const receipt = AutomationV3RunMutationResponseSchema.parse(admitted);
        if (receipt.run.automationId !== input.automationId) refuse('content_unavailable');
        return receipt;
      } catch (cause) { return unresolvedWriteReceipt(cause); }
    },
    readWorkflowTriggerEvents: async ({ workflow, intendedTriggers }: Parameters<WorkflowTriggerActions['readWorkflowTriggerEvents']>[0]) => {
      const needsStoredRead = intendedTriggers === undefined || intendedTriggers.some(input => input.kind === 'pluginEvent'
        && 'automationId' in input && input.automationId !== undefined && input.triggerId !== undefined);
      const rows = needsStoredRead
        ? (await automationRows(deps.automations.listDetails, { workflowDefinitionId: workflow }))
          .filter(row => (row.scopeSessionId ?? null) === null && row.workflowDefinitionId === workflow)
        : [];
      const storedEvents = rows.flatMap(row => row.triggers.flatMap(trigger => {
        const declaration = trigger.kind === 'action' && 'phase' in trigger
          ? createWorkflowActionTriggerEventDeclarationV1(trigger.phase)
          : trigger.kind === 'pluginEvent' ? { event: trigger.eventRef, payloadSchema: trigger.payloadSchema ?? null } : undefined;
        return declaration ? [{ automationId: row.id, triggerId: trigger.id, ...declaration }] : [];
      }));
      if (intendedTriggers === undefined) return storedEvents.map(({ event, payloadSchema }) => ({ event, payloadSchema }));
      const storedById = new Map(storedEvents.map(event => [JSON.stringify([event.automationId, event.triggerId]), event]));
      return readTriggerEventDeclarations(intendedTriggers.flatMap((input): (WorkflowTriggerEventDeclarationV1 | WorkflowIntendedPluginEventV1)[] => {
        if (input.kind === 'action') return [createWorkflowActionTriggerEventDeclarationV1(input.phase)];
        if (input.kind !== 'pluginEvent') return [];
        if ('observationTransport' in input) return [input];
        const saved = storedById.get(JSON.stringify([input.automationId, input.triggerId]));
        return saved ? [{ event: saved.event, payloadSchema: saved.payloadSchema }] : [];
      }));
    },
    readWorkflowSummaries: async (workflowDefinitionIds: readonly string[]): Promise<ReadonlyMap<string, Readonly<{ triggers: readonly WorkflowTriggerSummaryInputV1[]; nextRunAt: number | null }>>> => {
      const summaries = new Map<string, { triggers: WorkflowTriggerSummaryInputV1[]; nextRunAt: number | null }>();
      const selected = new Set(workflowDefinitionIds);
      if (selected.size === 0) return summaries;
      let cursor: string | undefined;
      do {
        const page = await deps.automations.list({ workflowDefinitionIds: [...selected], ...(cursor ? { cursor } : {}) });
        const owned = summarizeWorkflowTriggerRowsV1(page.automations.filter(row => (row.scopeSessionId ?? null) === null));
        for (const value of [...owned.values(), ...(page.sharedWorkflowSummaries ?? [])]) {
          if (!selected.has(value.workflowDefinitionId)) continue;
          const summary = summaries.get(value.workflowDefinitionId) ?? { triggers: [], nextRunAt: null };
          summary.triggers.push(...value.triggers);
          if (value.nextRunAt !== null) summary.nextRunAt = summary.nextRunAt === null ? value.nextRunAt : Math.min(summary.nextRunAt, value.nextRunAt);
          summaries.set(value.workflowDefinitionId, summary);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return summaries;
    },
    listSubjects: async (raw: WorkflowSubjectsListRequestV1) => {
      const input = WorkflowSubjectsListRequestV1Schema.parse(raw);
      if (input.sources?.length === 0) return { subjects: [], nextCursor: null };
      if (!deps.nativeAccount) refuse('source_unavailable');
      const serverId = deps.nativeAccount.serverId;
      const snapshot = await readSavedHealthCheckSourceSnapshotV1(deps, { sources: input.sources });
      const sources = [...snapshot.values()];
      // Global dedup/priority precedes pagination. The cursor identifies a saved source,
      // never a check row; the inherited definition-list limit counts saved sources.
      const cursorFor = (source: WorkflowTriggerHealthSourceV1) => encodeBase64(new TextEncoder().encode(source.sourceInstanceId), 'base64url');
      const start = input.cursor ? sources.findIndex(source => cursorFor(source) === input.cursor) + 1 : 0;
      if (input.cursor && start === 0) refuse('invalid_input');
      const page = sources.slice(start, start + input.limit);
      return { subjects: page.flatMap(source => source.source.checks.map(check => ({
        subject: { kind: 'healthCheck' as const, serverId, sourceInstanceId: source.sourceInstanceId, checkId: check.checkId },
        source: { automationId: source.automationId, triggerId: source.triggerId },
        label: `${check.kind.localId} (${check.checkId})`,
      }))), nextCursor: start + page.length < sources.length ? cursorFor(page[page.length - 1]!) : null };
    },
    list: async (raw: WorkflowTriggerListRequestV1, caller?: Caller) => {
      const input = WorkflowTriggerListRequestV1Schema.parse(raw);
      if ('subject' in input || 'actionId' in input) {
        const page = await deps.automations.list(input);
        return { sets: [], ...WorkflowAttachedTriggerPageV1Schema.parse({
          attached: page.attached, nextCursor: page.nextCursor, skippedNotSharedCount: page.skippedNotSharedCount,
        }) };
      }
      if ('backupFreshness' in input) {
        const row = await read(input.backupFreshness.automationId);
        if (row.scheduleOccurrences === undefined) refuse('source_unavailable');
        const value = await projectedDefinition(row);
        if (value.set.health !== 'available') refuse('source_unavailable');
        return { sets: [value.set], backupEnvironments: backupTargets(value).environments };
      }
      if ('healthSource' in input) {
        const healthSources = await readSavedHealthCheckSourcesV1(input.healthSource.sourceInstanceIds, deps);
        return { sets: [], healthSources };
      }
      if ('triggerId' in input) {
        const row = await read(input.automationId);
        return { sets: [await projection(row)], triggerDefinition: await eventDefinition(row, input.triggerId) };
      }
      if ('review' in input) {
        if (caller?.authority !== 'present_user' || isWorkflowTriggerAgentCallerV1(caller)
          || (caller.actionCaller !== undefined && caller.actionCaller.kind !== 'host')) refuse('present_user_required');
        const row = await read(input.automationId);
        if (!row.templateCiphertext || !await deps.requiresLegacyReview?.(row) || !deps.convertLegacy) refuseInput('legacy_conversion_review_invalid');
        return { sets: [await projection(row, await deps.convertLegacy(row, caller))] };
      }
      if ('automationId' in input) {
        return { sets: [await projection(await read(input.automationId))] };
      }
      if ('scope' in input && input.scope === 'account_source_unavailable') {
        const summaries = await automationRows(deps.automations.list, { scope: 'account_saved' });
        const sources = await Promise.allSettled([...new Set(summaries.flatMap(row => row.workflowDefinitionId ? [row.workflowDefinitionId] : []))].map(async ref => {
          try {
            await resolveTarget({ kind: 'workflow', ref });
            return null;
          } catch (error) {
            const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (code !== 'source_unavailable' && code !== 'invalid_input') throw error;
            return ref;
          }
        }));
        const missing = sources.flatMap(result => {
          if (result.status === 'rejected') throw result.reason;
          return result.value === null ? [] : [result.value];
        });
        const rows: AutomationDefinitionDetail[] = [];
        // Reuse the list owner's existing selection width while paging every matching definition.
        for (let offset = 0; offset < missing.length; offset += ARTIFACT_LIST_PAGE_MAX_ITEMS_V1) {
          rows.push(...await automationRows(deps.automations.listDetails, {
            scope: 'account_saved', workflowDefinitionIds: missing.slice(offset, offset + ARTIFACT_LIST_PAGE_MAX_ITEMS_V1),
          }));
        }
        const projected = await Promise.allSettled([...new Map(rows.map(row => [row.id, row])).values()]
          .map(row => projectedDefinition(row, undefined, undefined, true)));
        return { sets: projected.flatMap(result => {
          if (result.status === 'rejected') throw result.reason;
          return isWorkflowTriggerSourceGoneV1(result.value.set) ? [result.value.set] : [];
        }) };
      }
      const managedTarget = 'managedTarget' in input ? input.managedTarget : null;
      const deploymentBackup = 'deploymentBackup' in input ? input.deploymentBackup : null;
      const deploymentBackupEnvironment = 'deploymentBackupEnvironment' in input ? input.deploymentBackupEnvironment : null;
      const all = deploymentBackup !== null || deploymentBackupEnvironment !== null || managedTarget !== null
        || ('scope' in input && input.scope === 'account_all');
      const rows = await automationRows(deps.automations.listDetails, managedTarget
        ? { managedTarget, includeUnindexedManagedTargets: true } : all ? {} : 'workflow' in input
          ? { workflowDefinitionId: input.workflow } : { scope: 'account_inline' });
      const selectedRows = all ? rows : rows.filter(row => (row.scopeSessionId ?? null) === null
        && ('workflow' in input ? row.workflowDefinitionId === input.workflow : row.workflowDefinitionId == null));
      // Pages can overlap while the Account changes. Project each Automation once,
      // preserving census order.
      const uniqueRows = [...new Map(selectedRows.map((row) => [row.id, row])).values()];
      const projected = await Promise.allSettled(uniqueRows.map(async (item) => {
        const row = item;
        if (deploymentBackup || deploymentBackupEnvironment) {
          if (deploymentBackupEnvironment && (!row.enabled || !row.triggers.some(trigger => trigger.enabled))) return null;
          const { set, definition, children } = await projectedDefinition(row);
          if (set.health !== 'available') refuse('source_unavailable');
          if (!definition || !set.context) return null;
          const targets = backupTargets({ set, definition, children });
          const matches = deploymentBackupEnvironment
            ? targets.environments.some(value => value.serverId === deploymentBackupEnvironment.serverId
              && value.environmentId === deploymentBackupEnvironment.environmentId)
            : targets.captures.some(value => sameStrictJsonValue(value, deploymentBackup));
          if (matches) {
            if (row.scheduleOccurrences === undefined) refuse('source_unavailable');
            return set;
          }
          return null;
        } else if (managedTarget) {
          const set = await projection(row);
          if (set.health !== 'available') refuse('source_unavailable');
          const managed = set.target && readManagedMachineTriggerAction(set.target);
          const matches = managed && managed.input.homeId === managedTarget.homeId && managed.input.managedId === managedTarget.managedId;
          if (!matches && row.managedTarget?.homeId === managedTarget.homeId && row.managedTarget.managedId === managedTarget.managedId) {
            refuse('source_unavailable');
          }
          return matches ? set : null;
        } else if ('scope' in input && (row.executionRecipe?.v === 2 || row.observationOnly)) {
          // Invalid inline context remains visible as unavailable, rather than disappearing from the Triggers section.
          return await projection(row);
        } else if ('workflow' in input || row.templateCiphertext !== undefined) {
          return await projection(row);
        }
        return null;
      }));
      // Settle all admitted projections before reporting failure.
      const sets = projected.flatMap((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value ? [result.value] : [];
      });
      return { sets };
    },
    add: async (raw: WorkflowTriggerAddRequestV1, caller?: Caller, scope?: AdmittedSessionWrite) => {
      const parsed = WorkflowTriggerAddRequestV1Schema.parse(raw);
      const input = { ...parsed, trigger: AutomationTriggerDefinitionInputSchema.parse(parsed.trigger) };
      if (input.trigger.kind === 'sessionLifecycle' && input.trigger.policy.kind === 'currentTurn'
        && (!('subject' in input.trigger) || input.trigger.subject?.kind !== 'session')) refuseInput('session_trigger_current_turn_requires_session');
      if (input.observationOnly) {
        if (scope || input.trigger.kind !== 'pluginEvent') refuse('invalid_input');
        const automationId = deps.newId('automation');
        const triggerId = AutomationTriggerIdSchema.parse(deps.newId('trigger'));
        const row = await deps.automations.create({ automationId, name: input.name ?? 'Event observation',
          description: null, enabled: true, observationOnly: { ...input.observationOnly, templateVersion: 1 },
          assignments: [], triggers: [{ triggerId, trigger: input.trigger }] }, undefined, caller?.signal);
        return writeResult(row, row.triggers[0]?.id ?? triggerId, input.includeEventDefinition === true);
      }
      if (!input.project) refuse('invalid_input');
      const targetProject = scope ? input.project : resolveWorkflowProjectTargetMachineV1(input.project);
      if ((input.trigger.kind === 'prComment' || input.trigger.kind === 'ciFailed') && !scope) refuseInput('session_trigger_scope_required');
      const target = input.target ?? { kind: 'workflow' as const, ref: input.workflow! };
      let sourceTerminal = false;
      if (input.trigger.kind === 'runLifecycle') {
        if (input.trigger.source.kind === 'execution_run' && input.trigger.condition !== 'terminal') refuse('unsupported_condition');
        if (!deps.resolveRunSource) refuse('target_unavailable');
        sourceTerminal = (await deps.resolveRunSource(input.trigger.source, caller)).terminal;
      }
      const { machineId, ...workspace } = targetProject;
      const context = triggerContext({ ...input, ...(scope?.onComplete === undefined ? {} : { onComplete: scope.onComplete }) }, target, targetProject, caller);
      const triggerId = AutomationTriggerIdSchema.parse(deps.newId('trigger'));
      const existing = target.kind === 'workflow' ? (await scopedRows(deps.automations, scope?.sessionId,
        { workflowDefinitionId: target.ref })).find((row) => row.workflowDefinitionId === target.ref) : undefined;
      if (existing) {
        const row = await read(existing.id, scope?.sessionId);
        const current = await opened(row, false, caller);
        const mergedContext = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...current.context, workspace,
          ...(input.executionTarget === undefined ? {} : { executionTarget: input.executionTarget }),
          ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
          ...(input.visibleTeamId === undefined ? {} : { visibleTeamId: input.visibleTeamId }),
          ...(input.approvalProfileId === undefined ? {} : { approvalProfileId: input.approvalProfileId }),
          ...(input.roleOverrides === undefined ? {} : { roleOverrides: input.roleOverrides }) });
        const { deploymentTriggers: _oldRows, ...oldOperands } = current.context;
        const { deploymentTriggers: _nextRows, ...nextOperands } = mergedContext;
        if (!sameStrictJsonValue(oldOperands, nextOperands)) withoutTriggerApprovals(mergedContext);
        if (input.deployment !== undefined) mergedContext.deploymentTriggers = [
          ...(mergedContext.deploymentTriggers ?? []), { triggerId, ...input.deployment },
        ];
        if (scope?.onComplete !== undefined) mergedContext.onComplete = scope.onComplete;
        const admittedSource = await assertWrite(target, mergedContext, targetProject, caller, scope?.sessionId, false, false, scope,
          undefined, [{ triggerId, trigger: input.trigger }]);
        await prepareActionConsent({ context: mergedContext, definition: admittedSource.definition, project: targetProject, triggerId,
          enabled: input.trigger.enabled, mode: input.actionApproval,
          initialDeployment: input.trigger.kind === 'pluginEvent' && input.deployment !== undefined,
          parent: { actionId: 'workflow.trigger.add', input: approvalInput(input) }, caller });
        const prepared = await prepareTriggerProjection({ target, context: mergedContext }, scope?.sessionId, admittedSource);
        const committed = await reconcile(row, mergedContext, target, targetProject, {
          triggers: [...retainedTriggers(row), { kind: 'new', triggerId, trigger: input.trigger }], removedTriggers: [],
        }, row.enabled, false, current.storedContext, caller?.signal);
        return writeResult(committed, triggerId, false, prepared);
      }
      if (input.deployment !== undefined) context.deploymentTriggers = [{ triggerId, ...input.deployment }];
      const triggerEvents = await readInlineTriggerEvents(target, [input.trigger]);
      const admittedSource = await assertWrite(target, context, targetProject, caller, scope?.sessionId, false, false, scope,
        triggerEvents, [{ triggerId, trigger: input.trigger }]);
      // A one-shot notification is an intent to observe this source once. A
      // repeated registration rejoins the Automation owner instead of creating
      // another notification. Repeating/ordinary authored triggers retain add
      // semantics, and removal allows a fresh registration. Terminal replay
      // also rejoins a consumed intent while the source remains terminal, so a lost
      // acknowledgement cannot duplicate it. A resumed source can be armed again.
      // Attention may recur, so exhausted attention observations remain rearmable.
      const onlyBlock = target.kind === 'inline' && target.definition.blocks.length === 1
        ? target.definition.blocks[0] : null;
      if (!scope && input.trigger.kind === 'runLifecycle' && input.trigger.enabled
        && onlyBlock?.kind === 'action' && onlyBlock.actionId === 'notifications.notify_me') {
        const source = input.trigger;
        for (const summary of await scopedRows(deps.automations)) {
          if (!summary.enabled || summary.workflowDefinitionId != null) continue;
          const candidate = await read(summary.id);
          if (!candidate.enabled || candidate.executionRecipe?.v !== 2 || candidate.workflowDefinitionId != null) continue;
          const current = await opened(candidate, false, caller);
          if (createCanonicalJsonSigningInput(current.context) !== createCanonicalJsonSigningInput(context)
            || createCanonicalJsonSigningInput(project(candidate, current.context)) !== createCanonicalJsonSigningInput(targetProject)) continue;
          const registered = candidate.triggers.find((item) => item.kind === 'runLifecycle' && item.enabled
            && ((item.remainingOccurrences === 1 && item.status.state === 'waiting')
              || (source.condition === 'terminal' && sourceTerminal && item.remainingOccurrences === 0 && item.status.state === 'finished'))
            && item.condition === source.condition
            && createCanonicalJsonSigningInput(item.source) === createCanonicalJsonSigningInput(source.source));
          if (registered) {
            const prepared = await prepareTriggerProjection({ target, context }, undefined, admittedSource);
            return writeResult(candidate, registered.id, false, prepared);
          }
        }
      }
      if (scope && input.trigger.kind === 'sessionLifecycle' && input.trigger.enabled
        && (input.trigger.policy.kind === 'currentTurn' || input.trigger.policy.kind === 'firstMatch')
        && onlyBlock?.kind === 'action' && onlyBlock.actionId === 'notifications.notify_me') {
        const source = input.trigger;
        const intended = createCanonicalJsonSigningInput(context);
        const intendedLifecycle = createCanonicalJsonSigningInput(projectAutomationSessionLifecycleStructuralConfiguration(source));
        for (const summary of await scopedRows(deps.automations, scope.sessionId)) {
          if (!summary.enabled || summary.workflowDefinitionId != null) continue;
          const candidate = await read(summary.id, scope.sessionId);
          if (!candidate.enabled || candidate.executionRecipe?.v !== 2 || candidate.workflowDefinitionId != null) continue;
          const current = await opened(candidate, false, caller);
          if (createCanonicalJsonSigningInput(current.context) !== intended) continue;
          const registered = candidate.triggers.find((item) => item.kind === 'sessionLifecycle' && item.enabled
            && item.remainingOccurrences !== 0 && item.status.state === 'waiting'
            && createCanonicalJsonSigningInput(canonicalizeAutomationSessionLifecycleStructuralConfiguration(item)) === intendedLifecycle);
          if (registered) {
            // Session placement is authorized by resolveSession, not by a stale
            // assignment retained with the notification. Move the same intent
            // through reconciliation; never create a second firing trigger.
            const prepared = await prepareTriggerProjection({ target, context }, scope?.sessionId, admittedSource);
            const committed = candidate.assignments.length === 1 && candidate.assignments[0]?.machineId === machineId
              ? candidate
              : await reconcile(candidate, context, target, targetProject,
                { triggers: retainedTriggers(candidate), removedTriggers: [] }, candidate.enabled, false, current.storedContext, caller?.signal);
            return writeResult(committed, registered.id, false, prepared);
          }
        }
      }
      const automationId = deps.newId('automation');
      await prepareActionConsent({ context, definition: admittedSource.definition, project: targetProject, triggerId, enabled: input.trigger.enabled,
        mode: input.actionApproval, initialDeployment: input.trigger.kind === 'pluginEvent' && input.deployment !== undefined,
        parent: { actionId: 'workflow.trigger.add', input: approvalInput(input) }, caller });
      const prepared = await prepareTriggerProjection({ target, context }, scope?.sessionId, admittedSource);
      const executionRecipe = await deps.sealContext({ automationId, templateVersion: 1, context });
      const row = await deps.automations.create({ automationId, name: WORKFLOW_TRIGGER_SET_STORAGE_NAME, description: null, enabled: true,
        workflowDefinitionId: target.kind === 'workflow' ? target.ref : null, scopeSessionId: scope?.sessionId ?? null,
        executionRecipe,
        assignments: [{ machineId, enabled: true }], triggers: [{ triggerId, trigger: input.trigger }] }, undefined, caller?.signal);
      return writeResult(row, triggerId, false, prepared);
    },
    update: async (raw: WorkflowTriggerUpdateRequestV1, caller?: Caller, scope?: AdmittedSessionWrite) => {
      const input = WorkflowTriggerUpdateRequestV1Schema.parse(raw);
      if ((input.patch.trigger?.kind === 'prComment' || input.patch.trigger?.kind === 'ciFailed') && !scope) refuseInput('session_trigger_scope_required');
      const row = await read(input.automationId, scope?.sessionId, caller);
      if (row.templateVersion !== input.expectedRevision) refuse('currentness_conflict', { revision: row.templateVersion });
      if (input.triggerId && !row.triggers.some((item) => item.id === input.triggerId)) refuse('content_unavailable');
      if (row.observationOnly) {
        if (scope || Object.keys(input.patch).some(key => key !== 'enabled' && key !== 'trigger')
          || (input.patch.trigger !== undefined && input.patch.trigger.kind !== 'pluginEvent')) refuse('invalid_input');
        const enablingDisabledSet = input.triggerId !== undefined && input.patch.enabled === true && !row.enabled;
        const triggers = retainedTriggers(row).map((item, index) => item.triggerId === input.triggerId
          ? { ...item, ...(input.patch.enabled === undefined ? {} : { enabled: input.patch.enabled }),
              ...(input.patch.trigger === undefined ? {} : { trigger: input.patch.trigger }) }
          : enablingDisabledSet && row.triggers[index]?.enabled ? { ...item, enabled: false } : item);
        return writeResult(await deps.automations.reconcile(row.id, { expectedTemplateVersion: row.templateVersion,
          name: row.name, description: row.description,
          enabled: enablingDisabledSet ? true : input.triggerId === undefined ? input.patch.enabled ?? row.enabled : row.enabled,
          assignments: [], triggers, removedTriggers: [] }, row, undefined, caller?.signal), input.triggerId);
      }
      let current: Awaited<ReturnType<typeof opened>>;
      let reviewedProject: WorkflowProjectTargetV1 | undefined;
      if (input.confirmLegacyConversion) {
        const directUser = caller?.authority === 'present_user' && !isWorkflowTriggerAgentCallerV1(caller)
          && (caller.actionCaller === undefined || caller.actionCaller.kind === 'host')
          && caller.bypassApprovals !== true && caller.presentUserApproval === undefined;
        const proof = caller?.presentUserApproval;
        const approvedRequest = caller?.authority === 'present_user' && caller.bypassApprovals === true
          && proof?.actionId === 'workflow.trigger.update' && proof.requestId === caller.actionRequestId
          && proof.inputDigest === computeActionInputApprovalDigestV1('workflow.trigger.update', input);
        if (!directUser && !approvedRequest) refuse('present_user_required');
        if (!row.templateCiphertext || !await deps.requiresLegacyReview?.(row)
          || input.patch.target?.kind !== 'inline' || !input.patch.project) refuseInput('legacy_conversion_review_invalid');
        const sessionId = readAutomationTemplateStoredEnvelopeV1(row.templateCiphertext)?.legacyExistingSessionId;
        if (!sessionId || !deps.resolveSession) refuse('source_unavailable');
        reviewedProject = (await deps.resolveSession(sessionId, caller)).project;
        current = { target: input.patch.target, context: triggerContext(input.patch, input.patch.target, input.patch.project) };
      } else current = await opened(row, false, caller);
      const { target: nextTarget, project: nextProject, enabled, trigger, deployment, actionApproval, ...contextPatch } = input.patch;
      if (trigger?.kind === 'runLifecycle') {
        if (trigger.source.kind === 'execution_run' && trigger.condition !== 'terminal') refuse('unsupported_condition');
        if (!deps.resolveRunSource) refuse('source_unavailable');
        await deps.resolveRunSource(trigger.source, caller);
      }
      // A per-trigger switch enables that trigger, not enabled siblings hidden
      // behind a disabled set. Conversion does not change the person's enabled state.
      const enablingDisabledSet = input.triggerId !== undefined && enabled === true && !row.enabled;
      const disabledSiblings = new Set<string>();
      const triggers = retainedTriggers(row).map((item, index) => {
        if (item.triggerId === input.triggerId) return { ...item,
          ...(enabled === undefined ? {} : { enabled }), ...(trigger === undefined ? {} : { trigger }) };
        if (enablingDisabledSet && row.triggers[index]?.enabled) {
          disabledSiblings.add(item.triggerId);
          return { ...item, enabled: false };
        }
        return item;
      });
      const setEnabled = enablingDisabledSet ? true
        : input.triggerId === undefined && enabled !== undefined ? enabled : row.enabled;
      const triggerWrites: TriggerWrite[] = [];
      for (const item of triggers) {
        if (item.trigger) {
          triggerWrites.push({ triggerId: item.triggerId, trigger: item.trigger });
          continue;
        }
        if (input.triggerId !== undefined && item.triggerId !== input.triggerId && item.enabled === undefined) continue;
        const stored = row.triggers.find(candidate => candidate.id === item.triggerId);
        if (stored?.kind !== 'action' || 'consentFor' in stored) continue;
        if (!deps.openActionTrigger) refuse('target_unavailable');
        triggerWrites.push({ triggerId: item.triggerId, trigger: await deps.openActionTrigger(row, stored) });
      }
      const target = nextTarget ?? current.target;
      const triggerEvents = await readInlineTriggerEvents(target, row.triggers.map(item =>
        item.id === input.triggerId && trigger !== undefined ? trigger : item));
      if (row.executionRecipe?.v === 2 && caller?.authority === 'present_user'
        && caller.actionCaller?.kind === 'host' && !isWorkflowTriggerAgentCallerV1(caller)
        && scope?.onComplete === undefined
        && !current.context.actionApprovals?.some(approval => input.triggerId === undefined
          || approval.triggerId === input.triggerId || disabledSiblings.has(approval.triggerId))
        && Object.keys(input.patch).every((key) => key === 'enabled' || key === 'trigger')) {
        const admittedSource = await assertTargetAccess(current.target, { ...current.context }, triggerEvents, triggerWrites);
        const prepared = await prepareTriggerProjection(current, row.scopeSessionId, admittedSource);
        // The Automation owner advances the outer revision while retaining
        // the private recipe and complete placement census verbatim.
        return writeResult(await deps.automations.reconcile(row.id, {
          expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled: setEnabled,
          assignments: row.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority })),
          triggers, removedTriggers: [],
        }, row, undefined, caller?.signal), input.triggerId, false, prepared);
      }
      if (!scope && current.target.kind === 'workflow' && nextTarget && (nextTarget.kind !== 'workflow' || nextTarget.ref !== current.target.ref)) refuseInput('workflow_trigger_target_mismatch');
      if (nextProject && reviewedProject === undefined) {
        // Placement belongs to the stored assignment/context, independently of
        // the old conversation's availability or current Session location.
        if (row.assignments.length === 1) reviewedProject = project(row, current.context);
        else {
          // Converted predecessor rows can retain a plural placement census.
          // Their frozen Session address identifies an unchanged reviewed project.
          const conversation = current.target.kind === 'inline' ? current.target.definition.defaults.conversation : undefined;
          if (conversation?.kind === 'existing_session') reviewedProject = {
            machineId: conversation.machineId, ...current.context.workspace,
          };
        }
      }
      const selectedProject = nextProject ?? project(row, current.context);
      const targetProject = scope ? selectedProject : resolveWorkflowProjectTargetMachineV1(selectedProject);
      const { machineId: _machineId, ...workspace } = targetProject;
      const { inlineDefinition: _inlineDefinition, ...previous } = current.context;
      const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...previous, ...contextPatch, workspace,
        ...(scope?.onComplete === undefined ? {} : { onComplete: scope.onComplete }),
        ...(target.kind === 'inline' ? { inlineDefinition: target.definition } : {}) });
      if (Object.keys(contextPatch).length || nextTarget || nextProject || deployment !== undefined) withoutTriggerApprovals(context);
      const previousTrigger = row.triggers.find(item => item.id === input.triggerId);
      if (trigger !== undefined && (trigger.kind === 'schedule' || previousTrigger?.kind === 'schedule')
        && !(trigger.kind === 'schedule' && previousTrigger?.kind === 'schedule'
          && sameStrictJsonValue(trigger.schedule, previousTrigger.schedule)) && context.actionApprovals) {
        context.actionApprovals = context.actionApprovals.filter(approval => approval.triggerId !== input.triggerId
          || !approval.operation.steps.some(step => step.actionId === DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1));
        if (context.actionApprovals.length === 0) delete context.actionApprovals;
      }
      if (disabledSiblings.size && context.actionApprovals) {
        context.actionApprovals = context.actionApprovals.filter(row => !disabledSiblings.has(row.triggerId));
        if (context.actionApprovals.length === 0) delete context.actionApprovals;
      }
      if (deployment !== undefined && input.triggerId !== undefined) context.deploymentTriggers = [
        ...(context.deploymentTriggers ?? []).filter(row => row.triggerId !== input.triggerId),
        ...(deployment === null ? [] : [{ triggerId: input.triggerId, ...deployment }]),
      ];
      if (target.kind === 'inline' && context.visibleTeamId !== undefined) refuseInput('inline_trigger_team_not_allowed');
      const admittedSource = await assertWrite(target, context, targetProject, caller, scope?.sessionId, false, false, scope, triggerEvents, triggerWrites);
      if (input.triggerId !== undefined) await prepareActionConsent({ context, definition: admittedSource.definition, project: targetProject,
        triggerId: input.triggerId, enabled: setEnabled && (enabled ?? row.triggers.find(item => item.id === input.triggerId)?.enabled ?? false),
        initialDeployment: deployment != null && !current.context.deploymentTriggers?.some(item => item.triggerId === input.triggerId)
          && (trigger?.kind ?? row.triggers.find(item => item.id === input.triggerId)?.kind) === 'pluginEvent',
        mode: actionApproval, parent: { actionId: 'workflow.trigger.update', input: approvalInput(input) }, caller });
      else if (!setEnabled) delete context.actionApprovals;
      const prepared = await prepareTriggerProjection({ target, context }, row.scopeSessionId, admittedSource);
      return writeResult(await reconcile(row, context, target, targetProject, { triggers, removedTriggers: [] },
        setEnabled, nextProject === undefined || (reviewedProject !== undefined
          && createCanonicalJsonSigningInput(reviewedProject) === createCanonicalJsonSigningInput(targetProject)), current.storedContext, caller?.signal), input.triggerId, false, prepared);
    },
    remove: async (raw: WorkflowTriggerRemoveRequestV1 & { triggerId: string }, sessionId?: string, caller?: Caller) => {
      const input = WorkflowTriggerRemoveRequestV1Schema.parse(raw);
      const row = await read(input.automationId, sessionId, caller);
      const trigger = row.triggers.find((item) => item.id === input.triggerId);
      if (!trigger) return writeResult(row, input.triggerId);
      // A missing source still projects as unavailable and never prevents removal.
      // Finish optional source reads before the effect, so its accepted receipt needs no reread.
      const projected = await projectedDefinition(row);
      const prepared: PreparedTriggerProjection = { fields: {
        health: projected.set.health,
        ...(projected.set.target === undefined ? {} : { target: projected.set.target }),
        ...(projected.set.context === undefined ? {} : { context: projected.set.context }),
        ...(projected.set.destinations === undefined ? {} : { destinations: projected.set.destinations }),
        ...(projected.set.sourceSavedBy === undefined ? {} : { sourceSavedBy: projected.set.sourceSavedBy }),
        ...(projected.set.sourceSavedAt === undefined ? {} : { sourceSavedAt: projected.set.sourceSavedAt }),
        ...(projected.set.legacy === undefined ? {} : { legacy: projected.set.legacy }),
      }, definition: projected.definition, children: projected.children };
      const committed = await deps.automations.reconcile(row.id, {
        expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled: row.enabled,
        assignments: row.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority })),
        triggers: retainedTriggers(row).filter((item) => item.triggerId !== input.triggerId),
        removedTriggers: [{ triggerId: trigger.id, expectedRevision: trigger.revision }],
      }, row, undefined, caller?.signal);
      return writeResult(committed, input.triggerId, false, prepared);
    },
    removeForWorkflow: (workflow: string, signal?: AbortSignal) => removeWorkflowTriggersForDefinition(deps.automations, workflow, signal),
  };
  const findScoped = async (sessionId: string, triggerId: string) => {
    const row = (await scopedRows(deps.automations, sessionId)).find((row) => row.triggers.some((trigger) => trigger.id === triggerId));
    if (!row) refuse('content_unavailable');
    return read(row.id, sessionId);
  };
  const assertScopedTrigger = (trigger: SessionTriggerDefinitionV1 | SessionInitialTriggerDefinitionV1, sessionId?: string) => {
    // Session PR/CI sources require the Channel binding and its permission
    // evidence. The generic Event writer cannot establish either authority.
    if (trigger.kind === 'pluginEvent') refuse('target_unavailable');
    if (trigger.kind === 'runLifecycle') refuseInput('session_trigger_kind_unsupported');
    if (trigger.kind === 'sessionLifecycle') {
      if (trigger.policy.kind === 'currentTurn' && (!('subject' in trigger) || trigger.subject?.kind !== 'session')) refuseInput('session_trigger_current_turn_requires_session');
    }
  };
  const resolveScopedTrigger = async <T extends SessionTriggerDefinitionV1>(trigger: T, sessionId: string, caller?: Caller) => {
    if (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed') return trigger;
    if ('triggerDefinitionEnvelope' in trigger) refuseInput('trigger_definition_envelope_not_allowed');
    if (!deps.pullRequests) refuse('target_unavailable');
    const links = trigger.pullRequest === undefined ? await deps.pullRequests.listLinks(sessionId, caller) : [];
    const pullRequest = trigger.pullRequest ?? (links.length === 1
      ? { repository: links[0]!.repository, number: links[0]!.number } : undefined);
    if (!pullRequest) refuse('pull_request_link_required');
    return { ...trigger, pullRequest };
  };
  const attachPullRequest = async (sessionId: string, result: Awaited<ReturnType<typeof writeResult>>, caller?: Caller) => {
    const trigger = result.set.triggers.find((item) => item.id === result.triggerId);
    if (!trigger || (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed')) return;
    if (!deps.pullRequests || !('pullRequest' in trigger)) refuse('target_unavailable');
    await deps.pullRequests.attach({ sessionId, automationId: result.set.automationId,
      triggerId: trigger.id, triggerRevision: trigger.revision, triggerKind: trigger.kind, pullRequest: trigger.pullRequest }, caller);
  };
  const assertContinuationOwner = async (target: TriggerTargetV1, sessionId: string, caller?: Caller) => {
    if (!isKeepGoingTriggerTargetV1(target)) return;
    if (!deps.resolveSession) refuse('target_unavailable');
    const { nativeGoalOwner } = await deps.resolveSession(sessionId, caller, { checkNativeGoalOwner: true });
    if (nativeGoalOwner === true) refuse('native_goal_owner');
    if (nativeGoalOwner === null) refuse('target_unavailable');
  };
  const sessionActions: WorkflowTriggerActions = { ...actions,
    removeSessionKeepGoingTriggers: async (raw, caller) => {
      const listed = await sessionActions.sessionList(raw, caller);
      for (const set of listed.sets) {
        if (!isKeepGoingTriggerTargetV1(set.target)) continue;
        for (const trigger of set.triggers) {
          await sessionActions.sessionRemove({ sessionId: listed.sessionId, triggerId: trigger.id }, caller);
        }
      }
    },
    prepareSessionInitialTriggers: async (input: Readonly<{ initialTriggers: readonly SessionInitialTriggerV1[];
      project: WorkflowProjectTargetV1; preparedFinalSessionId: string; caller?: Caller }>): Promise<SessionInitialTriggerAdmissionV1[]> => {
      const prepared: SessionInitialTriggerAdmissionV1[] = [];
      for (const raw of input.initialTriggers) {
        input.caller?.signal?.throwIfAborted();
        const draft = SessionInitialTriggerV1Schema.parse(raw);
        assertScopedTrigger(draft.trigger);
        // PR/CI registration requires a born Session's Channel binding; nothing
        // may be committed if this prerequisite cannot be admitted at birth.
        const authoredTrigger = draft.trigger;
        switch (authoredTrigger.kind) {
          case 'prComment':
          case 'ciFailed':
            refuse('target_unavailable');
        }
        const context = triggerContext(draft, draft.target, input.project, input.caller);
        await assertWrite(draft.target, context, input.project, input.caller, undefined, true);
        const automationId = deps.newId('automation');
        const triggerId = AutomationTriggerIdSchema.parse(deps.newId('trigger'));
        const trigger = authoredTrigger.kind === 'sessionLifecycle'
          ? { ...authoredTrigger, subject: { kind: 'session' as const,
              serverId: input.caller?.serverIdentityId ?? refuse('target_unavailable'),
              sessionId: input.preparedFinalSessionId } }
          : authoredTrigger;
        if (trigger.kind === 'sessionLifecycle' && !deps.prepareBirthTrigger) refuse('target_unavailable');
        const admittedTrigger = deps.prepareBirthTrigger
          ? await deps.prepareBirthTrigger(automationId, triggerId, trigger) : trigger;
        prepared.push(SessionInitialTriggerAdmissionV1Schema.parse({ automationId, name: WORKFLOW_TRIGGER_SET_STORAGE_NAME, description: null,
          enabled: true, workflowDefinitionId: draft.target.kind === 'workflow' ? draft.target.ref : null,
          executionRecipe: await deps.sealContext({ automationId, templateVersion: 1, context }),
          assignments: [{ machineId: input.project.machineId, enabled: true }],
          triggers: [{ triggerId, trigger: admittedTrigger }],
        }));
      }
      return prepared;
    },
    list: async (raw: WorkflowTriggerListRequestV1, caller?: Caller) => {
      const input = WorkflowTriggerListRequestV1Schema.parse(raw);
      if (!('lifetimeSession' in input)) return actions.list(input, caller);
      const { sessionId, ...listed } = await sessionActions.sessionList({ sessionId: input.lifetimeSession.sessionId }, caller);
      return { ...listed, lifetimeSession: { sessionId } };
    },
    add: async (raw: WorkflowTriggerAddRequestV1, caller?: Caller) => {
      const input = WorkflowTriggerAddRequestV1Schema.parse(raw);
      if (!('lifetimeSession' in input) || input.lifetimeSession === undefined) return actions.add(input, caller);
      const { lifetimeSession, workflow, target, ...fields } = input;
      return sessionActions.sessionAdd({ ...fields,
        target: target ?? { kind: 'workflow', ref: workflow! },
        sessionId: lifetimeSession.sessionId,
        ...(lifetimeSession.onComplete === undefined ? {} : { onComplete: lifetimeSession.onComplete }) }, caller);
    },
    update: async (raw: WorkflowTriggerUpdateRequestV1, caller?: Caller) => {
      const input = WorkflowTriggerUpdateRequestV1Schema.parse(raw);
      const row = await readRetained(input.automationId, caller);
      if (!row.scopeSessionId) return actions.update(input, caller);
      if (row.triggers.some(trigger => trigger.kind === 'pluginEvent')) refuse('target_unavailable');
      const authorized = await session(row.scopeSessionId, caller);
      const current = await opened(row, false, caller);
      const managed = readManagedMachineTriggerAction(input.patch.target ?? current.target);
      if (input.patch.project && !managed
        && createCanonicalJsonSigningInput(input.patch.project) !== createCanonicalJsonSigningInput(authorized.project)) refuseInput('session_trigger_project_mismatch');
      await assertContinuationOwner(input.patch.target ?? current.target, row.scopeSessionId, caller);
      if (input.patch.trigger) assertScopedTrigger(input.patch.trigger, row.scopeSessionId);
      const trigger = input.patch.trigger === undefined ? undefined
        : await resolveScopedTrigger(input.patch.trigger, row.scopeSessionId, caller);
      const result = await actions.update({ ...input, patch: { ...input.patch,
        ...(trigger === undefined ? {} : { trigger }), project: managed
          ? input.patch.project ?? project(row, current.context) : authorized.project } }, caller,
        { sessionId: row.scopeSessionId, onComplete: input.patch.onComplete, project: authorized.project, authority: authorized.authority });
      try {
        await attachPullRequest(row.scopeSessionId, result, caller);
        if (input.patch.trigger && input.patch.trigger.kind !== 'prComment' && input.patch.trigger.kind !== 'ciFailed'
          && row.triggers.some(item => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed'))
          && input.triggerId !== undefined) await deps.pullRequests?.removeTrigger({ sessionId: row.scopeSessionId, triggerId: input.triggerId }, caller);
      } catch (cause) { return unresolvedWriteReceipt(cause); }
      return result;
    },
    remove: async (raw: WorkflowTriggerRemoveRequestV1, caller?: Caller) => {
      const input = WorkflowTriggerRemoveRequestV1Schema.parse(raw);
      if (input.triggerId !== undefined) {
        const row = await readRetained(input.automationId, caller);
        if (row.scopeSessionId) await assertSessionAdmission(row.scopeSessionId, caller, input.triggerId);
        const result = await actions.remove({ ...input, triggerId: input.triggerId }, row.scopeSessionId ?? undefined, caller);
        try {
          if (row.scopeSessionId && row.triggers.some(item => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed')))
            await deps.pullRequests?.removeTrigger({ sessionId: row.scopeSessionId, triggerId: input.triggerId }, caller);
        } catch (cause) { return unresolvedWriteReceipt(cause); }
        return result;
      }
      const admission = caller?.workflowTriggerMutationAdmission;
      const row = admission?.actionId === WORKFLOW_TRIGGER_REMOVE_ACTION_ID && admission.row.id === input.automationId
        ? admission.row : await readRemovalSet(input.automationId, caller);
      const deleted = await deps.automations.delete(row.id, row, caller?.signal);
      return { automationId: row.id, deleted: true as const,
        ...(deleted.removedRevision === undefined ? {} : { removedRevision: deleted.removedRevision }) };
    },
    sessionList: async (raw: SessionTriggerListRequestV1, caller?: Caller) => {
      const input = SessionTriggerListRequestV1Schema.parse(raw);
      // Listing Account-owned trigger sets consumes no execution placement.
      // Session caller admission belongs here, once for this Action.
      await assertSessionAdmission(input.sessionId, caller);
      const sets: WorkflowTriggerSetV1[] = [];
      for (const row of await automationRows(deps.automations.listDetails, { scopeSessionId: input.sessionId })) {
        if (row.scopeSessionId === input.sessionId) sets.push(await projection(row));
      }
      const unavailable = { status: 'unavailable', code: 'target_unavailable' } as const;
      let pullRequestLinks: SessionTriggerPullRequestLinksV1 = unavailable;
      if (deps.pullRequests) {
        try {
          pullRequestLinks = await deps.pullRequests.listLinks(input.sessionId, caller);
        } catch (error) {
          caller?.signal?.throwIfAborted();
          const details = error && typeof error === 'object' ? Reflect.get(error, 'details') : undefined;
          const diagnostic = ActionRefusalDiagnosticV1Schema.safeParse(details && typeof details === 'object'
            ? Reflect.get(details, 'diagnostic') : undefined);
          if (diagnostic.success) pullRequestLinks = { ...unavailable, diagnostic: diagnostic.data };
        }
      }
      caller?.signal?.throwIfAborted();
      return { sessionId: input.sessionId, sets, pullRequestLinks };
    },
    sessionAdd: async (raw: SessionTriggerAddRequestV1, caller?: Caller) => {
      const { sessionId, onComplete, project: selectedProject, ...input } = SessionTriggerAddRequestV1Schema.parse(raw);
      const authorized = await session(sessionId, caller);
      if (selectedProject && !readManagedMachineTriggerAction(input.target)
        && createCanonicalJsonSigningInput(selectedProject) !== createCanonicalJsonSigningInput(authorized.project)) {
        refuseInput('session_trigger_project_mismatch');
      }
      await assertContinuationOwner(input.target, sessionId, caller);
      assertScopedTrigger(input.trigger, sessionId);
      const trigger = await resolveScopedTrigger(input.trigger, sessionId, caller);
      const result = await actions.add(WorkflowTriggerAddRequestV1Schema.parse({ ...input, trigger, project: selectedProject ?? authorized.project }), caller,
        { sessionId, onComplete, project: authorized.project, authority: authorized.authority });
      try {
        await attachPullRequest(sessionId, result, caller);
      } catch (cause) { return unresolvedWriteReceipt(cause); }
      return result;
    },
    sessionUpdate: async (raw: SessionTriggerUpdateRequestV1, caller?: Caller) => {
      const input = SessionTriggerUpdateRequestV1Schema.parse(raw);
      const authorized = await session(input.sessionId, caller);
      const row = await findScoped(input.sessionId, input.triggerId);
      // Retained Event rows cannot bypass the Channel binding/permission
      // prerequisite by changing only their enablement or set context.
      if (row.triggers.some((trigger) => trigger.kind === 'pluginEvent')) refuse('target_unavailable');
      const current = await opened(row, false, caller);
      const managed = readManagedMachineTriggerAction(input.patch.target ?? current.target);
      if (input.patch.project && !managed
        && createCanonicalJsonSigningInput(input.patch.project) !== createCanonicalJsonSigningInput(authorized.project)) {
        refuseInput('session_trigger_project_mismatch');
      }
      await assertContinuationOwner(input.patch.target ?? current.target, input.sessionId, caller);
      if (input.patch.trigger) assertScopedTrigger(input.patch.trigger, input.sessionId);
      const { onComplete, ...patch } = input.patch;
      const trigger = patch.trigger === undefined ? undefined : await resolveScopedTrigger(patch.trigger, input.sessionId, caller);
      const result = await actions.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: row.id, triggerId: input.triggerId, expectedRevision: input.expectedRevision,
        patch: { ...patch, ...(trigger === undefined ? {} : { trigger }), project: managed
          ? input.patch.project ?? project(row, current.context) : authorized.project } }), caller,
        { sessionId: input.sessionId, onComplete, project: authorized.project, authority: authorized.authority });
      try {
        await attachPullRequest(input.sessionId, result, caller);
        if (input.patch.trigger && input.patch.trigger.kind !== 'prComment' && input.patch.trigger.kind !== 'ciFailed'
          && row.triggers.some((item) => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed'))) {
          await deps.pullRequests?.removeTrigger({ sessionId: input.sessionId, triggerId: input.triggerId }, caller);
        }
      } catch (cause) { return unresolvedWriteReceipt(cause); }
      return result;
    },
    sessionRemove: async (raw: SessionTriggerRemoveRequestV1, caller?: Caller) => {
      const input = SessionTriggerRemoveRequestV1Schema.parse(raw);
      const { firingTrigger } = await session(input.sessionId, caller, input.triggerId);
      // The claim retains the firing set after a previous/coalesced occurrence
      // detached its trigger. Only that authorized set may use remove's no-op.
      const row = firingTrigger ? await read(firingTrigger.automationId, input.sessionId)
        : await findScoped(input.sessionId, input.triggerId);
      const result = await actions.remove({ automationId: row.id, triggerId: input.triggerId }, input.sessionId, caller);
      try {
        if (row.triggers.some((item) => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed'))) {
          await deps.pullRequests?.removeTrigger({ sessionId: input.sessionId, triggerId: input.triggerId }, caller);
        }
      } catch (cause) { return unresolvedWriteReceipt(cause); }
      return result;
    },
  };
  return sessionActions;
}
