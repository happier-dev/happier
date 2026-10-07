import type {
  AutomationDefinitionCreateRequest, AutomationDefinitionDetail, AutomationDefinitionListResponse,
  AutomationDefinitionReconcileRequest, AutomationTriggerReconcileExistingItem, AutomationDefinitionListRequest,
} from '../../automations/automationApiV3.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import {
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationStoredWorkflowDefinitionV2ReadSchema,
  type AutomationStoredWorkflowDefinitionRecipeV2, type WorkflowTriggerContextV1,
} from '../../automations/automationWorkflowRecipeV2.js';
import { readTriggerTargetV1, type TriggerTargetV1 } from '../../workflows/triggers/triggerTargetV1.js';
import { parseWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';
import { resolveWorkflowRunVisibleTeamV1 } from '../../workflows/workflowRunVisibilityV1.js';
import {
  WorkflowTriggerAddRequestV1Schema, WorkflowTriggerListRequestV1Schema,
  WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerRemoveRequestV1Schema,
  type WorkflowTriggerAddRequestV1, type WorkflowTriggerListRequestV1,
  type WorkflowTriggerUpdateRequestV1, type WorkflowTriggerRemoveRequestV1,
  type WorkflowTriggerSetV1,
  SessionTriggerListRequestV1Schema, SessionTriggerAddRequestV1Schema,
  SessionTriggerUpdateRequestV1Schema, SessionTriggerRemoveRequestV1Schema,
  type SessionTriggerListRequestV1, type SessionTriggerAddRequestV1,
  type SessionTriggerUpdateRequestV1, type SessionTriggerRemoveRequestV1,
  type SessionPullRequestLinkV1, type SessionTriggerDefinitionV1,
  type WorkflowTriggerSummaryInputV1,
  SessionInitialTriggerV1Schema, type SessionInitialTriggerV1, type SessionInitialTriggerDefinitionV1,
} from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionInitialTriggerAdmissionV1Schema, type SessionInitialTriggerAdmissionV1 } from '../../sessions/creation/sessionInitialTriggerAdmissionV1.js';
import { AutomationPullRequestTriggerSchema, type AutomationPullRequestTrigger } from '../../automations/automationTriggerDefinition.js';
import { admitAgentStartV1 } from '../../account/settings/admitAgentStartV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { materializeWorkflowAcceptedSnapshotV1, materializeWorkflowDefinitionAuthorityV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import { resolveWorkflowDestinationsV1 } from '../../workflows/workflowDestinationsV1.js';
import type { WorkflowActionExecuteArgs } from './types.js';
import { isActionCallerOwnSessionV1 } from './agentStartAdmission.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { canonicalizeAutomationSessionLifecycleEvents } from '../../automations/automationSessionLifecycle.js';
import type { AutomationRunLifecycleSource } from '../../automations/automationRunLifecycle.js';

type Caller = WorkflowActionExecuteArgs['context'];
export type WorkflowTriggerAutomationOperations = Readonly<{
  list: (input: Readonly<Partial<AutomationDefinitionListRequest>>) => Promise<AutomationDefinitionListResponse>;
  get: (automationId: string) => Promise<AutomationDefinitionDetail | null>;
  create: (input: AutomationDefinitionCreateRequest) => Promise<AutomationDefinitionDetail>;
  reconcile: (automationId: string, input: AutomationDefinitionReconcileRequest,
    current?: AutomationDefinitionDetail) => Promise<AutomationDefinitionDetail>;
  delete: (automationId: string) => Promise<void>;
}>;
export type WorkflowTriggerActionsDependencies = Readonly<{
  automations: WorkflowTriggerAutomationOperations;
  openContext: (automation: AutomationDefinitionDetail) => Promise<unknown>;
  sealContext: (input: Readonly<{ automationId: string; templateVersion: number; context: WorkflowTriggerContextV1 }>) => Promise<AutomationStoredWorkflowDefinitionRecipeV2>;
  newId: (kind: 'automation' | 'trigger') => string;
  resolveWorkflow: (ref: string) => Promise<WorkflowDefinitionV1>;
  /** Authorized Artifact grant transport; visibility policy remains shared with Run admission. */
  resolveWorkflowTeamIds?: (artifactId: string) => Promise<readonly string[]>;
  /** Session transport authorizes and opens the Session; callers cannot choose placement. */
  resolveSession?: (sessionId: string, caller?: Caller, options?: Readonly<{ checkNativeGoalOwner: boolean }>) => Promise<Readonly<{
    project: WorkflowTriggerAddRequestV1['project']; nativeGoalOwner: boolean | null;
    /** Current Session-owned execution facts, used when converting its retained Automation. */
    executionSelection?: WorkflowDefinitionV1['defaults'];
  }>>;
  resolveRunTrigger?: (runId: string) => Promise<Readonly<{ sessionId: string; triggerId: string }> | null>;
  /** Exact authorized Run read; no caller-created lifecycle or placement facts. */
  resolveRunSource?: (source: AutomationRunLifecycleSource, caller?: Caller) => Promise<Readonly<{ terminal: boolean }>>;
  resolveMaterializer?: (target: WorkflowTriggerAddRequestV1['project'], caller: Caller) => Promise<Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'effects' | 'roleSelection'>>;
  /** The legacy owner supplies its typed conversion; no second mapping here. */
  convertLegacy?: (automation: AutomationDefinitionDetail, caller?: Caller) => Promise<Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1 }>>;
  /** Read projection never grants conversion/write authority or changes retained V1 bytes. */
  readLegacyContext?: (automation: AutomationDefinitionDetail) => Promise<Readonly<{ target: TriggerTargetV1; context: WorkflowTriggerContextV1;
    placements?: NonNullable<WorkflowTriggerSetV1['legacy']>['placements'] }>>;
  openPullRequestTrigger?: (automation: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'prComment' | 'ciFailed' }>) => Promise<AutomationPullRequestTrigger>;
  pullRequests?: Readonly<{
    listLinks: (sessionId: string, caller?: Caller) => Promise<SessionPullRequestLinkV1[]>;
    attach: (input: Readonly<{ sessionId: string; automationId: string; triggerId: string; triggerRevision: number;
      triggerKind: 'prComment' | 'ciFailed'; pullRequest: AutomationPullRequestTrigger['pullRequest'] }>, caller?: Caller) => Promise<void>;
    removeTrigger: (input: Readonly<{ sessionId: string; triggerId: string }>, caller?: Caller) => Promise<void>;
  }>;
}>;

function refuse(code: string, details?: unknown): never {
  throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}
function isAgent(caller?: Caller) {
  return caller?.surface === 'agent' || caller?.actionCaller?.kind === 'session' || caller?.actionCaller?.kind === 'workflowRun'
    || caller?.actionCaller?.kind === 'automationRun';
}
function retainedTriggers(row: AutomationDefinitionDetail): AutomationTriggerReconcileExistingItem[] {
  return row.triggers.map((trigger) => ({ kind: 'existing', triggerId: trigger.id, expectedRevision: trigger.revision }));
}

async function automationRows(automations: Pick<WorkflowTriggerAutomationOperations, 'list'>,
  filter: Readonly<Partial<AutomationDefinitionListRequest>>) {
  const rows: AutomationDefinitionListResponse['automations'] = [];
  let cursor: string | undefined;
  do {
    const page = await automations.list({ ...filter, ...(cursor ? { cursor } : {}) });
    rows.push(...page.automations);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}
async function scopedRows(automations: Pick<WorkflowTriggerAutomationOperations, 'list'>, sessionId: string | null = null,
  filter: Readonly<Partial<AutomationDefinitionListRequest>> = {}) {
  return (await automationRows(automations, { ...filter, ...(sessionId ? { scopeSessionId: sessionId } : {}) }))
    .filter((row) => (row.scopeSessionId ?? null) === sessionId);
}

/** Definition deletion needs the Automation census, not private trigger context. */
export async function removeWorkflowTriggersForDefinition(
  automations: Pick<WorkflowTriggerAutomationOperations, 'list' | 'delete'>,
  workflow: string,
): Promise<void> {
  for (const row of await automationRows(automations, { workflowDefinitionId: workflow })) {
    if (row.workflowDefinitionId === workflow) await automations.delete(row.id);
  }
}

/** Trigger semantics compose the one Automation owner; no trigger storage or claim policy lives here. */
export function createWorkflowTriggerActions(deps: WorkflowTriggerActionsDependencies) {
  const read = async (automationId: string, sessionId: string | null = null) => {
    const row = await deps.automations.get(automationId);
    if (!row || (row.scopeSessionId ?? null) !== sessionId) refuse('content_unavailable');
    return row;
  };
  const opened = async (row: AutomationDefinitionDetail, projectionOnly = false, caller?: Caller): Promise<Readonly<{
    target: TriggerTargetV1; context: WorkflowTriggerContextV1; placements?: NonNullable<WorkflowTriggerSetV1['legacy']>['placements'];
  }>> => {
    if (row.executionRecipe?.v !== 2) {
      if (projectionOnly && deps.readLegacyContext) return deps.readLegacyContext(row);
      if (!deps.convertLegacy) refuse('legacy_conversion_unsupported', { reason: 'runtime_descriptor_unsupported' });
      return deps.convertLegacy(row, caller);
    }
    const context = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(await deps.openContext(row));
    const target = readTriggerTargetV1(row, context.success ? context.data : null);
    if (!context.success || target.kind !== 'available') refuse('source_unavailable');
    return { context: context.data, target: target.target };
  };
  const project = (row: AutomationDefinitionDetail, context: WorkflowTriggerContextV1) => {
    if (row.assignments.length !== 1) refuse('source_unavailable');
    return { machineId: row.assignments[0]!.machineId, ...context.workspace };
  };
  const assertTarget = async (target: TriggerTargetV1) => {
    const definition = target.kind === 'inline' ? target.definition : await deps.resolveWorkflow(target.ref);
    const checked = validateWorkflowDefinition(definition);
    if (!checked.valid) refuse('invalid_input', { issues: checked.issues });
    return definition;
  };
  const assertWrite = async (target: TriggerTargetV1, context: WorkflowTriggerContextV1, targetProject: WorkflowTriggerAddRequestV1['project'], caller?: Caller, sessionId?: string, creatingSession = false) => {
    await assertTarget(target);
    const source = target.kind === 'workflow' ? parseWorkflowDefinitionRefV1(target.ref) : null;
    const resolveTeamIds = deps.resolveWorkflowTeamIds;
    if (source?.kind === 'artifact' && !resolveTeamIds) refuse('target_unavailable');
    const teamIds = source?.kind === 'artifact' && resolveTeamIds ? await resolveTeamIds(source.artifactId) : [];
    const visibility = resolveWorkflowRunVisibleTeamV1(teamIds, context.visibleTeamId);
    if (!visibility.ok) refuse(visibility.code);
    if (source?.kind === 'artifact') context.visibleTeamId = visibility.visibleTeamId;
    if (isAgent(caller)) {
      const authority = caller?.agentStartContext;
      const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller?.sessionAgentSpawnPolicyV1);
      if (!caller || !authority || !policy.success || !deps.resolveMaterializer) refuse('target_unavailable');
      const definition = target.kind === 'inline' ? target.definition : await deps.resolveWorkflow(target.ref);
      const materializer = await deps.resolveMaterializer(targetProject, caller);
      const materialization = { definition, ...materializer,
        roleOverrides: context.roleOverrides,
        context: { source: { kind: 'inline' as const }, inputs: context.inputs ?? {}, machineId: targetProject.machineId,
          executionTarget: context.executionTarget, workspaceTarget: { project: { ...targetProject, checkoutRootPath: targetProject.directory } },
          origin: { kind: 'direct' as const, ...(sessionId ? { originSessionId: sessionId } : {}) }, authorization: { principal: { kind: 'host' as const } } },
      };
      // Birth has no origin id or first turn yet. The existing definition-authority
      // materializer validates concrete leaves without inventing future Run inputs.
      const materialized = creatingSession ? await materializeWorkflowDefinitionAuthorityV1(materialization)
        : await materializeWorkflowAcceptedSnapshotV1({ ...materialization, admission: { kind: 'user' } });
      if (!materialized.ok) refuse(materialized.error.code, materialized.error);
      const materializedLeaves = 'snapshot' in materialized ? materialized.snapshot.materializedLeaves : materialized.materializedLeaves;
      const sourceKeys = new Set(materialized.agentStartLeaves.map((leaf) => leaf.sourceKey ?? '$root'));
      if (sourceKeys.size === 0) sourceKeys.add('$root');
      for (const sourceKey of sourceKeys) {
        const roles = { ...authority.roles };
        for (const leaf of materializedLeaves) {
          if (leaf.sourceKey === sourceKey && leaf.role) roles[leaf.role.roleId] = leaf.role;
        }
        const admitted = admitAgentStartV1(policy.data, { kind: 'trigger_write', scope: sessionId || creatingSession ? 'session' : 'workflow',
          ...(sessionId ? { targetSessionId: sessionId } : {}),
          leaves: materialized.agentStartLeaves.filter((leaf) => (leaf.sourceKey ?? '$root') === sourceKey) }, { ...authority, roles });
        if (!admitted.ok) refuse(admitted.refusal.code, admitted.refusal);
      }
    }
  };
  const triggerContext = (input: Partial<Omit<WorkflowTriggerContextV1, 'workspace' | 'inlineDefinition'>>, target: TriggerTargetV1,
    targetProject: WorkflowTriggerAddRequestV1['project']) => {
    const { machineId: _machineId, ...workspace } = targetProject;
    return AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace, executionTarget: input.executionTarget ?? { kind: 'session' },
      ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      ...(input.roleOverrides === undefined ? {} : { roleOverrides: input.roleOverrides }),
      ...(input.visibleTeamId === undefined ? {} : { visibleTeamId: input.visibleTeamId }),
      ...(input.onComplete === undefined ? {} : { onComplete: input.onComplete }),
      ...(target.kind === 'inline' ? { inlineDefinition: target.definition } : {}) });
  };
  const projection = async (row: AutomationDefinitionDetail): Promise<WorkflowTriggerSetV1> => {
    const triggers: WorkflowTriggerSetV1['triggers'] = [];
    for (const trigger of row.triggers) {
      if (trigger.kind === 'prComment' || trigger.kind === 'ciFailed') {
        if (!deps.openPullRequestTrigger) refuse('target_unavailable');
        const definition = AutomationPullRequestTriggerSchema.parse(await deps.openPullRequestTrigger(row, trigger));
        if (definition.kind !== trigger.kind) refuse('source_unavailable');
        triggers.push({ ...trigger, ...definition });
      } else triggers.push(trigger);
    }
    const base = { automationId: row.id, revision: row.templateVersion, enabled: row.enabled, triggers,
      ...(row.templateCiphertext !== undefined ? { legacy: { editable: false as const, reason: 'created_in_0_2' as const } } : {}) };
    try {
      const value = await opened(row, true);
      const targetProject = base.legacy && row.assignments.length !== 1 ? undefined : project(row, value.context);
      // Retained templates are readable even when their settings cannot become a current Workflow.
      const definition = base.legacy
        ? value.target.kind === 'inline' ? value.target.definition : await deps.resolveWorkflow(value.target.ref)
        : await assertTarget(value.target);
      const destinations = await resolveWorkflowDestinationsV1({ definition, originSessionId: row.scopeSessionId ?? undefined }, deps.resolveWorkflow);
      return { ...base, triggers, ...(base.legacy && 'placements' in value ? { legacy: { ...base.legacy, placements: value.placements } } : {}),
        health: 'available', target: value.target, context: value.context, destinations, ...(targetProject ? { project: targetProject } : {}) };
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const lockedReason = code === 'session_key_required' || code === 'encryption_material_unavailable' ? 'session_key_required' as const
        : code === 'encryption_mode_mismatch' ? 'migration_required' as const
        : code === 'invalid_template' ? 'decryption_failed' as const : undefined;
      if (base.legacy && lockedReason) return { ...base, health: 'source_unavailable', legacy: { ...base.legacy, lockedReason } };
      // A retained existing-Session target may have lost its Session. It does not block listing or removal.
      if (code !== 'source_unavailable' && code !== 'invalid_input' && !(base.legacy && code === 'target_unavailable')) throw error;
      return { ...base, health: 'source_unavailable' };
    }
  };
  const writeResult = async (row: AutomationDefinitionDetail, triggerId?: ReturnType<typeof AutomationTriggerIdSchema.parse>) => {
    const trigger = triggerId ? row.triggers.find((item) => item.id === triggerId) : undefined;
    return { set: await projection(row), ...(triggerId ? { triggerId } : {}), ...(trigger ? { triggerRevision: trigger.revision } : {}) };
  };
  const reconcile = async (row: AutomationDefinitionDetail, context: WorkflowTriggerContextV1, target: TriggerTargetV1,
    targetProject: WorkflowTriggerAddRequestV1['project'], changes: Pick<AutomationDefinitionReconcileRequest, 'triggers' | 'removedTriggers'>,
    enabled = row.enabled) => deps.automations.reconcile(row.id, {
      expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled,
      workflowDefinitionId: target.kind === 'workflow' ? target.ref : null,
      executionRecipe: await deps.sealContext({ automationId: row.id, templateVersion: row.templateVersion + 1, context }),
      assignments: [{ machineId: targetProject.machineId, enabled: row.assignments[0]?.enabled ?? true,
        ...(row.assignments[0]?.priority === undefined ? {} : { priority: row.assignments[0].priority }) }],
      ...changes,
    }, row);
  const actions = {
    readWorkflowSummaries: async (): Promise<ReadonlyMap<string, Readonly<{ triggers: readonly WorkflowTriggerSummaryInputV1[]; nextRunAt: number | null }>>> => {
      const summaries = new Map<string, { triggers: WorkflowTriggerSummaryInputV1[]; nextRunAt: number | null }>();
      for (const row of await scopedRows(deps.automations)) {
        if (!row.workflowDefinitionId) continue;
        const summary = summaries.get(row.workflowDefinitionId) ?? { triggers: [], nextRunAt: null };
        const triggers = summary.triggers;
        for (const trigger of row.triggers) {
          switch (trigger.kind) {
            case 'schedule':
              triggers.push({ kind: trigger.kind, schedule: trigger.schedule });
              if (row.enabled && trigger.enabled && trigger.nextRunAt !== null) {
                summary.nextRunAt = summary.nextRunAt === null ? trigger.nextRunAt : Math.min(summary.nextRunAt, trigger.nextRunAt);
              }
              break;
            case 'pluginEvent': triggers.push({ kind: trigger.kind, eventRef: trigger.eventRef }); break;
            case 'sessionLifecycle': triggers.push({ kind: trigger.kind, events: trigger.events }); break;
            case 'runLifecycle': triggers.push({ kind: trigger.kind, condition: trigger.condition }); break;
            case 'prComment': case 'ciFailed': triggers.push({ kind: trigger.kind }); break;
          }
        }
        summaries.set(row.workflowDefinitionId, summary);
      }
      return summaries;
    },
    list: async (raw: WorkflowTriggerListRequestV1) => {
      const input = WorkflowTriggerListRequestV1Schema.parse(raw);
      const rows = (await scopedRows(deps.automations, null, 'workflow' in input
        ? { workflowDefinitionId: input.workflow } : { scope: 'account_inline' })).filter((row) => 'workflow' in input
        ? row.workflowDefinitionId === input.workflow : row.workflowDefinitionId == null);
      const sets: WorkflowTriggerSetV1[] = [];
      for (const item of rows) {
        const row = await read(item.id);
        if ('scope' in input && row.executionRecipe?.v === 2) {
          // Invalid inline context remains visible as unavailable, rather than disappearing from the Triggers section.
          sets.push(await projection(row));
        } else if ('workflow' in input || row.templateCiphertext !== undefined) {
          sets.push(await projection(row));
        }
      }
      return { sets };
    },
    add: async (raw: WorkflowTriggerAddRequestV1, caller?: Caller, scope?: Readonly<{ sessionId: string; onComplete?: WorkflowTriggerContextV1['onComplete'] }>) => {
      const input = WorkflowTriggerAddRequestV1Schema.parse(raw);
      if ((input.trigger.kind === 'prComment' || input.trigger.kind === 'ciFailed') && !scope) refuse('invalid_input');
      const target = input.target ?? { kind: 'workflow' as const, ref: input.workflow! };
      let sourceTerminal = false;
      if (input.trigger.kind === 'runLifecycle') {
        if (input.trigger.source.kind === 'execution_run' && input.trigger.condition !== 'terminal') refuse('unsupported_condition');
        if (!deps.resolveRunSource) refuse('target_unavailable');
        sourceTerminal = (await deps.resolveRunSource(input.trigger.source, caller)).terminal;
      }
      const { machineId, ...workspace } = input.project;
      const context = triggerContext({ ...input, ...(scope?.onComplete === undefined ? {} : { onComplete: scope.onComplete }) }, target, input.project);
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
          ...(input.roleOverrides === undefined ? {} : { roleOverrides: input.roleOverrides }) });
        if (scope?.onComplete !== undefined) mergedContext.onComplete = scope.onComplete;
        await assertWrite(target, mergedContext, input.project, caller, scope?.sessionId);
        const committed = await reconcile(row, mergedContext, target, input.project, {
          triggers: [...retainedTriggers(row), { kind: 'new', triggerId, trigger: input.trigger }], removedTriggers: [],
        });
        return writeResult(committed, triggerId);
      }
      await assertWrite(target, context, input.project, caller, scope?.sessionId);
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
            || createCanonicalJsonSigningInput(project(candidate, current.context)) !== createCanonicalJsonSigningInput(input.project)) continue;
          const registered = candidate.triggers.find((item) => item.kind === 'runLifecycle' && item.enabled
            && ((item.remainingOccurrences === 1 && item.status.state === 'waiting')
              || (source.condition === 'terminal' && sourceTerminal && item.remainingOccurrences === 0 && item.status.state === 'finished'))
            && item.condition === source.condition
            && createCanonicalJsonSigningInput(item.source) === createCanonicalJsonSigningInput(source.source));
          if (registered) return writeResult(candidate, registered.id);
        }
      }
      if (scope && input.trigger.kind === 'sessionLifecycle' && input.trigger.enabled
        && (input.trigger.policy.kind === 'currentTurn' || input.trigger.policy.kind === 'firstMatch')
        && onlyBlock?.kind === 'action' && onlyBlock.actionId === 'notifications.notify_me') {
        const source = input.trigger;
        const intended = createCanonicalJsonSigningInput(context);
        for (const summary of await scopedRows(deps.automations, scope.sessionId)) {
          if (!summary.enabled || summary.workflowDefinitionId != null) continue;
          const candidate = await read(summary.id, scope.sessionId);
          if (!candidate.enabled || candidate.executionRecipe?.v !== 2 || candidate.workflowDefinitionId != null) continue;
          const current = await opened(candidate, false, caller);
          if (createCanonicalJsonSigningInput(current.context) !== intended) continue;
          const registered = candidate.triggers.find((item) => item.kind === 'sessionLifecycle' && item.enabled
            && item.remainingOccurrences !== 0 && item.status.state === 'waiting'
            && item.sourceSessionId === source.sourceSessionId
            && createCanonicalJsonSigningInput(item.policy) === createCanonicalJsonSigningInput(source.policy)
            && createCanonicalJsonSigningInput(canonicalizeAutomationSessionLifecycleEvents(item.events))
              === createCanonicalJsonSigningInput(canonicalizeAutomationSessionLifecycleEvents(source.events)));
          if (registered) {
            // Session placement is authorized by resolveSession, not by a stale
            // assignment retained with the notification. Move the same intent
            // through reconciliation; never create a second firing trigger.
            const committed = candidate.assignments.length === 1 && candidate.assignments[0]?.machineId === machineId
              ? candidate
              : await reconcile(candidate, context, target, input.project,
                { triggers: retainedTriggers(candidate), removedTriggers: [] });
            return writeResult(committed, registered.id);
          }
        }
      }
      const automationId = deps.newId('automation');
      const row = await deps.automations.create({ automationId, name: 'Workflow triggers', description: null, enabled: true,
        workflowDefinitionId: target.kind === 'workflow' ? target.ref : null, scopeSessionId: scope?.sessionId ?? null,
        executionRecipe: await deps.sealContext({ automationId, templateVersion: 1, context }),
        assignments: [{ machineId, enabled: true }], triggers: [{ triggerId, trigger: input.trigger }] });
      return writeResult(row, triggerId);
    },
    update: async (raw: WorkflowTriggerUpdateRequestV1, caller?: Caller, scope?: Readonly<{ sessionId: string; onComplete?: WorkflowTriggerContextV1['onComplete'] }>) => {
      const input = WorkflowTriggerUpdateRequestV1Schema.parse(raw);
      if ((input.patch.trigger?.kind === 'prComment' || input.patch.trigger?.kind === 'ciFailed') && !scope) refuse('invalid_input');
      const row = await read(input.automationId, scope?.sessionId);
      if (row.templateVersion !== input.expectedRevision) refuse('currentness_conflict', { revision: row.templateVersion });
      if (input.triggerId && !row.triggers.some((item) => item.id === input.triggerId)) refuse('content_unavailable');
      const current = await opened(row, false, caller);
      const { target: nextTarget, project: nextProject, enabled, trigger, ...contextPatch } = input.patch;
      if (trigger?.kind === 'runLifecycle') {
        if (trigger.source.kind === 'execution_run' && trigger.condition !== 'terminal') refuse('unsupported_condition');
        if (!deps.resolveRunSource) refuse('source_unavailable');
        await deps.resolveRunSource(trigger.source, caller);
      }
      const target = nextTarget ?? current.target;
      if (!scope && current.target.kind === 'workflow' && nextTarget && (nextTarget.kind !== 'workflow' || nextTarget.ref !== current.target.ref)) refuse('invalid_input');
      const targetProject = nextProject ?? project(row, current.context);
      const { machineId: _machineId, ...workspace } = targetProject;
      const { inlineDefinition: _inlineDefinition, ...previous } = current.context;
      const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...previous, ...contextPatch, workspace,
        ...(scope?.onComplete === undefined ? {} : { onComplete: scope.onComplete }),
        ...(target.kind === 'inline' ? { inlineDefinition: target.definition } : {}) });
      if (target.kind === 'inline' && context.visibleTeamId !== undefined) refuse('invalid_input');
      await assertWrite(target, context, targetProject, caller, scope?.sessionId);
      // A per-trigger switch enables that trigger, not every enabled sibling
      // hidden behind a disabled set. Normalize effective sibling state in the
      // same reconciliation rather than exposing an intermediate global enable.
      const enablingDisabledSet = input.triggerId !== undefined && enabled === true && !row.enabled;
      const triggers = retainedTriggers(row).map((item, index) => item.triggerId === input.triggerId
        ? { ...item, ...(enabled === undefined ? {} : { enabled }), ...(trigger === undefined ? {} : { trigger }) }
        : enablingDisabledSet && row.triggers[index]?.enabled ? { ...item, enabled: false } : item);
      return writeResult(await reconcile(row, context, target, targetProject, { triggers, removedTriggers: [] },
        enablingDisabledSet ? true : input.triggerId === undefined && enabled !== undefined ? enabled : row.enabled), input.triggerId);
    },
    remove: async (raw: WorkflowTriggerRemoveRequestV1, sessionId?: string) => {
      const input = WorkflowTriggerRemoveRequestV1Schema.parse(raw);
      const row = await read(input.automationId, sessionId);
      const trigger = row.triggers.find((item) => item.id === input.triggerId);
      if (!trigger) return writeResult(row, input.triggerId);
      // Removing a missing-source trigger needs no private source or materializer.
      const committed = await deps.automations.reconcile(row.id, {
        expectedTemplateVersion: row.templateVersion, name: row.name, description: row.description, enabled: row.enabled,
        assignments: row.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority })),
        triggers: retainedTriggers(row).filter((item) => item.triggerId !== input.triggerId),
        removedTriggers: [{ triggerId: trigger.id, expectedRevision: trigger.revision }],
      }, row);
      return writeResult(committed, input.triggerId);
    },
    removeForWorkflow: (workflow: string) => removeWorkflowTriggersForDefinition(deps.automations, workflow),
  };
  const session = async (sessionId: string, caller?: Caller, ownRemoval = false) => {
    if (isAgent(caller) && !ownRemoval && !isActionCallerOwnSessionV1(caller, sessionId)) {
      const authority = caller?.agentStartContext;
      const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller?.sessionAgentSpawnPolicyV1);
      if (!authority || !policy.success) refuse('target_unavailable');
      if (authority.caller.kind === 'originless') refuse('run_access_denied');
      const admitted = admitAgentStartV1(policy.data, { kind: 'session_target', targetSessionId: sessionId }, authority);
      if (!admitted.ok) refuse(admitted.refusal.code, admitted.refusal);
    }
    if (!deps.resolveSession) refuse('target_unavailable');
    return deps.resolveSession(sessionId, caller, { checkNativeGoalOwner: false });
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
    if (trigger.kind === 'runLifecycle') refuse('invalid_input');
    if (trigger.kind === 'sessionLifecycle') {
      if (sessionId !== undefined && trigger.events.includes('sessionStarted')) refuse('session_already_started');
      if (sessionId !== undefined && (!('sourceSessionId' in trigger) || trigger.sourceSessionId !== sessionId)) refuse('invalid_input');
    }
  };
  const resolveScopedTrigger = async <T extends SessionTriggerDefinitionV1>(trigger: T, sessionId: string, caller?: Caller) => {
    if (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed') return trigger;
    if ('triggerDefinitionEnvelope' in trigger) refuse('invalid_input');
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
    if (target.kind !== 'workflow' || target.ref !== 'builtin:keep-going') return;
    if (!deps.resolveSession) refuse('target_unavailable');
    const { nativeGoalOwner } = await deps.resolveSession(sessionId, caller, { checkNativeGoalOwner: true });
    if (nativeGoalOwner === true) refuse('native_goal_owner');
    if (nativeGoalOwner === null) refuse('target_unavailable');
  };
  return { ...actions,
    prepareSessionInitialTriggers: async (input: Readonly<{ initialTriggers: readonly SessionInitialTriggerV1[];
      project: WorkflowTriggerAddRequestV1['project']; caller?: Caller }>): Promise<SessionInitialTriggerAdmissionV1[]> => {
      const prepared: SessionInitialTriggerAdmissionV1[] = [];
      for (const raw of input.initialTriggers) {
        input.caller?.signal?.throwIfAborted();
        const draft = SessionInitialTriggerV1Schema.parse(raw);
        assertScopedTrigger(draft.trigger);
        // PR/CI registration requires a born Session's Channel binding; nothing
        // may be committed if this prerequisite cannot be admitted at birth.
        if (draft.trigger.kind === 'prComment' || draft.trigger.kind === 'ciFailed') refuse('target_unavailable');
        const context = triggerContext(draft, draft.target, input.project);
        await assertWrite(draft.target, context, input.project, input.caller, undefined, true);
        const automationId = deps.newId('automation');
        prepared.push(SessionInitialTriggerAdmissionV1Schema.parse({ automationId, name: 'Workflow triggers', description: null,
          enabled: true, workflowDefinitionId: draft.target.kind === 'workflow' ? draft.target.ref : null,
          executionRecipe: await deps.sealContext({ automationId, templateVersion: 1, context }),
          assignments: [{ machineId: input.project.machineId, enabled: true }],
          triggers: [{ triggerId: AutomationTriggerIdSchema.parse(deps.newId('trigger')), trigger: draft.trigger }],
        }));
      }
      return prepared;
    },
    add: (raw: WorkflowTriggerAddRequestV1, caller?: Caller) => actions.add(raw, caller),
    update: (raw: WorkflowTriggerUpdateRequestV1, caller?: Caller) => actions.update(raw, caller),
    remove: (raw: WorkflowTriggerRemoveRequestV1) => actions.remove(raw),
    sessionList: async (raw: SessionTriggerListRequestV1, caller?: Caller) => {
      const input = SessionTriggerListRequestV1Schema.parse(raw);
      await session(input.sessionId, caller);
      const sets: WorkflowTriggerSetV1[] = [];
      for (const row of await scopedRows(deps.automations, input.sessionId)) sets.push(await projection(await read(row.id, input.sessionId)));
      const unavailable = { status: 'unavailable', code: 'target_unavailable' } as const;
      let pullRequestLinks: SessionPullRequestLinkV1[] | typeof unavailable = unavailable;
      if (deps.pullRequests) {
        try {
          pullRequestLinks = await deps.pullRequests.listLinks(input.sessionId, caller);
        } catch {
          caller?.signal?.throwIfAborted();
        }
      }
      caller?.signal?.throwIfAborted();
      return { sessionId: input.sessionId, sets, pullRequestLinks };
    },
    sessionAdd: async (raw: SessionTriggerAddRequestV1, caller?: Caller) => {
      const { sessionId, onComplete, ...input } = SessionTriggerAddRequestV1Schema.parse(raw);
      const authorized = await session(sessionId, caller);
      await assertContinuationOwner(input.target, sessionId, caller);
      assertScopedTrigger(input.trigger, sessionId);
      const trigger = await resolveScopedTrigger(input.trigger, sessionId, caller);
      const result = await actions.add(WorkflowTriggerAddRequestV1Schema.parse({ ...input, trigger, project: authorized.project }), caller, { sessionId, onComplete });
      await attachPullRequest(sessionId, result, caller);
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
      await assertContinuationOwner(input.patch.target ?? current.target, input.sessionId, caller);
      if (input.patch.trigger) assertScopedTrigger(input.patch.trigger, input.sessionId);
      const { onComplete, ...patch } = input.patch;
      const trigger = patch.trigger === undefined ? undefined : await resolveScopedTrigger(patch.trigger, input.sessionId, caller);
      const result = await actions.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: row.id, triggerId: input.triggerId, expectedRevision: input.expectedRevision,
        patch: { ...patch, ...(trigger === undefined ? {} : { trigger }), project: authorized.project } }), caller, { sessionId: input.sessionId, onComplete });
      await attachPullRequest(input.sessionId, result, caller);
      if (input.patch.trigger && input.patch.trigger.kind !== 'prComment' && input.patch.trigger.kind !== 'ciFailed'
        && row.triggers.some((item) => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed'))) {
        await deps.pullRequests?.removeTrigger({ sessionId: input.sessionId, triggerId: input.triggerId }, caller);
      }
      return result;
    },
    sessionRemove: async (raw: SessionTriggerRemoveRequestV1, caller?: Caller) => {
      const input = SessionTriggerRemoveRequestV1Schema.parse(raw);
      const runId = caller?.actionCaller?.kind === 'workflowRun' ? caller.actionCaller.runId
        : caller?.actionCaller?.kind === 'automationRun' ? caller.actionCaller.runId : undefined;
      if (runId) {
        const firing = await deps.resolveRunTrigger?.(runId);
        if (!firing || firing.sessionId !== input.sessionId || firing.triggerId !== input.triggerId) refuse('run_access_denied');
      }
      await session(input.sessionId, caller, runId !== undefined);
      const row = await findScoped(input.sessionId, input.triggerId);
      const result = await actions.remove({ automationId: row.id, triggerId: input.triggerId }, input.sessionId);
      if (row.triggers.some((item) => item.id === input.triggerId && (item.kind === 'prComment' || item.kind === 'ciFailed'))) {
        await deps.pullRequests?.removeTrigger({ sessionId: input.sessionId, triggerId: input.triggerId }, caller);
      }
      return result;
    },
  };
}
export type WorkflowTriggerActions = ReturnType<typeof createWorkflowTriggerActions>;
