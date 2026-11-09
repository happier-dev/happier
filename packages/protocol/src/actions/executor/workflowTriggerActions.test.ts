import { describe, expect, it } from 'vitest';
import { createSessionMembershipReadFixture } from '../../sessions/read/sessionReadBatchV1.testkit.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import type { AutomationDefinitionDetail, AutomationTriggerDetail, AutomationV3RunMutationResponse } from '../../automations/automationApiV3.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { resolveWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionResolverV1.js';
import { createWorkflowTriggerActions, type WorkflowTriggerActionsDependencies } from './workflowTriggerActions.js';
import { SessionTriggerAddRequestV1Schema, SessionTriggerListResultV1Schema, WorkflowTriggerListResultV1Schema, WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerWriteResultV1Schema, WorkflowTriggerRemoveResultV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { normalizeUsageQuery } from '../../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../../usage/resolveUsagePageAggregation.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createActionExecutor } from '../actionExecutor.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { AutomationTriggerDetailSchema } from '../../automations/automationTriggerProjectionV1.js';
import { AutomationPullRequestTriggerSchema } from '../../automations/automationTriggerDefinition.js';
import { openAutomationTriggerDefinitionStoredEnvelopeV1, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '../../automations/automationTriggerDefinitionStoredContent.js';
import { markSessionListQueryResultV1 } from '../../sessions/awareness/action.js';
import { ActionIdSchema } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '../actionCatalog.js';
import { resolveActionCurrentSessionScopeFailure } from './sessionListAccess.js';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { SessionInitialTriggerAdmissionV1Schema } from '../../sessions/creation/sessionInitialTriggerAdmissionV1.js';
import { createAccountWorkflowTriggerActions } from './workflowTriggerAccountHost.js';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { isAvailableE2eeAutomationAccountEncryptionV1, type AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { AutomationSourceSelectorIdV1Schema } from '../../automations/automationOccurrenceV1.js';
import { DeploymentEnvironmentHeaderV1Schema } from '../../deployments/deploymentActionsV1.js';

import type { ArtifactRevisionProvenanceV1, ArtifactSavedByV1 } from '../../artifacts/artifactBinaryV1.js';
import { createNightlyBackupsWorkflowV1 } from '../../workflows/builtins/backupExamples.js';

const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'prompt', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});
const trigger = { kind: 'schedule' as const, enabled: true,
  schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
const project = { machineId: 'machine-one', directory: '/workspace' };
const workflow = '11111111-1111-4111-8111-111111111111';
const ownCaller = { surface: 'agent' as const, sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  agentStartContext: { caller: { kind: 'session' as const, sessionId: 'session-one', starterDepth: 0, turnDepth: 0 },
    baseline: { ...project, configuration: { agentTarget: definition.defaults!.agentTarget! } }, ledSubtreeSessionIds: [],
    workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' as const } };

function manualReceipt(automationId: string): AutomationV3RunMutationResponse {
  return { run: { id: 'run-manual', automationId, revision: 1, triggerId: null,
    triggerRetired: false, state: 'queued', cause: { kind: 'manual', invokedAt: 1 },
    dueAt: 1, claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null,
    attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
    replyHandoffState: 'none', replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1 } };
}

function fixture(savedDefinition = definition) {
  // These operations are the persistent/network Automation boundary; all Action semantics and validation run real.
  const rows = new Map<string, AutomationDefinitionDetail>();
  let nextId = 0;
  let managedControllerMachineId: string | null = 'controller';
  const artifact = { artifactId: workflow, ownerAccountId: 'owner', access: 'owner' as const,
    updatedAt: 100, provenance: undefined as ArtifactRevisionProvenanceV1 | undefined,
    header: { kind: 'workflow-definition.v1', definitionId: workflow,
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } },
    body: JSON.stringify({ kind: 'workflow-definition.v1', definition: savedDefinition }), revision: { headerVersion: 1, bodyVersion: 1 } };
  const artifacts = new Map([[workflow, artifact]]);
  let definitionReads = 0;
  let sourceReadFailure: Error | null = null;
  // Artifact reads/writes are the external persistent boundary; resolution and validation stay real.
  const artifactStore: WorkflowDefinitionArtifactOperations = {
    read: async (id) => { definitionReads++; if (sourceReadFailure) throw sourceReadFailure; return artifacts.get(id) ?? null; },
    list: async () => ({ items: [] }),
    create: async () => { throw new Error('Unexpected fixture Artifact write'); },
    update: async () => { throw new Error('Unexpected fixture Artifact write'); },
    delete: async (id) => { artifacts.delete(id); return { ok: true }; },
  };
  const definitions = createWorkflowDefinitionActions({ artifactStore,
    encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: () => { throw new Error('Unexpected fixture definition policy write'); } });
  const toTrigger = (id: string, enabled = trigger.enabled): AutomationTriggerDetail => ({ ...trigger, enabled, id: AutomationTriggerIdSchema.parse(id),
    revision: 0, createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null });
  const deps: WorkflowTriggerActionsDependencies = {
    newId: (kind) => `${kind}-${++nextId}`,
    resolveManagedMachine: async ({ homeId, managedId }) => ({ id: managedId, homeId, custodianAccountId: 'owner',
      launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
      ...(managedControllerMachineId === null ? {} : { controller: { machineId: managedControllerMachineId, installationId: 'controller-install' } }), enrolledMachineId: project.machineId,
      allocation: 'bound', resource: { contributionRef: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, value: {} },
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }),
    resolveRunSource: async () => ({ terminal: true }),
    resolveWorkflow: async (ref) => {
      const source = await resolveWorkflowDefinitionRefV1(ref, { readArtifact: (definitionId) => definitions.get({ definitionId }) });
      if (!source) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      return source;
    },
    resolveWorkflowTeamIds: async () => [],
    openContext: async (row) => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
    sealContext: async ({ templateVersion, context }) => ({ v: 2, templateVersion, workflow: { t: 'plain', v: context }, triggerEvidence: null }),
    openPullRequestTrigger: async (row, item) => {
      const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, automationId: row.id, triggerId: item.id, triggerRevision: item.revision, triggerKind: item.kind },
        envelope: JSON.parse(item.triggerDefinitionEnvelope) });
      if (opened.kind !== 'available') throw new Error(opened.kind);
      return AutomationPullRequestTriggerSchema.parse(opened.definition);
    },
    automations: {
      // The real list projection omits the private execution recipe; callers must
      // open the authorized detail before comparing an inline notification intent.
      list: async () => ({ automations: [...rows.values()].map(({ executionRecipe: _private, ...row }) => row), nextCursor: null }),
      listDetails: async () => ({ automations: [...rows.values()], nextCursor: null }),
      get: async (id) => rows.get(id) ?? null,
      create: async (input) => {
        const row: AutomationDefinitionDetail = { id: input.automationId, name: input.name, description: input.description ?? null,
          enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
          ...(input.observationOnly ? { observationOnly: input.observationOnly } : {}),
          assignments: (input.assignments ?? []).map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
          triggers: input.triggers.map((value) => value.trigger.kind === 'prComment' || value.trigger.kind === 'ciFailed'
            ? AutomationTriggerDetailSchema.parse({ kind: value.trigger.kind, id: value.triggerId, revision: 0, enabled: value.trigger.enabled,
              createdAt: 1, updatedAt: 1, sourceSessionId: input.scopeSessionId,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value.trigger ? value.trigger.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: input.automationId, triggerId: AutomationTriggerIdSchema.parse(value.triggerId), triggerRevision: 0, triggerKind: value.trigger.kind },
                  definition: { kind: value.trigger.kind, pullRequest: value.trigger.pullRequest } })) })
            : value.trigger.kind === 'pluginEvent'
            ? AutomationTriggerDetailSchema.parse({ kind: 'pluginEvent', id: value.triggerId, revision: 0,
              enabled: value.trigger.enabled, createdAt: 1, updatedAt: 1, eventRef: value.trigger.eventRef,
              sourceSelectorId: 'sourceSelectorId' in value.trigger ? value.trigger.sourceSelectorId : '00000000-0000-4000-8000-000000000001', sourceContractVersion: 1,
              observation: value.trigger.observationTransport.kind === 'durablePush'
                ? { kind: 'durablePush', webhookEndpointId: value.trigger.observationTransport.webhookEndpointId,
                  endpointMaterializationRef: null, observationStartsAt: value.trigger.observationTransport.observationStartsAt }
                : { kind: value.trigger.observationTransport.kind, watcher: value.trigger.observationTransport.watcherMaterializationRef
                  ? { ...value.trigger.observationTransport.watcherMaterializationRef, machineInstallationId: 'fixture-installation' } : null }, sourceStatus: null,
              sourceCatalogStatus: null, triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value.trigger
                ? value.trigger.triggerDefinitionEnvelope : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: input.automationId, triggerId: AutomationTriggerIdSchema.parse(value.triggerId),
                    triggerRevision: 0, triggerKind: 'pluginEvent', eventRef: value.trigger.eventRef,
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000001') },
                  definition: { v: 1, sourceInstanceId: value.trigger.sourceInstanceId, sourceConfig: value.trigger.sourceConfig,
                    displayLabel: value.trigger.displayLabel, filter: value.trigger.filter, maximumObservationAgeMs: value.trigger.maximumObservationAgeMs } })) })
            : value.trigger.kind === 'sessionLifecycle' || value.trigger.kind === 'runLifecycle'
            ? AutomationTriggerDetailSchema.parse({ ...value.trigger, id: value.triggerId,
              revision: 0, createdAt: 1, updatedAt: 1, remainingOccurrences: 1,
              status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }) : toTrigger(value.triggerId, value.trigger.enabled)), executionRecipe: input.executionRecipe };
        rows.set(row.id, row); return row;
      },
      reconcile: async (id, input) => {
        const current = rows.get(id)!;
        if (current.templateVersion !== input.expectedTemplateVersion) throw Object.assign(new Error('conflict'), { code: 'currentness_conflict' });
        const triggers = await Promise.all(input.triggers.map(async (item): Promise<AutomationTriggerDetail> => {
          if (item.kind === 'new' && (item.trigger.kind === 'prComment' || item.trigger.kind === 'ciFailed')) {
            const value = item.trigger;
            return AutomationTriggerDetailSchema.parse({ kind: value.kind, id: item.triggerId, revision: 0,
              enabled: value.enabled, createdAt: 1, updatedAt: 1, sourceSessionId: current.scopeSessionId,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value ? value.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: id, triggerId: AutomationTriggerIdSchema.parse(item.triggerId), triggerRevision: 0, triggerKind: value.kind },
                  definition: { kind: value.kind, pullRequest: value.pullRequest } })) });
          }
          if (item.kind === 'new') return toTrigger(item.triggerId, item.trigger.enabled);
          const old = current.triggers.find((value) => value.id === item.triggerId)!;
          if ((old.kind === 'prComment' || old.kind === 'ciFailed') && (item.enabled !== undefined || item.trigger !== undefined)) {
            const revision = old.revision + 1;
            const definition = item.trigger ?? await deps.openPullRequestTrigger!(current, old);
            if (definition.kind !== 'prComment' && definition.kind !== 'ciFailed') throw new Error('Unsupported fixture replacement');
            return AutomationTriggerDetailSchema.parse({ ...old, kind: definition.kind, revision, enabled: item.enabled ?? old.enabled,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in definition ? definition.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, automationId: id,
                  triggerId: old.id, triggerRevision: revision, triggerKind: definition.kind }, definition })) });
          }
          if (old.kind === 'pluginEvent' && item.trigger?.kind === 'pluginEvent') {
            const value = item.trigger;
            const revision = old.revision + 1;
            const sourceSelectorId = 'sourceSelectorId' in value ? value.sourceSelectorId : old.sourceSelectorId;
            return AutomationTriggerDetailSchema.parse({ ...old, revision, enabled: item.enabled ?? old.enabled,
              eventRef: value.eventRef, sourceSelectorId, sourceContractVersion: value.sourceContractVersion,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value ? value.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: id, triggerId: old.id, triggerRevision: revision,
                    triggerKind: 'pluginEvent', eventRef: value.eventRef, sourceSelectorId },
                  definition: { v: 1, sourceInstanceId: value.sourceInstanceId, sourceConfig: value.sourceConfig,
                    displayLabel: value.displayLabel, filter: value.filter, maximumObservationAgeMs: value.maximumObservationAgeMs } })) });
          }
          return { ...old, ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
            ...(item.enabled === undefined && item.trigger === undefined ? {} : { revision: old.revision + 1 }) };
        }));
        const row: AutomationDefinitionDetail = { ...current,
          // The Automation transport advances the definition revision for metadata/trigger writes too.
          templateVersion: current.templateVersion + 1, enabled: input.enabled,
          assignments: input.assignments.map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
          workflowDefinitionId: input.workflowDefinitionId === undefined ? current.workflowDefinitionId : input.workflowDefinitionId,
          executionRecipe: input.executionRecipe ?? current.executionRecipe, triggers };
        rows.set(id, row); return row;
      },
      delete: async (id) => { rows.delete(id); return { ok: true }; },
    },
  };
  return { rows, deps, definitions, actions: createWorkflowTriggerActions(deps), definitionReads: () => definitionReads,
    failSourceReads: () => { sourceReadFailure = Object.assign(new Error('Artifact read timed out'), { code: 'ECONNABORTED' }); },
    loseSource: () => { artifacts.delete(workflow); },
    saveSourceAs: (savedBy: ArtifactSavedByV1 | undefined, savedAt: number) => {
      artifact.revision = { headerVersion: artifact.revision.headerVersion + 1, bodyVersion: artifact.revision.bodyVersion + 1 };
      artifact.header.revision = artifact.revision;
      artifact.provenance = savedBy ? { savedBy } : undefined;
      artifact.updatedAt = savedAt;
    },
    replaceDefinition: (value: ReturnType<typeof WorkflowDefinitionV1Schema.parse>) => {
      artifact.body = JSON.stringify({ kind: 'workflow-definition.v1', definition: value });
    },
    setManagedController: (machineId: string | null) => { managedControllerMachineId = machineId; },
    executor: (triggers: ReturnType<typeof createWorkflowTriggerActions>, ports: Partial<ActionExecutorDeps> = {}) => createActionExecutor({
      ...ports,
      workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, triggers,
        runs: { execute: async () => { throw new Error('Unexpected Run write'); } } }),
    }),
  };
}

describe('trigger source display provenance', () => {
  it.each(['ui', 'mcp'] as const)('clears the Goal and detaches only Keep going through the %s Action', async surface => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const caller = { surface, authority: 'present_user' } as const;
    const keepGoing = await actions.sessionAdd({ sessionId: 'session-one',
      target: { kind: 'workflow', ref: 'builtin:keep-going' },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one',
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } } }, caller);
    const other = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one',
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } } }, caller);
    let goalPresent = true;
    const boundary = f.executor(actions, { isActionApprovalRequired: () => false,
      sessionGoalClear: async () => { goalPresent = false; return { ok: true }; } });
    const cleared = await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, caller);
    expect(cleared, JSON.stringify(cleared)).toMatchObject({ ok: true });
    expect(goalPresent).toBe(false);
    expect((await actions.sessionList({ sessionId: 'session-one' }, caller)).sets
      .flatMap(set => set.triggers).some(trigger => trigger.id === keepGoing.triggerId)).toBe(false);
    expect((await actions.sessionList({ sessionId: 'session-one' }, caller)).sets
      .flatMap(set => set.triggers).some(trigger => trigger.id === other.triggerId)).toBe(true);
  });
  it('reports a refused Keep going detach after clearing the Goal and permits an explicit retry', async () => {
    const f = fixture();
    let refuseDetach = false;
    const actions = createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      automations: { ...f.deps.automations, reconcile: async (...args) => {
        if (refuseDetach) throw Object.assign(new Error('write_conflict'), { code: 'currentness_conflict' });
        return f.deps.automations.reconcile(...args);
      } } });
    const caller = { surface: 'mcp', authority: 'present_user' } as const;
    const added = await actions.sessionAdd({ sessionId: 'session-one',
      target: { kind: 'workflow', ref: 'builtin:keep-going' },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one',
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } } }, caller);
    let goalPresent = true;
    const boundary = f.executor(actions, { isActionApprovalRequired: () => false,
      sessionGoalClear: async () => { goalPresent = false; return { ok: true }; } });
    refuseDetach = true;
    const refused = await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, caller);
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(goalPresent).toBe(false);
    expect(f.rows.get(added.set.automationId)?.triggers).toHaveLength(1);
    refuseDetach = false;
    expect(await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, caller)).toMatchObject({ ok: true });
    expect(f.rows.get(added.set.automationId)?.triggers).toHaveLength(0);
  });
  it('retains Keep going when the native Goal clear refuses the mutation', async () => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const caller = { surface: 'ui', authority: 'present_user' } as const;
    const added = await actions.sessionAdd({ sessionId: 'session-one',
      target: { kind: 'workflow', ref: 'builtin:keep-going' },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one',
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } } }, caller);
    const boundary = f.executor(actions, { isActionApprovalRequired: () => false,
      sessionGoalClear: async () => ({ ok: false, errorCode: 'session_goal_control_unsupported', error: 'session_goal_control_unsupported' }) });
    expect(await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, caller))
      .toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
    expect(f.rows.get(added.set.automationId)?.triggers).toHaveLength(1);
  });
  it('keeps the Goal when the Workflow owner refuses the prerequisite trigger read', async () => {
    const f = fixture();
    let goalPresent = true;
    const boundary = createActionExecutor({ isActionApprovalRequired: () => false,
      workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => false,
        definitions: f.definitions, triggers: f.actions,
        runs: { execute: async () => { throw new Error('Unexpected Run write'); } } }),
      sessionGoalClear: async () => { goalPresent = false; return { ok: true }; } });
    expect(await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(goalPresent).toBe(true);
  });
  it('refuses compound Goal clear without a trigger owner before mutating the Goal', async () => {
    let goalPresent = true;
    const boundary = createActionExecutor({ isActionApprovalRequired: () => false,
      sessionGoalClear: async () => { goalPresent = false; return { ok: true }; } });
    expect(await boundary.execute('session.goal.clear', { sessionId: 'session-one' }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(goalPresent).toBe(true);
  });
  it.each(['plain', 'e2ee'] as const)('projects each retained %s receipt Event subject without creating an Environment lifecycle binding', async mode => {
    const f = fixture();
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    const host = createAccountWorkflowTriggerActions({ automations: f.deps.automations, resolveEncryption: async () => encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3), resolveWorkflow: f.deps.resolveWorkflow,
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` });
    for (const environmentId of ['production', 'staging']) {
      await host.add({ target: { kind: 'inline', definition }, project, trigger: {
        kind: 'pluginEvent', enabled: true, eventRef: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
        sourceInstanceId: `receipt-${environmentId}`, sourceContractVersion: 1,
        sourceConfig: { v: 1, serverId: 'home', environmentId, observingSince: 1 },
        displayLabel: environmentId, filter: null, maximumObservationAgeMs: null,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
          machineId: 'observer', pluginId: 'happier.machine.services', materializationId: 'services' } },
      } });
    }
    await host.add({ target: { kind: 'inline', definition }, project, trigger: {
      kind: 'pluginEvent', enabled: true, eventRef: { pluginId: 'happier.machine.services', localId: 'health-check-failed' },
      sourceInstanceId: 'production-health', sourceContractVersion: 1,
      sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: 'production' }, checks: [{
        checkId: 'http', kind: { pluginId: 'happier.machine.services', localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { url: 'https://app.test' }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 1,
      }] }, displayLabel: 'Production health', filter: null, maximumObservationAgeMs: null,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
        machineId: 'observer', pluginId: 'happier.machine.services', materializationId: 'services' } },
    } });
    const result = WorkflowTriggerListResultV1Schema.parse(await host.list({ scope: 'account_inline' }));
    expect(result.sets.map(set => set.triggers[0])).toEqual([
      expect.objectContaining({ subject: { kind: 'environment', environmentId: 'production' } }),
      expect.objectContaining({ subject: { kind: 'environment', environmentId: 'staging' } }),
      expect.objectContaining({ subject: { kind: 'environment', environmentId: 'production' } }),
    ]);
    for (const row of f.rows.values()) {
      expect(row.executionRecipe).not.toHaveProperty('deploymentEnvironment');
      expect(row.triggers[0]).not.toHaveProperty('subject');
    }
    const first = [...f.rows.values()][0]!;
    f.rows.set(first.id, { ...first, triggers: first.triggers.map(item => item.kind === 'pluginEvent'
      ? { ...item, triggerDefinitionEnvelope: 'unreadable' } : item) });
    const unreadable = await host.list({ scope: 'account_inline' });
    expect(unreadable.sets).toHaveLength(3);
    expect(unreadable.sets[0]!.triggers[0]).not.toHaveProperty('subject');
    await host.remove({ automationId: first.id });
    expect(f.rows.has(first.id)).toBe(false);
  });

  it.each(['input', 'literal'] as const)('reads missed schedules for backup targets bound from saved %s loop items', async kind => {
    const target = { serverId: 'home', environmentId: 'env', machineId: project.machineId,
      installationId: 'installation', targetLinkId: 'runtime', deploymentId: 'deployment', configRevision: 1 };
    const targets = [{ ...target, expectedRevision: 4 }, { ...target, deploymentId: 'second', expectedRevision: 4 }];
    const loop = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {},
      inputs: [{ name: 'targets', valueType: 'json', required: true }], blocks: [{ kind: 'loop', id: 'eachBackup',
        repetition: { kind: 'items', items: kind === 'input' ? { kind: 'input', name: 'targets' }
          : { kind: 'literal', value: targets }, execution: 'sequential', failurePolicy: 'fail_stop' },
        body: [{ kind: 'action', id: 'backup', actionId: 'deployments.backups.run',
          input: Object.fromEntries(Object.keys(targets[0]!).map(key => [key, { kind: 'item', field: 'value', path: [key] }])) }] }] });
    const f = fixture(loop);
    const saved = await f.actions.add({ workflow, project, inputs: { targets }, trigger });
    const executor = f.executor(f.actions);
    for (const deploymentId of ['deployment', 'second']) {
      expect(await executor.execute('workflow.trigger.list', { deploymentBackup: { ...target, deploymentId } }, ownCaller))
        .toMatchObject({ ok: true, result: { sets: [{ automationId: saved.set.automationId }] } });
    }
  });
  it('reads missed schedules for saved and inline backups by the actual bound backup Action target', async () => {
    const nightly = createNightlyBackupsWorkflowV1();
    const f = fixture(nightly);
    const target = { serverId: 'home', environmentId: 'env', machineId: project.machineId,
      installationId: 'installation', targetLinkId: 'runtime', deploymentId: 'deployment', configRevision: 1 };
    const inputs = { backupTarget: { ...target, expectedRevision: 4 }, retention: { kind: 'keep', last: 7 },
      verificationLevel: 'manifestReadBack' };
    const saved = await f.actions.add({ workflow, project, inputs, trigger });
    const inline = await f.actions.add({ target: { kind: 'inline', definition: nightly }, project,
      inputs: { ...inputs, backupTarget: { ...inputs.backupTarget, deploymentId: 'other' } }, trigger });
    await f.actions.add({ target: { kind: 'inline', definition: { ...definition,
      inputs: nightly.inputs } }, project, inputs, trigger });
    const executor = f.executor(f.actions);
    expect(await executor.execute('workflow.trigger.list', { deploymentBackup: target }, ownCaller))
      .toMatchObject({ ok: true, result: { sets: [{ automationId: saved.set.automationId }] } });
    expect(await executor.execute('workflow.trigger.list', { deploymentBackup: { ...target, deploymentId: 'other' } }, ownCaller))
      .toMatchObject({ ok: true, result: { sets: [{ automationId: inline.set.automationId }] } });
    for (const key of ['environmentId', 'machineId', 'installationId', 'targetLinkId', 'deploymentId', 'configRevision'] as const) {
      expect(await executor.execute('workflow.trigger.list', { deploymentBackup: { ...target,
        [key]: key === 'configRevision' ? 2 : 'unrelated' } }, ownCaller))
        .toMatchObject({ ok: true, result: { sets: [] } });
    }
    const nested = await f.actions.add({ target: { kind: 'inline', definition: { version: 1,
      defaults: {}, inputs: nightly.inputs, blocks: [{ kind: 'workflow', id: 'savedBackup', workflowRef: workflow,
        input: Object.fromEntries(nightly.inputs.map(field => [field.name, { kind: 'input' as const, name: field.name }])) }] } },
      project, inputs: { ...inputs, backupTarget: { ...inputs.backupTarget, deploymentId: 'nested' } }, trigger });
    expect(await executor.execute('workflow.trigger.list', { deploymentBackup: { ...target, deploymentId: 'nested' } }, ownCaller))
      .toMatchObject({ ok: true, result: { sets: [{ automationId: nested.set.automationId }] } });
  });

  it('reads missed schedules from the saved due cursor and actual last started Run through the Action executor', async () => {
    const f = fixture();
    const added = await f.actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = f.rows.get(added.set.automationId)!;
    const schedule = row.triggers.find(item => item.kind === 'schedule')!;
    if (schedule.kind !== 'schedule') throw new Error('Expected a saved schedule');
    const dueAt = Date.now() - 60_000;
    f.rows.set(row.id, { ...row, lastRunAt: dueAt - 1,
      triggers: [{ ...schedule, nextRunAt: dueAt }] });
    const executor = f.executor(f.actions);
    const read = () => executor.execute('workflow.trigger.list', { scope: 'account_inline' }, ownCaller);
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [{
      triggerId: schedule.id, dueAt, lastRunAt: dueAt - 1,
    }] }] } });
    f.rows.set(row.id, { ...f.rows.get(row.id)!, lastRunAt: dueAt });
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [] }] } });
    f.rows.set(row.id, { ...f.rows.get(row.id)!, lastRunAt: null,
      triggers: [{ ...schedule, nextRunAt: dueAt, enabled: false }] });
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [] }] } });
    f.rows.set(row.id, { ...f.rows.get(row.id)!,
      triggers: [{ ...schedule, nextRunAt: Date.now() + 86_400_000 }] });
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [] }] } });
    f.rows.set(row.id, { ...f.rows.get(row.id)!,
      triggers: [{ ...schedule, nextRunAt: dueAt }] });
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [{
      triggerId: schedule.id, dueAt, lastRunAt: null,
    }] }] } });
    f.rows.set(row.id, { ...f.rows.get(row.id)!, enabled: false });
    expect(await read()).toMatchObject({ ok: true, result: { sets: [{ missedSchedules: [] }] } });
  });
  it('carries the Account Workflow name and ordering fact from the admitted record', async () => {
    const f = fixture();
    const added = await f.actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = f.rows.get(added.set.automationId)!;
    f.rows.set(row.id, { ...row, name: 'Renamed review', updatedAt: 42 });
    const current = await f.actions.list({ scope: 'account_inline' });
    expect(current.sets).toMatchObject([{ automationId: row.id, name: 'Renamed review', updatedAt: 42 }]);
  });
  it('carries no name for an Account Workflow nobody named, so readers name it by what it runs', async () => {
    const f = fixture();
    const added = await f.actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const current = await f.actions.list({ scope: 'account_inline' });
    expect(current.sets.map(set => set.automationId)).toEqual([added.set.automationId]);
    expect(current.sets[0]).not.toHaveProperty('name');
  });
  it('projects the current saved definition rather than the trigger author or a frozen occurrence', async () => {
    const f = fixture();
    f.saveSourceAs({ kind: 'person', accountId: 'owner' }, 100);
    const added = await f.actions.add({ workflow, project, trigger });
    expect(added.set).toMatchObject({ sourceSavedBy: { kind: 'person', accountId: 'owner' }, sourceSavedAt: 100 });
    f.saveSourceAs({ kind: 'person', accountId: 'later-editor' }, 200);
    const current = await f.actions.list({ workflow });
    expect(current.sets[0]).toMatchObject({
      sourceSavedBy: { kind: 'person', accountId: 'later-editor' }, sourceSavedAt: 200,
    });
    expect(current.sets[0]?.automationId).toBe(added.set.automationId);
    f.saveSourceAs(undefined, 300);
    const unknown = await f.actions.list({ workflow });
    expect(unknown.sets[0]).not.toHaveProperty('sourceSavedBy');
  });
});

describe('person-saved exact-input trigger consent', () => {
  it('retains an inherited trigger profile through deferred review by a person with another profile', async () => {
    const f = fixture();
    let approval: ApprovalRequest | null = null;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'workflow.trigger.add': { approvalRequiredSurfaces: ['ui'] } } });
    const executor = f.executor(f.actions, {
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'profile-review' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      runtimeAccountId: 'owner', actionRequestId: 'trigger-profile-review', actionCaller: { kind: 'host' as const },
      approvalProfileId: 'builtin:apply-safe' };
    expect(await executor.execute('workflow.trigger.add', { workflow, project, trigger }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.size).toBe(0);
    expect(await executor.execute('approval.request.decide', { artifactId: 'profile-review', decision: 'approve' },
      { ...context, actionRequestId: 'decision', approvalProfileId: 'builtin:full-trust' })).toMatchObject({ ok: true });
    const terminal = ApprovalRequestV2Schema.parse(approval);
    expect(terminal).toMatchObject({ status: 'executed', execution: { ok: true } });
    if (!terminal.execution?.ok) throw new Error('Expected the approved trigger receipt');
    const receipt = WorkflowTriggerWriteResultV1Schema.parse(terminal.execution.result);
    expect((await f.actions.list({ workflow })).sets.find(set => set.automationId === receipt.set.automationId)?.context)
      .toHaveProperty('approvalProfileId', 'builtin:apply-safe');
  });
  it.each(['profile:review', null] as const)('inherits an omitted trigger profile only when creating its saved context (%s)', async approvalProfileId => {
    const f = fixture();
    const input = WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger });
    const saved = await f.actions.add(input, { surface: 'cli', authority: 'present_user', approvalProfileId });
    expect(saved.set.context).toHaveProperty('approvalProfileId', approvalProfileId);
    const extended = await f.actions.add(input, { surface: 'cli', authority: 'present_user', approvalProfileId: 'profile:other' });
    expect(extended.set.context).toHaveProperty('approvalProfileId', approvalProfileId);
    expect(extended.set.triggers).toHaveLength(2);
  });
  it.each(['profile:other', null] as const)('applies an explicit profile when adding to an existing Workflow trigger set (%s)', async approvalProfileId => {
    const f = fixture();
    await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger, approvalProfileId: 'profile:review' }));
    const extended = await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger, approvalProfileId }));
    expect(extended.set.context).toHaveProperty('approvalProfileId', approvalProfileId);
    expect((await f.actions.list({ workflow })).sets[0]?.context).toHaveProperty('approvalProfileId', approvalProfileId);
  });
  it('stores only the selected approval profile reference and preserves explicit detach on update', async () => {
    const f = fixture();
    const input = WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger, approvalProfileId: 'profile:review' });
    const saved = await f.actions.add(input);
    expect(saved.set.context).toMatchObject({ approvalProfileId: 'profile:review' });
    const reloaded = await f.actions.list({ workflow });
    expect(reloaded.sets[0]?.context).toMatchObject({ approvalProfileId: 'profile:review' });
    const detached = await f.actions.update(WorkflowTriggerUpdateRequestV1Schema.parse({
      automationId: saved.set.automationId, expectedRevision: saved.set.revision, patch: { approvalProfileId: null },
    }));
    expect(detached.set.context).toMatchObject({ approvalProfileId: null });
    expect(WorkflowTriggerAddRequestV1Schema.safeParse({ workflow, project, trigger,
      approvalProfileId: { id: 'profile:review', defaultMode: 'allow' } }).success).toBe(false);
  });
  it.each(['plain', 'e2ee'] as const)('reapproves a saved trigger through the exact child of a reviewed Move for %s', async mode => {
    const f = fixture(deploymentWorkflowDefinition());
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    const host = { automations: f.deps.automations, resolveWorkflow: f.deps.resolveWorkflow,
      resolveEncryption: async () => encryption, randomBytes: (length: number) => new Uint8Array(length).fill(3),
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } };
    const actions = createAccountWorkflowTriggerActions(host);
    const saved = await actions.add({ target: { kind: 'inline', definition: deploymentWorkflowDefinition() }, project, trigger: deploymentEventTrigger,
      deployment: {}, actionApproval: 'ask' });
    const child = { action: 'workflow.trigger.update' as const, role: 'trigger-reapproval', input: {
      automationId: saved.set.automationId, triggerId: saved.triggerId!, expectedRevision: saved.set.revision,
      patch: { actionApproval: 'automatic' as const },
    } };
    const input = { serverId: 'home', sourceId: 'source', expectedRevision: 1, teamId: 'team', requestKey: 'move' };
    const executor = f.executor(actions, {
      prepareHostReviewedChildren: async request => request.actionId === 'projects.sources.moveToTeam'
        ? { children: [child] } : null,
      projectSourcesMoveToTeam: async (_input, context) => {
        const port = context.hostReviewedChild!;
        expect(await port.invoke({ ...child, role: 'another-trigger' }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(await port.invoke({ ...child, input: { ...child.input, triggerId: 'another-trigger' } }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        // Root review facts survive JSON; the issuer's child evidence does not.
        await expect(actions.update(child.input, JSON.parse(JSON.stringify(context))))
          .rejects.toMatchObject({ code: 'approval_required' });
        const result = await port.invoke(child);
        if (!result.ok) return result;
        const written = WorkflowTriggerWriteResultV1Schema.parse(result.result);
        expect(written.set.context?.actionApprovals).toMatchObject([{ triggerId: saved.triggerId,
          operation: { approvedBy: { accountId: 'owner' }, parent: { actionId: child.action, input: child.input } } }]);
        return { kind: 'partial', childOperations: [] };
      },
    });
    const context: ActionExecutorContext = {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
      serverId: 'home', actionRequestId: 'move', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      presentUserConfirmation: { actionId: 'projects.sources.moveToTeam', accountId: 'owner', serverId: 'home',
        requestId: 'move', inputDigest: computeActionInputApprovalDigestV1('projects.sources.moveToTeam', input) },
    };
    expect(await executor.execute('projects.sources.moveToTeam', input, context))
      .toEqual({ ok: true, result: { kind: 'partial', childOperations: [] } });
    const reloaded = createAccountWorkflowTriggerActions(host);
    expect((await reloaded.list({ scope: 'account_all' })).sets[0]?.context?.actionApprovals)
      .toMatchObject([{ triggerId: saved.triggerId, operation: { approvedBy: { accountId: 'owner' } } }]);
    const abort = new AbortController();
    abort.abort();
    expect(await executor.execute('projects.sources.moveToTeam', input, { ...context, signal: abort.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('does not lend a reviewed Move from another Account to the captured trigger owner', async () => {
    const f = fixture(deploymentWorkflowDefinition());
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } });
    const saved = await actions.add({ workflow, project, trigger: deploymentEventTrigger,
      deployment: {}, actionApproval: 'ask' });
    const child = { action: 'workflow.trigger.update' as const, role: 'trigger-reapproval', input: {
      automationId: saved.set.automationId, triggerId: saved.triggerId!, expectedRevision: saved.set.revision,
      patch: { actionApproval: 'automatic' as const },
    } };
    const input = { serverId: 'home', sourceId: 'source', expectedRevision: 1, teamId: 'team', requestKey: 'foreign-move' };
    const executor = f.executor(actions, {
      prepareHostReviewedChildren: async request => request.actionId === 'projects.sources.moveToTeam' ? { children: [child] } : null,
      projectSourcesMoveToTeam: async (_input, context) => {
        const result = await context.hostReviewedChild!.invoke(child);
        return result.ok ? { kind: 'partial', childOperations: [] } : result;
      },
    });
    expect(await executor.execute('projects.sources.moveToTeam', input, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'foreign',
      serverId: 'home', actionRequestId: 'foreign-move', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      presentUserConfirmation: { actionId: 'projects.sources.moveToTeam', accountId: 'foreign', serverId: 'home',
        requestId: 'foreign-move', inputDigest: computeActionInputApprovalDigestV1('projects.sources.moveToTeam', input) },
    })).toMatchObject({ ok: false, errorCode: 'approval_required' });
    expect((await actions.list({ scope: 'account_all' })).sets[0]?.context).not.toHaveProperty('actionApprovals');
  });

  it('stores exact materialised service commands through the person Save and withdraws them through Ask or disable', async () => {
    const command = { serverId: 'home', machineId: project.machineId,
      target: { kind: 'current', serviceId: 'app', expectedGeneration: 'generation-one' },
      mode: 'exec', argv: ['app', 'scheduled-task'] };
    const source = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [], blocks: [
      { kind: 'action', id: 'command', actionId: 'machines.services.exec',
        input: Object.fromEntries(Object.entries(command).map(([key, value]) => [key, { kind: 'literal', value }])) },
    ] });
    const f = fixture(source);
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-exact-command' };
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true },
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } }),
    });
    const request = Object.assign({ workflow, project, trigger }, { actionApproval: 'automatic' as const });
    const saved = await actions.add(request, caller);
    expect(saved.set.context).toMatchObject({ actionApprovals: [{ triggerId: saved.triggerId,
      operation: { approvedBy: { accountId: 'owner' }, parent: { actionId: 'workflow.trigger.add', input: request },
        steps: [{ actionId: 'machines.services.exec', input: command }] } }] });
    const approval = saved.set.context?.actionApprovals?.[0];
    const savedTriggerId = saved.triggerId;
    if (!approval || !savedTriggerId) throw new Error('Exact saved operation required');
    const current = async (operation = approval.operation, triggerId = savedTriggerId) => await actions.readSavedConsent({
      automationId: saved.set.automationId, triggerId, ownerAccountId: 'owner', operation,
    }, caller) !== null;
    expect(await current()).toBe(true);
    expect(await current({ ...approval.operation, steps: [{ actionId: 'machines.services.exec',
      input: { ...command, argv: ['app', 'different-task'] } }] })).toBe(false);
    expect(await current({ ...approval.operation, steps: [{ actionId: 'machines.services.control', input: command }] })).toBe(false);
    expect(await current(approval.operation, AutomationTriggerIdSchema.parse('another-trigger'))).toBe(false);
    expect(WorkflowTriggerAddRequestV1Schema.safeParse({ ...request, actionApprovals: [approval] }).success).toBe(false);
    expect(f.rows.size).toBe(1);
    await expect(actions.add(request, { ...caller, authority: 'account_automation' }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(f.rows.size).toBe(1);
    const ask = await actions.update(Object.assign({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: saved.set.revision }, { patch: { actionApproval: 'ask' } }), caller);
    expect(ask.set.context).not.toHaveProperty('actionApprovals');
    expect(await current()).toBe(false);
    const again = await actions.update(Object.assign({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: ask.set.revision }, { patch: { actionApproval: 'automatic' } }), caller);
    expect(again.set.context).toHaveProperty('actionApprovals');
    const disabled = await actions.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: again.set.revision, patch: { enabled: false } }, caller);
    expect(disabled.set.context).not.toHaveProperty('actionApprovals');
    expect(await current()).toBe(false);
  });
});

function deploymentWorkflowDefinition() {
  const effect = { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' };
  return WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [
    { name: 'sha', valueType: 'string', required: true }, { name: 'requestKey', valueType: 'string', required: true },
  ], blocks: [{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy', input: {
    ...Object.fromEntries(Object.entries(effect).map(([key, value]) => [key, { kind: 'literal', value }])),
    sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' },
  } }] });
}

const deploymentEventTrigger = { kind: 'pluginEvent' as const, enabled: true,
  eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
  sourceInstanceId: 'repo-source', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
  observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
    machineId: project.machineId, materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
  filter: null, maximumObservationAgeMs: null };

describe('Account source watcher assignment', () => {
  it.each(['plain', 'e2ee'] as const)('updates a person-chosen %s platform observation period without replacing its enrollment or checkpoint identity', async mode => {
    const f = fixture();
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    const params = { automations: f.deps.automations, resolveEncryption: async () => encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3), resolveWorkflow: f.deps.resolveWorkflow,
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` };
    const host = createAccountWorkflowTriggerActions(params);
    const pluginId = 'happier.deploy.cloudflare';
    const credentialPrincipal = { kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId, localId: 'selection' }, purpose: 'action-account' },
      target: { kind: 'account', account: { service: { pluginId, localId: 'account' }, accountId: 'provider-owner' } } };
    const sourceConfig = { v: 1, serverId: 'home', environmentId: 'production', targetLinkId: 'runtime', credentialPrincipal,
      observingSince: 100 };
    const event = { ...deploymentEventTrigger, eventRef: { pluginId, localId: 'deployment-failure-transition-v1' },
      sourceInstanceId: 'platform:home:production:runtime', sourceConfig, displayLabel: 'Production platform',
      observationTransport: { kind: 'checkpointedPull' as const,
        watcherMaterializationRef: { pluginId, machineId: 'controller', materializationId: 'cloudflare-installed' } } };
    const enrollment = { observationOnly: { kind: 'observationOnly' as const,
      deploymentEnvironment: { serverId: 'home', projectSourceId: 'project', environmentId: 'production' } }, trigger: event };
    const first = await host.add(enrollment);
    const before = f.rows.get(first.set.automationId)!.triggers[0]!;
    if (before.kind !== 'pluginEvent') throw new Error('Expected platform Event enrollment');
    const { enabled: _enabled, ...replacement } = event;
    const periodMs = 600_000;
    const updated = await host.update({ automationId: first.set.automationId, triggerId: first.triggerId,
      expectedRevision: first.set.revision, patch: { trigger: { ...replacement, sourceConfig: { ...sourceConfig, periodMs } } } });
    const after = f.rows.get(first.set.automationId)!.triggers[0]!;
    if (after.kind !== 'pluginEvent') throw new Error('Expected retained platform Event enrollment');
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
      ...(isAvailableE2eeAutomationAccountEncryptionV1(encryption)
        ? { mode: 'e2ee' as const, material: encryption.material.material } : { mode: 'plain' as const }),
      binding: { v: 1, automationId: first.set.automationId, triggerId: after.id, triggerRevision: after.revision,
        triggerKind: 'pluginEvent', eventRef: after.eventRef, sourceSelectorId: after.sourceSelectorId },
      envelope: JSON.parse(after.triggerDefinitionEnvelope),
    });
    expect(opened).toMatchObject({ kind: 'available', definition: { sourceInstanceId: event.sourceInstanceId,
      sourceConfig: { ...sourceConfig, periodMs } } });
    expect(after).toMatchObject({ id: before.id, sourceSelectorId: before.sourceSelectorId,
      sourceContractVersion: before.sourceContractVersion, observation: before.observation });
    expect(updated.set.automationId).toBe(first.set.automationId);
    const retained = structuredClone(f.rows.get(first.set.automationId));
    expect(updated).not.toHaveProperty('triggerDefinition');
    const replay = await createAccountWorkflowTriggerActions(params).add({ ...enrollment, includeEventDefinition: true });
    expect(replay).toMatchObject({ triggerId: first.triggerId, set: { automationId: first.set.automationId, revision: updated.set.revision } });
    expect(f.rows.size).toBe(1);
    expect(f.rows.get(first.set.automationId)).toEqual(retained);
    const expectedDefinition = { v: 1, sourceInstanceId: event.sourceInstanceId, sourceConfig: { ...sourceConfig, periodMs },
      displayLabel: event.displayLabel, filter: null, maximumObservationAgeMs: null };
    expect(replay).toMatchObject({ triggerDefinition: { triggerId: first.triggerId, definition: expectedDefinition } });
    const detail = await host.list({ automationId: first.set.automationId, triggerId: first.triggerId! });
    expect(detail).toMatchObject({ sets: [{ automationId: first.set.automationId }],
      triggerDefinition: { triggerId: first.triggerId, definition: expectedDefinition } });
    expect(await host.list({ scope: 'account_all' })).not.toHaveProperty('triggerDefinition');
    await expect(host.list({ automationId: 'missing', triggerId: first.triggerId! })).rejects.toBeDefined();
    await expect(host.list({ automationId: first.set.automationId, triggerId: 'missing' })).rejects.toBeDefined();
    if (mode === 'e2ee') expect(after.triggerDefinitionEnvelope).not.toContain('provider-owner');
  });

  it.each(['plain', 'e2ee'] as const)('shares one %s source watcher across Event declarations and refuses competing assignments before persistence', async mode => {
    const f = fixture();
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    const params = { automations: f.deps.automations, resolveEncryption: async () => encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3), resolveWorkflow: f.deps.resolveWorkflow,
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` };
    const host = createAccountWorkflowTriggerActions(params);
    const first = await host.add({ observationOnly: { kind: 'observationOnly' }, name: 'Primary observer', trigger: deploymentEventTrigger });
    // Different declarations/consumers of one native source share its watcher.
    const siblingTrigger = { ...deploymentEventTrigger, eventRef: { ...deploymentEventTrigger.eventRef, localId: 'issues/resolved' } };
    const sibling = await createAccountWorkflowTriggerActions(params).add({ observationOnly: { kind: 'observationOnly' },
      name: 'Recovery observer', trigger: siblingTrigger });
    expect(f.rows.size).toBe(2);
    for (const replacement of [
      { ...deploymentEventTrigger.observationTransport.watcherMaterializationRef, machineId: 'another-machine' },
      { ...deploymentEventTrigger.observationTransport.watcherMaterializationRef, materializationId: 'another-installation' },
    ]) {
      const competing = { ...deploymentEventTrigger, observationTransport: { kind: 'checkpointedPull' as const,
        watcherMaterializationRef: replacement } };
      const { enabled, ...replacementTrigger } = competing;
      await expect(host.add({ observationOnly: { kind: 'observationOnly' }, name: 'Competing observer', trigger: competing }))
        .rejects.toMatchObject({ code: 'invalid_input' });
      await expect(host.update({ automationId: sibling.set.automationId, triggerId: sibling.triggerId,
        expectedRevision: sibling.set.revision, patch: { enabled, trigger: replacementTrigger } }))
        .rejects.toMatchObject({ code: 'invalid_input' });
      expect(f.rows.size).toBe(2);
    }
    // The assignment rule does not replace the pre-existing private config rule.
    await expect(host.add({ observationOnly: { kind: 'observationOnly' }, trigger: { ...deploymentEventTrigger,
      sourceConfig: { repositoryId: 'different' } } })).rejects.toMatchObject({ code: 'invalid_input' });
    await host.update({ automationId: first.set.automationId, triggerId: first.triggerId,
      expectedRevision: first.set.revision, patch: { enabled: false } });
    expect(f.rows.get(first.set.automationId)?.triggers[0]?.enabled).toBe(false);
    expect(f.rows.get(sibling.set.automationId)?.triggers[0]?.enabled).toBe(true);
  });
});

describe('person-saved deployment trigger consent', () => {
  it('saves the exact compact SHA consent when the authored deployment omits a target link', async () => {
    const base = deploymentWorkflowDefinition();
    const source = WorkflowDefinitionV1Schema.parse({ ...base, blocks: base.blocks.map(block => {
      if (block.kind !== 'action') return block;
      const { targetLinkId: _selectedAtAdmission, ...input } = block.input;
      return { ...block, input };
    }) });
    const f = fixture(source);
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } });
    const saved = await actions.add({ workflow, project, trigger: deploymentEventTrigger, deployment: {}, actionApproval: 'automatic' },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
        serverId: 'home', actionRequestId: 'save-compact-trigger' });
    expect(saved.set.context?.actionApprovals?.[0]?.operation.steps).toEqual([{ actionId: 'deployments.deploy',
      input: { serverId: 'home', environmentId: 'staging', whenBusy: 'supersede' }, binding: { kind: 'deployment_sha' } }]);
  });

  it('prepares initial deployment defaults once and retains saved Automatic after Production becomes the new default', async () => {
    const f = fixture(deploymentWorkflowDefinition());
    const header = DeploymentEnvironmentHeaderV1Schema.parse({ v: 1, id: 'staging', serverId: 'home', projectSourceId: 'source', revision: 1,
      owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      controllerMachineId: project.machineId, runtimeTargetLinkId: 'runtime', contentArtifactId: 'environment-content',
      contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
      capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true } });
    const reads: unknown[] = [];
    const actions = createWorkflowTriggerActions(Object.assign({}, f.deps, {
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true },
      // Authenticated Environment metadata transport is the only boundary.
      deploymentAction: async (actionId: string, input: unknown) => {
        reads.push({ actionId, input });
        return { ok: true, environment: structuredClone(header), targetLinks: [] };
      },
    }));
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-initial-default' };
    const request = { workflow, project, trigger: deploymentEventTrigger, deployment: {} };
    const automatic = await actions.add(request, caller);
    const approval = automatic.set.context?.actionApprovals?.find(row => row.triggerId === automatic.triggerId);
    if (!approval || !automatic.triggerId) throw new Error('Non-production default must save Automatic');
    expect(reads).toEqual([{ actionId: 'deployments.environments.get', input: { serverId: 'home', environmentId: 'staging' } }]);
    header.protection = 'production';
    const ask = await actions.add(request, caller);
    expect(ask.set.context?.actionApprovals?.some(row => row.triggerId === ask.triggerId)).not.toBe(true);
    expect(reads).toHaveLength(2);
    const sourceReads = f.definitionReads();
    for (let phase = 0; phase < 2; phase++) expect(await actions.readSavedConsent({ automationId: automatic.set.automationId,
      triggerId: automatic.triggerId, ownerAccountId: 'owner', operation: approval.operation }, caller)).toEqual(approval.operation);
    expect(reads).toHaveLength(2);
    expect(f.definitionReads()).toBe(sourceReads);
    const explicit = await actions.add({ ...request, actionApproval: 'automatic' }, caller);
    expect(explicit.set.context?.actionApprovals?.some(row => row.triggerId === explicit.triggerId)).toBe(true);
    expect(reads).toHaveLength(2);
  });

  it.each(['omitted-default', 'nested-update'] as const)('preserves the current-dev %s saved proof across rewrite and withdraws it through the ordinary non-SHA input update', async legacyShape => {
    const base = deploymentWorkflowDefinition();
    const source = WorkflowDefinitionV1Schema.parse({ ...base,
      inputs: [...base.inputs, { name: 'link', valueType: 'string', required: true }],
      blocks: base.blocks.map(block => block.kind === 'action' ? { ...block,
        input: { ...block.input, targetLinkId: { kind: 'input', name: 'link' } } } : block) });
    const f = fixture(source);
    const nativeAccount = { accountId: 'owner', serverId: 'home', isCurrent: async () => true };
    const actions = createWorkflowTriggerActions({ ...f.deps, nativeAccount });
    const caller: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'legacy-trigger-save' };
    let saved = await actions.add({ workflow, project, trigger: deploymentEventTrigger, deployment: {},
      inputs: { link: 'runtime' }, actionApproval: 'automatic' }, caller);
    const triggerId = saved.triggerId;
    if (!triggerId || !saved.set.context) throw new Error('Saved trigger required');
    if (legacyShape === 'nested-update') saved = await actions.update({ automationId: saved.set.automationId,
      triggerId, expectedRevision: saved.set.revision, patch: { actionApproval: 'automatic' } }, caller);
    const produced = saved.set.context?.actionApprovals?.find(row => row.triggerId === triggerId)?.operation;
    if (!produced) throw new Error('Real person Save required');
    // Provenance: the pre-O4 workflowDeploymentConsent producer emitted these
    // raw stored forms. Current public authoring no longer parses its renamed
    // input, so keep that historical representation at the persistence boundary.
    // Its update did not repeat inherited inputs; ordinary input edits withdrew proof.
    const { actionApproval: _currentChoice, ...omittedDefault } = produced.parent.input;
    const legacy = { ...produced, steps: [], parent: legacyShape === 'nested-update'
      ? { actionId: 'workflow.trigger.update', input: { ...produced.parent.input, patch: { deployApproval: 'automatic' } } }
      : { actionId: 'workflow.trigger.add', input: omittedDefault } };
    const row = f.rows.get(saved.set.automationId)!;
    if (row.executionRecipe?.v !== 2) throw new Error('Workflow recipe required');
    const { actionApprovals: _currentRepresentation, ...legacyContext } = saved.set.context!;
    row.executionRecipe = { ...row.executionRecipe, workflow: { t: 'plain', v: { ...legacyContext,
      deploymentTriggers: [{ triggerId, approval: { savedFor: { automationId: row.id, triggerId },
        savedBy: { kind: 'person', accountId: 'owner' }, operation: legacy,
        basis: { variables: { LOG_LEVEL: 'before-change' }, protection: 'nonProduction' },
        program: { definition: source, children: {} } } }],
    } } };
    const read = () => actions.readSavedConsent({ automationId: row.id, triggerId, ownerAccountId: 'owner', operation: legacy }, caller);
    expect(await read()).toMatchObject({ parent: legacy.parent, approvedBy: { accountId: 'owner' }, steps: [{
      actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' },
      binding: { kind: 'deployment_sha' },
    }] });
    const { enabled: _enabledAtEnrollment, ...retainedEvent } = deploymentEventTrigger;
    const rewritten = await actions.update({ automationId: row.id, triggerId, expectedRevision: row.templateVersion,
      patch: { trigger: retainedEvent } }, caller);
    expect(rewritten.set.context?.deploymentTriggers?.[0]).not.toHaveProperty('approval');
    // An already-accepted Run still carries the original empty-step proof.
    // Rewriting the retained row must not renew or withdraw that same consent.
    expect(await read()).toMatchObject({ parent: legacy.parent, approvedBy: { accountId: 'owner' } });
    const changed = await actions.update({ automationId: row.id, triggerId, expectedRevision: rewritten.set.revision,
      patch: { inputs: { link: 'unreviewed-target' } } }, caller);
    expect(changed.set.context).not.toHaveProperty('actionApprovals');
    expect(changed.set.context?.deploymentTriggers?.[0]).not.toHaveProperty('approval');
    expect(await read()).toBeNull();
  });

  it('saves only the selected exact operation, varies its SHA, and holds changed non-SHA operands', async () => {
    const f = fixture(deploymentWorkflowDefinition());
    let accountCurrent = true;
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => accountCurrent } });
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-automatic-deployment' };
    const request = { workflow, project, trigger: deploymentEventTrigger, deployment: { branch: 'main' },
      actionApproval: 'automatic' as const };
    const saved = await actions.add(request, caller);
    const approval = saved.set.context?.actionApprovals?.[0];
    const triggerId = saved.triggerId;
    if (!approval || !triggerId) throw new Error('Saved Automatic operation required');
    const exactInput = { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' };
    expect(saved.set.context).toMatchObject({
      deploymentTriggers: [{ triggerId, branch: 'main' }],
      actionApprovals: [{ triggerId, operation: { parent: { actionId: 'workflow.trigger.add', input: request },
        approvedBy: { accountId: 'owner' },
        steps: [{ actionId: 'deployments.deploy', input: exactInput, binding: { kind: 'deployment_sha' } }] } }],
    });
    expect(saved.set.context?.deploymentTriggers?.[0]).not.toHaveProperty('approval');
    const current = async (operation = approval.operation) => await actions.readSavedConsent({
      automationId: saved.set.automationId, triggerId, ownerAccountId: 'owner', operation }, caller) !== null;
    expect(await current()).toBe(true);
    for (const changed of [
      { targetLinkId: 'another-link' }, { environmentId: 'another-environment' },
      { serverId: 'another-home' }, { whenBusy: 'refuse' },
    ]) expect(await current({ ...approval.operation, steps: [{ ...approval.operation.steps[0]!,
      input: { ...exactInput, ...changed } }] })).toBe(false);
    expect(await actions.readSavedConsent({ automationId: saved.set.automationId, triggerId,
      ownerAccountId: 'another-owner', operation: approval.operation }, caller)).toBeNull();
    expect(await actions.readSavedConsent({ automationId: saved.set.automationId, triggerId: 'foreign-trigger',
      ownerAccountId: 'owner', operation: approval.operation }, caller)).toBeNull();
    expect(WorkflowTriggerAddRequestV1Schema.safeParse({ ...request, actionApprovals: [approval] }).success).toBe(false);
    expect(WorkflowTriggerAddRequestV1Schema.safeParse({ ...request, deployApproval: 'automatic' }).success).toBe(false);
    for (const untrusted of [
      { ...caller, authority: 'account_automation' as const },
      { ...caller, runtimeAccountId: 'another-person' },
      { ...caller, approvedActionReplay: { artifactId: 'foreign-replay', origin: {
        surface: 'ui' as const, accountId: 'another-person', caller: { kind: 'host' as const } } } },
    ]) {
      await expect(actions.add(request, untrusted)).rejects.toMatchObject({ code: 'approval_required' });
      expect(f.rows.size).toBe(1);
    }
    accountCurrent = false;
    await expect(actions.add(request, caller)).rejects.toMatchObject({ code: 'approval_required' });
    accountCurrent = true;
    const ask = await actions.update({ automationId: saved.set.automationId, triggerId,
      expectedRevision: saved.set.revision, patch: { actionApproval: 'ask' } }, caller);
    expect(ask.set.context).not.toHaveProperty('actionApprovals');
    expect(ask.set.context?.deploymentTriggers).toEqual([{ triggerId, branch: 'main' }]);
    expect(await current()).toBe(false);
    const again = await actions.update({ automationId: saved.set.automationId, triggerId,
      expectedRevision: ask.set.revision, patch: { actionApproval: 'automatic' } }, caller);
    const disabled = await actions.update({ automationId: saved.set.automationId, triggerId,
      expectedRevision: again.set.revision, patch: { enabled: false } }, caller);
    expect(disabled.set.context).not.toHaveProperty('actionApprovals');
    expect(await current()).toBe(false);
    const { actionApproval: _choice, ...ordinarySave } = request;
    const ordinary = await actions.add({ ...ordinarySave, actionApproval: 'ask' }, caller);
    expect(ordinary.set.context?.actionApprovals).toBeUndefined();
    const automated = await actions.add(ordinarySave, { ...caller, authority: 'account_automation' });
    expect(automated.set.context?.actionApprovals).toBeUndefined();
  });

  it('retires saved proof when trigger execution operands or deployment routing change', async () => {
    const f = fixture(deploymentWorkflowDefinition());
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } });
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-context-proof' };
    const saved = await actions.add({ workflow, project, trigger: deploymentEventTrigger, deployment: {},
      actionApproval: 'automatic' }, caller);
    const changed = await actions.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: saved.set.revision, patch: { inputs: { sha: 'a'.repeat(40), requestKey: 'changed-context' } } }, caller);
    expect(changed.set.context).not.toHaveProperty('actionApprovals');
    const again = await actions.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: changed.set.revision, patch: { actionApproval: 'automatic' } }, caller);
    const rerouted = await actions.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: again.set.revision, patch: { deployment: { branch: 'release' } } }, caller);
    expect(rerouted.set.context).not.toHaveProperty('actionApprovals');
  });

  it('retires only disabled siblings when another trigger resumes a paused container', async () => {
    const f = fixture(deploymentWorkflowDefinition());
    const actions = createWorkflowTriggerActions({ ...f.deps,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } });
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-sibling' };
    const request = { workflow, project, trigger: deploymentEventTrigger, deployment: {} };
    const automatic = await actions.add({ ...request, actionApproval: 'automatic' }, caller);
    const ask = await actions.add({ ...request, actionApproval: 'ask' }, caller);
    const row = f.rows.get(ask.set.automationId);
    if (!row) throw new Error('Saved Automation required');
    // A native container pause does not itself edit the saved trigger choice.
    f.rows.set(row.id, { ...row, enabled: false });
    const resumed = await actions.update({ automationId: row.id, triggerId: ask.triggerId,
      expectedRevision: row.templateVersion, patch: { enabled: true } }, caller);
    expect(resumed.set.triggers.find(item => item.id === automatic.triggerId)?.enabled).toBe(false);
    expect(resumed.set.context).not.toHaveProperty('actionApprovals');
    expect(resumed.set.context?.deploymentTriggers).toEqual([
      { triggerId: automatic.triggerId }, { triggerId: ask.triggerId },
    ]);
  });

  it.each(['plain', 'e2ee'] as const)('saves and reloads one private proof through the real %s Account codec', async mode => {
    const f = fixture();
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let current = true;
    let failSave = false;
    let nextId = 0;
    const params = { automations: { ...f.deps.automations, create: async (...args: Parameters<typeof f.deps.automations.create>) => {
      if (failSave) throw Object.assign(new Error('write_conflict'), { code: 'currentness_conflict' });
      return f.deps.automations.create(...args);
    } }, resolveEncryption: async () => encryption, randomBytes: (length: number) => new Uint8Array(length).fill(3),
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`, resolveWorkflow: f.deps.resolveWorkflow,
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => current } };
    const caller: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'private-trigger-save' };
    const request = { target: { kind: 'inline' as const, definition: deploymentWorkflowDefinition() }, project,
      trigger: deploymentEventTrigger, deployment: {}, actionApproval: 'automatic' as const };
    const saved = await createAccountWorkflowTriggerActions(params).add(request, caller);
    expect(f.rows.get(saved.set.automationId)?.executionRecipe).toMatchObject({ workflow: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
    const reloaded = createAccountWorkflowTriggerActions(params);
    const context = (await reloaded.list({ scope: 'account_inline' }, caller)).sets[0]?.context;
    const approval = context?.actionApprovals?.[0];
    if (!approval) throw new Error('Saved private proof required');
    expect(approval).toMatchObject({ triggerId: saved.triggerId, operation: { approvedBy: { accountId: 'owner' } } });
    current = false;
    await expect(reloaded.add(request, caller)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.rows.size).toBe(1);
    current = true;
    failSave = true;
    await expect(reloaded.add(request, caller)).rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(f.rows.size).toBe(1);
    failSave = false;
    expect(await reloaded.readSavedConsent({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      ownerAccountId: 'owner', operation: approval.operation }, caller)).toEqual(approval.operation);
    const persisted = f.rows.get(saved.set.automationId);
    if (!persisted || persisted.executionRecipe?.v !== 2 || !context) throw new Error('Persisted Workflow proof required');
    const { actionApproval: _choice, ...legacySave } = approval.operation.parent.input;
    const legacyOperation = { ...approval.operation, parent: { ...approval.operation.parent,
      input: { ...legacySave, deployApproval: 'automatic' } }, steps: [] };
    const { actionApprovals: _modern, ...legacyContext } = context;
    const storedLegacyContext = { ...legacyContext, deploymentTriggers: [{ triggerId: saved.triggerId, approval: {
      savedFor: { automationId: saved.set.automationId, triggerId: saved.triggerId }, savedBy: { kind: 'person', accountId: 'owner' },
      operation: legacyOperation, basis: { protection: 'nonProduction', variables: { LOG_LEVEL: 'old-value' } },
      program: { definition: request.target.definition, children: {} },
    } }] };
    persisted.executionRecipe = { ...persisted.executionRecipe, workflow: isAvailableE2eeAutomationAccountEncryptionV1(encryption)
      ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
        material: encryption.material.material, payload: storedLegacyContext, randomBytes: params.randomBytes }) }
      : { t: 'plain', v: storedLegacyContext } };
    const legacyReader = createAccountWorkflowTriggerActions(params);
    expect(await legacyReader.readSavedConsent({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      ownerAccountId: 'owner', operation: legacyOperation }, caller)).toEqual({ ...approval.operation, parent: legacyOperation.parent });
    const projected = (await legacyReader.list({ scope: 'account_inline' }, caller)).sets[0]?.context;
    expect(projected?.deploymentTriggers?.[0]).not.toHaveProperty('approval');
    expect(projected?.actionApprovals?.[0]?.operation.steps).toEqual(approval.operation.steps);
    const ask = await reloaded.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: saved.set.revision, patch: { actionApproval: 'ask' } }, caller);
    expect(ask.set.context).not.toHaveProperty('actionApprovals');
    expect(ask.set.context?.deploymentTriggers).toEqual([{ triggerId: saved.triggerId }]);
    expect(await reloaded.readSavedConsent({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      ownerAccountId: 'owner', operation: approval.operation }, caller)).toBeNull();
  });
});

describe('workflow trigger Automation composition', () => {
  it('re-saves an unchanged encrypted Team audience once without changing the execution context or trigger', async () => {
    const f = fixture();
    const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available',
      witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
      material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    const writes: Parameters<typeof f.deps.automations.reconcile>[1][] = [];
    const actions = createAccountWorkflowTriggerActions({ automations: { ...f.deps.automations,
      reconcile: async (id, input, ...rest) => { writes.push(input); return f.deps.automations.reconcile(id, input, ...rest); } },
      resolveEncryption: async () => encryption, randomBytes: length => new Uint8Array(length).fill(3),
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
      resolveWorkflow: f.deps.resolveWorkflow, resolveWorkflowTeamIds: async () => ['team-one'] });
    const saved = await actions.add({ workflow, project, trigger, visibleTeamId: 'team-one', executionTarget: { kind: 'session' } });
    const retained = f.rows.get(saved.set.automationId)!;
    if (retained.executionRecipe?.v !== 2) throw new Error('Current recipe required');
    const { visibleTeamId: _oldAudience, ...oldRecipe } = retained.executionRecipe;
    f.rows.set(retained.id, { ...retained, executionRecipe: oldRecipe });
    const updated = await actions.update({ automationId: retained.id, expectedRevision: retained.templateVersion,
      patch: { visibleTeamId: 'team-one' } });
    expect(writes[0]?.executionRecipe).toMatchObject({ v: 2, visibleTeamId: 'team-one', workflow: { t: 'encrypted' } });
    expect(updated.set.context).toEqual(saved.set.context);
    expect(updated.set.triggers).toEqual(saved.set.triggers);
    expect(updated.set.revision).toBe(retained.templateVersion + 1);
    await actions.update({ automationId: retained.id, expectedRevision: updated.set.revision,
      patch: { visibleTeamId: 'team-one' } });
    expect(writes[1]).not.toHaveProperty('executionRecipe');
  });

  it.each(['context', 'private-trigger'] as const)('suppresses equal E2EE %s operands before sealing', async kind => {
    const f = fixture(WorkflowDefinitionV1Schema.parse({ ...definition,
      inputs: [{ name: 'unchanged', valueType: 'string', required: true }] }));
    const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available',
      witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
      material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
    let nextId = 0;
    let randomCalls = 0;
    const writes: Parameters<typeof f.deps.automations.reconcile>[1][] = [];
    const actions = createAccountWorkflowTriggerActions({ automations: { ...f.deps.automations,
      reconcile: async (id, input, ...rest) => { writes.push(input); return f.deps.automations.reconcile(id, input, ...rest); } },
      resolveEncryption: async () => encryption, randomBytes: length => { randomCalls++; return new Uint8Array(length).fill(randomCalls); },
      newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
      resolveWorkflow: f.deps.resolveWorkflow, resolveWorkflowTeamIds: f.deps.resolveWorkflowTeamIds });
    const request = { workflow, project, trigger: deploymentEventTrigger, inputs: { unchanged: 'value' } };
    const saved = await actions.add(request);
    const before = randomCalls;
    const { enabled: _enabled, ...privateDefinition } = deploymentEventTrigger;
    await actions.update({ automationId: saved.set.automationId, triggerId: saved.triggerId,
      expectedRevision: saved.set.revision, patch: kind === 'context'
        ? { inputs: request.inputs } : { trigger: privateDefinition } });
    expect(randomCalls - before).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toHaveProperty('executionRecipe');
    expect(writes[0]?.triggers).toEqual([{ kind: 'existing', triggerId: saved.triggerId, expectedRevision: saved.triggerRevision }]);
    const current = f.rows.get(saved.set.automationId)!;
    await actions.update({ automationId: current.id, triggerId: saved.triggerId, expectedRevision: current.templateVersion,
      patch: { enabled: false } });
    expect(randomCalls - before).toBe(1);
    expect(writes[1]?.triggers[0]).toMatchObject({ enabled: false, triggerDefinitionEnvelope: { t: 'encrypted' } });
  });

  it('saves and replaces deployment routing for only the selected trigger', async () => {
    const f = fixture();
    expect(WorkflowTriggerAddRequestV1Schema.safeParse({ workflow, project, trigger,
      deploymentTriggers: [{ triggerId: 'another-trigger', branch: 'refs/heads/main' }] }).success).toBe(false);
    expect(WorkflowTriggerUpdateRequestV1Schema.safeParse({ automationId: 'automation-one',
      expectedRevision: 1, patch: { deployment: {} } }).success).toBe(false);
    const first = await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger,
      deployment: { branch: 'refs/heads/main', paths: ['services/**'] } }));
    const second = await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse({ workflow, project, trigger,
      deployment: { branch: 'refs/heads/release' } }));
    expect(second.set.context?.deploymentTriggers).toEqual([
      { triggerId: first.triggerId, branch: 'refs/heads/main', paths: ['services/**'] },
      { triggerId: second.triggerId, branch: 'refs/heads/release' },
    ]);
    const updated = await f.actions.update(WorkflowTriggerUpdateRequestV1Schema.parse({
      automationId: first.set.automationId, triggerId: first.triggerId, expectedRevision: second.set.revision,
      patch: { deployment: { paths: ['packages/**', '!packages/docs/**'] } },
    }));
    expect(updated.set.context?.deploymentTriggers).toEqual([
      { triggerId: second.triggerId, branch: 'refs/heads/release' },
      { triggerId: first.triggerId, paths: ['packages/**', '!packages/docs/**'] },
    ]);
    const cleared = await f.actions.update(WorkflowTriggerUpdateRequestV1Schema.parse({
      automationId: first.set.automationId, triggerId: first.triggerId, expectedRevision: updated.set.revision,
      patch: { deployment: null },
    }));
    expect(cleared.set.context?.deploymentTriggers).toEqual([
      { triggerId: second.triggerId, branch: 'refs/heads/release' },
    ]);
  });

  it('replaces a deleted Account destination through durable approval without reading the retired Session', async () => {
    const f = fixture();
    const destinationDefinition = (sessionId: string, machineId: string) => WorkflowDefinitionV1Schema.parse({ ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'existing_session', sessionId, machineId } },
      blocks: [{ ...definition.blocks[0], execution: { conversation: { kind: 'existing_session', sessionId, machineId } } }],
    });
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => {
      // The exact-Home HTTP reader's deleted-Session failure carries errorCode/httpStatus, not code.
      throw Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'not_found', httpStatus: 404 });
    } });
    const added = await actions.add({ project, trigger: { ...trigger, enabled: false },
      target: { kind: 'inline', definition: destinationDefinition('session-a', project.machineId) } });
    const destination = { machineId: 'machine-c', directory: '/destination-c' };
    const request = { automationId: added.set.automationId, triggerId: added.triggerId, expectedRevision: added.set.revision,
      patch: { project: destination, target: { kind: 'inline' as const, definition: destinationDefinition('session-c', destination.machineId) } } };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
      runtimeAccountId: 'owner', actionRequestId: 'destination-request', actionCaller: { kind: 'host' as const } };
    // A missing family registration must not produce a receipt or mutate storage.
    expect(await createActionExecutor({}).execute('workflow.trigger.update', request, {
      ...context, surface: 'ui', presentUserConfirmation: { actionId: 'workflow.trigger.update' },
    })).toMatchObject({ ok: false });
    expect(f.rows.get(added.set.automationId)?.templateVersion).toBe(1);
    let approval: ApprovalRequest | null = null;
    const executor = f.executor(actions, {
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'destination-approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home' && origin.accountId === 'owner',
    });
    expect(await executor.execute('workflow.trigger.update', request, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.get(added.set.automationId)?.templateVersion).toBe(1);
    expect(await executor.execute('approval.request.decide', { artifactId: 'destination-approval', decision: 'approve' },
      { ...context, surface: 'ui' })).toMatchObject({ ok: true });
    const terminal = ApprovalRequestV2Schema.parse(approval);
    expect(terminal).toMatchObject({ status: 'executed', execution: { ok: true } });
    if (!terminal.execution?.ok) throw new Error('Expected approved destination receipt');
    const receipt = WorkflowTriggerWriteResultV1Schema.parse(terminal.execution.result);
    expect(receipt.set).toMatchObject({ revision: 2, scopeSessionId: null, project: destination,
      destinations: { targetSessionIds: ['session-c'] }, triggers: [{ enabled: false }] });
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([receipt.set]);
    expect(f.rows.get(added.set.automationId)).toMatchObject({ assignments: [{ machineId: destination.machineId }],
      executionRecipe: { workflow: { v: { inlineDefinition: {
        defaults: { conversation: { sessionId: 'session-c' } }, blocks: [{ execution: { conversation: { sessionId: 'session-c' } } }],
      } } } } });
  });
  it.each(['happier.agent.opencode', 'acme.external-agent'])('keeps Session-B Habit scope independent of its authored A destination and project (%s)', async (pluginId) => {
    const f = fixture();
    const scopeProject = project;
    const destination = { kind: 'existing_session', sessionId: 'session-a', machineId: project.machineId } as const;
    // R94 habit-b-add-input.json: explicit project, both A conversation locations,
    // omitted block input (canonicalized to []), model/binding, disabled UTC clock.
    const request = SessionTriggerAddRequestV1Schema.parse({ sessionId: 'session-b', project,
      target: { kind: 'inline', definition: { version: 1, inputs: [], defaults: { conversation: destination },
        blocks: [{ kind: 'step', id: 'first', name: 'Habit B',
          document: { text: 'Reply exactly HABIT B.', references: [], attachments: [] },
          execution: { engine: { agentTarget: { kind: 'agent', identity: { pluginId, localId: 'agent' } },
            modelSelection: { v: 1, ref: { agentTargetKey: `agent:${pluginId}/agent`, providerConnectionId: null, modelId: 'model' }, updatedAt: 1 }, effort: 'low' },
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
              source: 'connected', selection: 'profile', profileId: 'profile-one' } } },
            conversation: destination, permissionMode: 'default' }, result: { kind: 'text' } }],
        finalOutput: { kind: 'result', producer: { blockId: 'first', scope: { kind: 'current' } }, path: [] } } },
      trigger: { kind: 'schedule', enabled: false, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'UTC' } },
    });
    const actions = createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project: scopeProject, nativeGoalOwner: false }) });
    const boundary = f.executor(actions);
    const caller = { surface: 'ui', authority: 'present_user' } as const;
    const added = await boundary.execute('session.trigger.add', request, caller);
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) throw new Error(added.errorCode);
    const receipt = WorkflowTriggerWriteResultV1Schema.parse(added.result);
    expect(f.rows.get(receipt.set.automationId)).toMatchObject({ scopeSessionId: 'session-b',
      assignments: [{ machineId: project.machineId }], executionRecipe: { workflow: { t: 'plain', v: {
        workspace: { directory: project.directory }, inlineDefinition: request.target.kind === 'inline' ? request.target.definition : null,
      } } } });
    const listed = await boundary.execute('session.trigger.list', { sessionId: 'session-b' }, caller);
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error(listed.errorCode);
    const read = SessionTriggerListResultV1Schema.parse(listed.result);
    expect(read.sets).toEqual([receipt.set]);
    expect(read.sets[0]).toMatchObject({ scopeSessionId: 'session-b', project,
      destinations: { targetSessionIds: ['session-a'] },
      context: { inlineDefinition: { defaults: { conversation: destination }, blocks: [{ execution: { conversation: destination } }] } } });
    // A later edit must not silently move execution onto B.
    const updated = await boundary.execute('session.trigger.update', { sessionId: 'session-b', triggerId: receipt.triggerId,
      expectedRevision: receipt.set.revision, patch: { enabled: false } }, caller);
    expect(updated).toMatchObject({ ok: true, result: { set: { project, destinations: { targetSessionIds: ['session-a'] },
      triggers: [{ kind: 'schedule', enabled: false }] } } });
    // Mis-bound scope authorization is not rescued by the valid destination/project.
    const misbound = f.executor(createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => { throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' }); } }));
    expect(await misbound.execute('session.trigger.add', request, caller)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(f.rows.size).toBe(1);
  });

  it('keeps a specific typed refusal for a lifecycle source outside the Session scope', async () => {
    const f = fixture();
    const boundary = f.executor(createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) }));
    expect(await boundary.execute('session.trigger.add', { sessionId: 'session-b', target: { kind: 'inline', definition },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-a',
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } } }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_input', details: { code: 'session_trigger_source_mismatch' } });
    expect(await boundary.execute('session.trigger.add', { sessionId: 'session-b', project: { ...project, directory: '/elsewhere' },
      target: { kind: 'inline', definition }, trigger }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_input', details: { code: 'session_trigger_project_mismatch' } });
    expect(f.rows.size).toBe(0);
  });

  const manualPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'workflow.trigger.run_now': ['ui'] } });
  it('admits a retained manual occurrence through the Automation transport without converting or rewriting its trigger set', async () => {
    const f = fixture();
    const receipt = manualReceipt('retained-manual');
    const unexpected = (): never => { throw new Error('manual_admission_must_not_convert_or_save'); };
    const actions = createWorkflowTriggerActions({ ...f.deps,
      automations: { ...f.deps.automations, get: unexpected, create: unexpected, reconcile: unexpected,
        runNow: async (id, options) => { expect(id).toBe('retained-manual'); expect(options).toEqual({ idempotencyKey: 'manual-retry' }); return receipt; } } });
    await expect(f.executor(actions).execute('workflow.trigger.run_now', { automationId: 'retained-manual', idempotencyKey: 'manual-retry' },
      { surface: 'ui', authority: 'present_user', actionsSettings: manualPolicy })).resolves.toEqual({ ok: true, result: receipt });
    expect(f.rows.size).toBe(0);
  });
  it('keeps a lost manual admission reply uncertain without issuing another occurrence', async () => {
    const f = fixture();
    let submitted = 0;
    const actions = createWorkflowTriggerActions({ ...f.deps, automations: { ...f.deps.automations,
      runNow: async () => { submitted += 1; throw Object.assign(new Error('Reply lost'), { code: 'workflow_outcome_unresolved' }); },
    } });
    expect(await f.executor(actions).execute('workflow.trigger.run_now', { automationId: 'retained-manual' },
      { surface: 'ui', authority: 'present_user', actionsSettings: manualPolicy })).toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
    expect(submitted).toBe(1);
  });
  it.each(['new', 'existing', 'update'] as const)('acknowledges a committed trigger write without reading its Workflow again: %s', async operation => {
    const f = fixture();
    const existing = operation === 'new' ? null : await f.actions.add({ workflow, project, trigger });
    let sourceReadsAtCommit = -1;
    const accepted = (row: AutomationDefinitionDetail) => {
      sourceReadsAtCommit = f.definitionReads();
      f.failSourceReads();
      return row;
    };
    const triggers = createWorkflowTriggerActions({ ...f.deps,
      automations: { ...f.deps.automations,
        create: async (...args) => accepted(await f.deps.automations.create(...args)),
        reconcile: async (...args) => accepted(await f.deps.automations.reconcile(...args)),
      },
    });
    const executor = f.executor(triggers);
    const caller = { surface: 'ui', authority: 'present_user' } as const;
    const result = operation === 'update' && existing
      ? await executor.execute('workflow.trigger.update', { automationId: existing.set.automationId, triggerId: existing.triggerId,
          expectedRevision: existing.set.revision, patch: { enabled: false } }, caller)
      : await executor.execute('workflow.trigger.add', { workflow, project, trigger }, caller);
    expect(result).toMatchObject({ ok: true, result: { set: { health: 'available', target: { kind: 'workflow', ref: workflow }, project } } });
    expect(f.rows.size).toBe(1);
    expect([...f.rows.values()][0]?.triggers).toHaveLength(operation === 'existing' ? 2 : 1);
    expect(f.definitionReads()).toBe(sourceReadsAtCommit);
  });
  it('keeps a committed Session trigger uncertain when Channel attachment fails', async () => {
    const f = fixture();
    const triggers = createWorkflowTriggerActions({ ...f.deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: { listLinks: async () => [], removeTrigger: async () => {},
        attach: async () => { throw Object.assign(new Error('Channel unavailable'), { code: 'target_unavailable' }); } },
    });
    const result = await f.executor(triggers).execute('session.trigger.add', {
      sessionId: 'session-one', target: { kind: 'inline', definition },
      trigger: { kind: 'prComment', enabled: true, pullRequest: { repository: 'org/repo', number: 42 } },
    }, { surface: 'ui', authority: 'present_user' });
    expect(result).toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
    expect(f.rows.size).toBe(1);
  });
  it('acknowledges approved removal from the committed row without replaying it when later source reads fail', async () => {
    const f = fixture();
    const added = await f.actions.add({ project, trigger, workflow });
    let removals = 0;
    const actions = createWorkflowTriggerActions({ ...f.deps, automations: { ...f.deps.automations,
      reconcile: async (...args) => {
        removals++;
        const row = await f.deps.automations.reconcile(...args);
        f.failSourceReads();
        return row;
      },
    } });
    let approval: ApprovalRequest | null = null;
    const executor = f.executor(actions, {
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'lost-removal-receipt' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home' && origin.accountId === 'owner',
    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'owner',
      actionRequestId: 'lost-removal-request', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('workflow.trigger.remove', { automationId: added.set.automationId, triggerId: added.triggerId }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'lost-removal-receipt', decision: 'approve' },
      { ...context, surface: 'ui' })).toMatchObject({ ok: true, result: { status: 'executed',
        execution: { ok: true, result: { set: { triggers: [] } } } } });
    expect(ApprovalRequestV2Schema.parse(approval)).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(f.rows.get(added.set.automationId)?.triggers).toEqual([]);
    expect(removals).toBe(1);
  });
  it('preserves the manual occurrence owner authentication refusal through the Action front door', async () => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps, automations: { ...f.deps.automations,
      runNow: async () => { throw Object.assign(new Error('Not authenticated'), { code: 'not_authenticated' }); },
    } });
    expect(await f.executor(actions).execute('workflow.trigger.run_now', { automationId: 'retained-manual' },
      { surface: 'ui', authority: 'present_user', actionsSettings: manualPolicy })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  });
  it('creates a Coach digest only through opted-in Automation Actions, retains approval rejection and removes through the same owner', async () => {
    const f = fixture();
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, sources: ['runtime'] });
    const suggestion = resolveUsagePageAggregation({ queries: [query] }).results[0]!.coach!.digestSuggestion!;
    expect(suggestion).toBeDefined();
    expect(f.rows.size).toBe(0);
    const request = { target: suggestion.target, project, trigger };
    let approval: ApprovalRequest | null = null;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'workflow.trigger.add': { approvalRequiredSurfaces: ['ui'] } } });
    const gated = f.executor(f.actions, {
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'digest-approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
        && origin.accountId === 'owner' && origin.caller.kind === 'host',
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      runtimeAccountId: 'owner', actionRequestId: 'digest-request', actionCaller: { kind: 'host' as const } };
    const approvalResult = await gated.execute(suggestion.actionId, request, context);
    expect(approvalResult, JSON.stringify(approvalResult))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.size).toBe(0);
    expect(await gated.execute('approval.request.decide', { artifactId: 'digest-approval', decision: 'reject' }, context))
      .toMatchObject({ ok: true });
    expect(ApprovalRequestV2Schema.parse(approval).status).toBe('rejected');
    expect(f.rows.size).toBe(0);
    const optedIn = f.executor(f.actions);
    expect(await optedIn.execute(suggestion.actionId, { ...request, project: { ...project, directory: '' } }, context))
      .toMatchObject({ ok: false });
    expect(f.rows.size).toBe(0);
    expect(await gated.execute(suggestion.actionId, request, { ...context, actionRequestId: 'digest-approved-request' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.size).toBe(0);
    const decided = await gated.execute('approval.request.decide', { artifactId: 'digest-approval', decision: 'approve' }, context);
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
    const terminal = ApprovalRequestV2Schema.parse(approval);
    expect(terminal.status).toBe('executed');
    const created = terminal.execution;
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    if (!created?.ok) throw new Error('Expected the Automation owner receipt');
    const receipt = WorkflowTriggerWriteResultV1Schema.parse(created.result);
    expect(f.rows.get(receipt.set.automationId)).toMatchObject({
      enabled: true, assignments: [{ machineId: project.machineId, enabled: true }],
      triggers: [{ kind: 'schedule', enabled: true }],
      executionRecipe: { workflow: { t: 'plain', v: { inlineDefinition: suggestion.target.definition } } },
    });
    expect(await optedIn.execute('workflow.trigger.remove', {
      automationId: receipt.set.automationId, triggerId: receipt.triggerId,
    }, { ...context, presentUserConfirmation: { actionId: 'workflow.trigger.remove' } })).toMatchObject({ ok: true });
    expect(f.rows.get(receipt.set.automationId)?.triggers).toEqual([]);
  });
  it('refuses authoring a managed trigger onto a stale controller', async () => {
    const f = fixture();
    f.setManagedController(null);
    const effect = f.actions.add({ project: { machineId: 'controller', directory: '~' }, trigger,
        target: { kind: 'inline', definition: WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'stop',
          actionId: 'machines.managed.power.set', input: {
            homeId: { kind: 'literal', value: 'home' }, managedId: { kind: 'literal', value: 'managed' },
            when: { kind: 'literal', value: 'after-idle' }, intent: { kind: 'literal', value: 'stop' },
          } }] }) } });
    await expect(effect).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(f.rows.size).toBe(0);
  });
  it('keeps an admitted Session trigger on its controller instead of moving it onto the source guest', async () => {
    const f = fixture();
    const controllerProject = { machineId: 'controller', directory: '~' };
    const inline = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'stop',
      actionId: 'machines.managed.power.set', input: {
        homeId: { kind: 'literal', value: 'home' }, managedId: { kind: 'literal', value: 'managed' },
        when: { kind: 'literal', value: 'after-idle' }, intent: { kind: 'literal', value: 'stop' },
      } }] });
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const result = await actions.sessionAdd(SessionTriggerAddRequestV1Schema.parse({ sessionId: 'session-one',
      project: controllerProject, target: { kind: 'inline', definition: inline }, executionTarget: { kind: 'detached_run' },
      trigger: { kind: 'sessionLifecycle', sourceSessionId: 'session-one', events: ['sessionArchived'],
        policy: { kind: 'everyMatch' }, enabled: true } }));
    expect(result.set.project).toEqual(controllerProject);
    expect(f.rows.get(result.set.automationId)?.assignments.map(value => value.machineId)).toEqual(['controller']);
    const updated = await actions.sessionUpdate({ sessionId: 'session-one', triggerId: result.triggerId!,
      expectedRevision: result.set.revision, patch: { enabled: false } });
    expect(updated.set.project).toEqual(controllerProject);
  });

  it('lists scheduled inline, saved-workflow and Session-owned sets through one Account query', async () => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    await f.actions.add({ project, trigger, target: { kind: 'inline', definition } });
    await f.actions.add({ project, trigger, workflow });
    await actions.sessionAdd({ sessionId: 'session-one', trigger, target: { kind: 'inline', definition } });
    // Exercise strict ingress as well as the real projection and Automation traversal.
    const result = await f.actions.list({ scope: 'account_all' });
    expect(result.sets).toHaveLength(3);
    expect(result.sets.some(set => 'scopeSessionId' in set && set.scopeSessionId === 'session-one')).toBe(true);
    expect((await f.actions.list({ scope: 'account_inline' })).sets).toHaveLength(1);
  });
  it.each([
    { ref: workflow, event: 'sessionStarted' },
    { ref: 'builtin:review-and-converge', event: 'parentTurnCompleted' },
  ] as const)('prepares inherited $ref birth triggers without writing or choosing the source Session', async ({ ref, event }) => {
    const { rows, deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveMaterializer: async () => ({
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.claude/claude' } },
        effects: { resolveTargetAvailability: async () => true,
          readActionContract: async (actionId) => {
            const spec = getActionSpec(ActionIdSchema.parse(actionId));
            return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
          },
        },
      }) });
    const prepared = await actions.prepareSessionInitialTriggers({ project, initialTriggers: [{
      target: { kind: 'workflow', ref },
      ...(ref === 'builtin:review-and-converge'
        ? { inputs: { engines: ['agent:happier.agent.claude/claude'] } } : {}),
      trigger: { kind: 'sessionLifecycle', enabled: true, events: [event], policy: { kind: 'everyMatch' } },
    }], caller: { ...ownCaller, approvalProfileId: 'profile:inherited-birth' } }).catch((error: unknown) => {
      if (error instanceof Error && 'details' in error) {
        throw new Error(`${error.message}: ${JSON.stringify(error.details)}`, { cause: error });
      }
      throw error;
    });
    expect(rows.size).toBe(0);
    expect(prepared).toMatchObject([{ workflowDefinitionId: ref, assignments: [{ machineId: project.machineId }],
      executionRecipe: { v: 2, workflow: { t: 'plain', v: {
        workspace: { directory: project.directory }, approvalProfileId: 'profile:inherited-birth' } } },
      triggers: [{ trigger: { events: [event], policy: { kind: 'everyMatch' } } }] }]);
    expect(prepared[0]).not.toHaveProperty('scopeSessionId');
    expect(prepared[0]?.triggers[0]?.trigger).not.toHaveProperty('sourceSessionId');
    await expect(actions.prepareSessionInitialTriggers({ project, initialTriggers: [{
      target: { kind: 'workflow', ref: workflow }, trigger,
    }], caller: { ...ownCaller, agentStartContext: { ...ownCaller.agentStartContext, workDepthLimit: 0 } } }))
      .rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(rows.size).toBe(0);
  });
  it('enables only the selected trigger of a disabled plural set in one revision transition', async () => {
    const { rows, actions } = fixture();
    const first = await actions.add({ workflow, project, trigger });
    const second = await actions.add({ workflow, project, trigger });
    const disabled = await actions.update({ automationId: first.set.automationId,
      expectedRevision: second.set.revision, patch: { enabled: false } });
    const enabled = await actions.update({ automationId: first.set.automationId, triggerId: second.triggerId,
      expectedRevision: disabled.set.revision, patch: { enabled: true } });
    expect(enabled.set).toMatchObject({ enabled: true, revision: disabled.set.revision + 1,
      triggers: [{ id: first.triggerId, enabled: false }, { id: second.triggerId, enabled: true }] });
    expect(rows.get(first.set.automationId)?.enabled).toBe(true);
  });
  it('summarizes attached disabled triggers from the public list without opening private context or session-scoped sets', async () => {
    const { deps, rows, actions } = fixture();
    const saved = await actions.add({ workflow, project, trigger: { ...trigger, enabled: false } });
    const row = rows.get(saved.set.automationId)!;
    rows.set('session-only', { ...row, id: 'session-only', scopeSessionId: 'session-one' });
    const read = createWorkflowTriggerActions({ ...deps, automations: { ...deps.automations,
      get: async () => { throw new Error('summary_must_not_open_private_detail'); } },
      openContext: async () => { throw new Error('summary_must_not_open_private_context'); } });
    expect(await read.readWorkflowSummaries([workflow])).toEqual(new Map([[workflow, {
      triggers: [{ kind: 'schedule', schedule: trigger.schedule, automationId: saved.set.automationId,
        triggerId: saved.triggerId, nextRunAt: null }], nextRunAt: null,
    }]]));
  });
  it('merges the authorized Team summary into the same library facts without opening another Account context', async () => {
    const { deps, actions } = fixture();
    const saved = await actions.add({ workflow, project, trigger });
    const read = createWorkflowTriggerActions({ ...deps, automations: { ...deps.automations,
      list: async input => ({ ...await deps.automations.list(input), sharedWorkflowSummaries: [{
        workflowDefinitionId: workflow, triggers: [{ kind: 'schedule' as const, schedule: trigger.schedule }], nextRunAt: 1,
      }] }),
      get: async () => { throw new Error('Team_summary_must_not_read_private_details'); },
    } });
    expect((await read.readWorkflowSummaries([workflow])).get(workflow)).toEqual({
      triggers: [{ kind: 'schedule', schedule: trigger.schedule, automationId: saved.set.automationId,
        triggerId: saved.triggerId, nextRunAt: 2 }, { kind: 'schedule', schedule: trigger.schedule }], nextRunAt: 1,
    });
  });
  it('uses the earliest enabled scheduler occurrence across attached sets without recomputing schedules', async () => {
    const { rows, actions } = fixture();
    const saved = await actions.add({ workflow, project, trigger });
    const row = rows.get(saved.set.automationId)!;
    const scheduled = row.triggers[0]!;
    if (scheduled.kind !== 'schedule') throw new Error('Expected schedule');
    rows.set(row.id, { ...row, triggers: [
      { ...scheduled, nextRunAt: 900 }, { ...scheduled, id: AutomationTriggerIdSchema.parse('earlier'), nextRunAt: 400 },
      { ...scheduled, id: AutomationTriggerIdSchema.parse('disabled'), enabled: false, nextRunAt: 100 },
    ] });
    rows.set('disabled-set', { ...row, id: 'disabled-set', enabled: false, triggers: [{ ...scheduled, nextRunAt: 50 }] });
    rows.set('session-set', { ...row, id: 'session-set', scopeSessionId: 'session', triggers: [{ ...scheduled, nextRunAt: 10 }] });
    expect((await actions.readWorkflowSummaries([workflow])).get(workflow)).toMatchObject({ nextRunAt: 400 });
    rows.set(row.id, { ...row, triggers: [{ ...scheduled, nextRunAt: null }] });
    expect((await actions.readWorkflowSummaries([workflow])).get(workflow)).toMatchObject({ nextRunAt: null });
  });
  it('preserves cancellation instead of turning it into link unavailability', async () => {
    const { deps } = fixture();
    const controller = new AbortController();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: { listLinks: async () => { controller.abort(new Error('cancelled')); controller.signal.throwIfAborted(); return []; },
        attach: async () => undefined, removeTrigger: async () => undefined },
    });
    await expect(actions.sessionList({ sessionId: 'session-one' }, { signal: controller.signal })).rejects.toThrow('cancelled');
  });
  it.each(['rejected', 'unavailable', 'not-configured'] as const)('lists ordinary Session triggers when PR links are %s', async (failure) => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      ...(failure === 'not-configured' ? {} : { pullRequests: {
        listLinks: async () => { throw Object.assign(new Error(failure), { code: failure === 'rejected' ? 'denied' : 'target_unavailable' }); },
        attach: async () => undefined, removeTrigger: async () => undefined,
      } }),
    });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    await expect(actions.sessionList({ sessionId: 'session-one' })).resolves.toMatchObject({
      sessionId: 'session-one', sets: [added.set], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' },
    });
  });

  it.each(['prComment', 'ciFailed'] as const)('attaches %s through the PR binding owner and returns its link', async (triggerKind) => {
    const { deps } = fixture();
    const bindings = new Map<string, { provider: 'github'; repository: string; number: number; url: string }>();
    const selected = { repository: 'happier-dev/happier', number: 42 };
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: {
        listLinks: async () => [...bindings.values()],
        attach: async ({ triggerId, pullRequest }) => { bindings.set(triggerId, { provider: 'github', ...pullRequest,
          url: `https://github.com/${pullRequest.repository}/pull/${pullRequest.number}` }); },
        removeTrigger: async () => undefined,
      },
    });
    const result = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow },
      trigger: { kind: triggerKind, enabled: true, pullRequest: selected } });
    expect(result.set.triggers).toMatchObject([{ kind: triggerKind, pullRequest: selected }]);
    expect(await actions.sessionList({ sessionId: 'session-one' })).toMatchObject({
      sessionId: 'session-one', pullRequestLinks: [{ provider: 'github', ...selected }],
    });
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: result.triggerId! });
    const afterRemoval = await actions.sessionList({ sessionId: 'session-one' });
    expect(afterRemoval.sets.flatMap((set) => set.triggers)).toEqual([]);
    expect(afterRemoval.pullRequestLinks).toEqual([{ provider: 'github', ...selected, url: 'https://github.com/happier-dev/happier/pull/42' }]);
  });

  it('requires a selected or single linked PR before writing a scoped PR trigger', async () => {
    const { deps, rows } = fixture();
    let links: { provider: 'github'; repository: string; number: number; url: string }[] = [];
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: { listLinks: async () => links, attach: async () => undefined, removeTrigger: async () => undefined },
    });
    const request = { sessionId: 'session-one', target: { kind: 'workflow' as const, ref: workflow },
      trigger: { kind: 'prComment' as const, enabled: true } };
    await expect(actions.sessionAdd(request)).rejects.toMatchObject({ code: 'pull_request_link_required' });
    expect(rows.size).toBe(0);
    links = [{ provider: 'github', repository: 'happier-dev/happier', number: 42, url: 'https://github.com/happier-dev/happier/pull/42' }];
    expect((await actions.sessionAdd(request)).set.triggers).toMatchObject([{ kind: 'prComment', pullRequest: { repository: links[0]!.repository, number: 42 } }]);
    links.push({ provider: 'github', repository: 'happier-dev/happier', number: 43, url: 'https://github.com/happier-dev/happier/pull/43' });
    await expect(actions.sessionAdd(request)).rejects.toMatchObject({ code: 'pull_request_link_required' });
  });

  it('registers one exact run notification and removes its observation on cancellation', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run finished' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'workflow_run' as const, runId: 'run-one' }, condition: 'terminal' as const } };
    const first = await actions.add(request);
    const replay = await actions.add(request);
    expect(replay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect(first.set.triggers).toMatchObject([{ kind: 'runLifecycle', remainingOccurrences: 1,
      source: request.trigger.source, condition: 'terminal' }]);
    // Terminal catch-up can commit before the registration acknowledgement.
    // The external persisted projection now describes the consumed intent.
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    const completedReplay = await actions.add(request);
    expect(completedReplay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect(completedReplay.set.triggers).toMatchObject([{ remainingOccurrences: 0, status: { state: 'finished' } }]);
    await actions.remove({ automationId: first.set.automationId, triggerId: first.triggerId! });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(0);
    expect((await actions.add(request)).triggerId).not.toBe(first.triggerId);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
  });

  it('rearms an exhausted Run attention observation instead of acknowledging it as waiting', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run needs you' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'workflow_run' as const, runId: 'run-one' }, condition: 'needs_attention' as const } };
    const first = await actions.add(request);
    expect((await actions.add(request)).triggerId).toBe(first.triggerId);
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    const rearmed = await actions.add(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect(rearmed.set.triggers).toMatchObject([{ remainingOccurrences: 1, status: { state: 'waiting' } }]);
  });

  it('rearms terminal observation when the exact execution Run has resumed', async () => {
    const { deps, rows } = fixture();
    let terminal = true;
    const actions = createWorkflowTriggerActions({ ...deps, resolveRunSource: async () => ({ terminal }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run finished' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'execution_run' as const, machineId: 'machine-one', runId: 'run-one' }, condition: 'terminal' as const } };
    const first = await actions.add(request);
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    expect((await actions.add(request)).triggerId).toBe(first.triggerId);
    // The genuine source-read boundary now reports the same Run's resumed state.
    terminal = false;
    const rearmed = await actions.add(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect(rearmed.set.triggers).toMatchObject([{ remainingOccurrences: 1, status: { state: 'waiting' } }]);
  });

  it('rejoins a one-shot session notification through the same Action owner, and cancellation removes it', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'This turn finished' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['parentTurnCompleted' as const, 'parentTurnFailed' as const, 'parentTurnCancelled' as const],
        policy: { kind: 'currentTurn' as const, sourceTurnId: 'turn-one' } } };
    const first = await actions.sessionAdd(request);
    const replay = await actions.sessionAdd(request);
    expect(replay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
    await actions.sessionRemove({ sessionId: request.sessionId, triggerId: first.triggerId! });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(0);
    const rearmed = await actions.sessionAdd(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
  });

  it('keeps a needs-me one-shot distinct from exact-turn completion and from repeating notifications', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    expect((await actions.sessionAdd(request)).triggerId).toBe(first.triggerId);
    await actions.sessionAdd({ ...request, trigger: { ...request.trigger, policy: { kind: 'everyMatch' } } });
    await actions.sessionAdd({ ...request, trigger: { ...request.trigger, policy: { kind: 'everyMatch' } } });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(3);
  });

  it('does not acknowledge an exhausted needs-me trigger as a newly armed observation', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    const row = [...rows.values()][0]!;
    rows.set(row.id, { ...row, triggers: row.triggers.map((item) => item.kind === 'sessionLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    expect((await actions.sessionAdd(request)).triggerId).not.toBe(first.triggerId);
  });

  it('rejoins the same observation at the authorized Machine after Session placement changes', async () => {
    const { deps } = fixture();
    let machineId = 'machine-one';
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project: { ...project, machineId }, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    machineId = 'machine-two';
    const moved = await actions.sessionAdd(request);
    expect(moved.triggerId).toBe(first.triggerId);
    expect(moved.set.project?.machineId).toBe('machine-two');
  });

  it('retains Session proposal provenance when a person authorizes Account trigger replay', async () => {
    const { deps, rows } = fixture();
    const observations: ActionExecutorContext[] = [];
    const triggers = createWorkflowTriggerActions({ ...deps,
      resolveSession: async (_sessionId, caller) => {
        if (caller) observations.push(caller);
        return { project, nativeGoalOwner: false };
      },
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [] }), read: async () => null,
      create: async () => { throw new Error('Unexpected Artifact write'); },
      update: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => ({ ok: true }),
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: async () => undefined });
    let storedRequest: ApprovalRequest | null = null;
    let policyFactsAvailable = true;
    let currentTurnDepth = 0;
    const createExecutor = (
      approvalPorts: Partial<Pick<ActionExecutorDeps, 'approvalsGet' | 'approvalsUpdate'>> = {},
    ): ReturnType<typeof createActionExecutor> => createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, triggers,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } },
    }),
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'session-agent-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.caller.kind === 'session'
        && origin.caller.sessionId === 'session-one' && origin.machineId === project.machineId,
      resolveAgentStartContext: async () => policyFactsAvailable ? { ...ownCaller.agentStartContext,
        caller: { ...ownCaller.agentStartContext.caller, turnDepth: currentTurnDepth } } : null,
      observeActionExecution: async ({ context }) => { observations.push(context); },
      ...approvalPorts,
    });
    const executor = createExecutor();
    const context: ActionExecutorContext = { ...ownCaller, surface: 'cli', authority: 'account_automation',
      serverId: 'home-one', actionRequestId: 'session-action-request', defaultSessionId: 'untrusted-default', callerPermissionMode: 'default',
      defaultSessionMachineId: project.machineId,
      approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'session-one', toolCallId: 'tool-one' },
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } };
    expect(await executor.execute('workflow.trigger.list', { scope: 'account_inline' }, context)).toMatchObject({ ok: true, result: { sets: [] } });
    expect(await executor.execute('session.trigger.add', {
      sessionId: 'foreign-session', target: { kind: 'inline', definition }, trigger,
    }, context)).toMatchObject({ ok: false });
    expect(rows.size).toBe(0);
    expect(await executor.execute('session.trigger.add', {
      sessionId: 'session-one', target: { kind: 'inline', definition }, trigger,
    }, context)).toMatchObject({ ok: true, result: { set: { health: 'available' } } });
    expect(rows.size).toBe(1);
    expect(observations.at(-1)).toMatchObject({ surface: 'agent', defaultSessionId: 'session-one',
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } });
    policyFactsAvailable = false;
    const { agentStartContext: _agentStartContext, ...withoutDepth } = context;
    expect(await executor.execute('session.trigger.list', { sessionId: 'session-one' }, withoutDepth))
      .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ health: 'available' })] } });
    expect(await executor.execute('session.trigger.list', { sessionId: 'foreign-session' }, withoutDepth))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    policyFactsAvailable = true;
    const accountTrigger = await executor.execute('workflow.trigger.add', {
      target: { kind: 'inline', definition }, project, trigger,
    }, context);
    expect(accountTrigger.ok, JSON.stringify(accountTrigger)).toBe(true);
    expect(accountTrigger).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(rows.size).toBe(1);
    expect(storedRequest).toMatchObject({ executionOriginV1: { surface: 'agent',
      caller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } } });
    const captured = ApprovalRequestV2Schema.parse(storedRequest);
    expect(ApprovalRequestV2Schema.safeParse({ ...captured, executionOriginV1: { ...captured.executionOriginV1,
      caller: { kind: 'session', sessionId: 'session-one' } } }).success).toBe(false);
    expect(rows.size).toBe(1);
    currentTurnDepth = 50;
    // A fresh executor retains the Session proposal's provenance. The person's
    // Account-owned replay is a new human invocation despite the exhausted Session.
    const replay = await createExecutor().execute('approval.request.decide', {
      artifactId: 'session-agent-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-one' });
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
    expect(rows.size).toBe(2);
    expect(storedRequest).toMatchObject({ status: 'executed', execution: { ok: true }, executionOriginV1: {
      surface: 'agent', caller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 },
    } });
    const replayContext = observations.filter((entry) => entry.bypassApprovals).at(-1);
    expect(replayContext).toMatchObject({ surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    // The reviewed Session remains contextual default; the human host invocation
    // carries no restored Session start policy or caller authority.
    expect(replayContext?.defaultSessionId).toBe('session-one');
    expect(replayContext?.agentStartContext).toBeUndefined();
    expect(replayContext?.sessionAgentSpawnPolicyV1).toBeUndefined();
    policyFactsAvailable = false;
    expect(await executor.execute('session.trigger.list', { sessionId: 'session-one' }, withoutDepth))
      .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ health: 'available' })] } });
    expect(await executor.execute('session.trigger.list', { sessionId: 'foreign-session' }, withoutDepth))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const sessionRow = [...rows.values()].find((row) => row.scopeSessionId === 'session-one')!;
    expect(await executor.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: sessionRow.triggers[0]!.id }, withoutDepth))
      .toMatchObject({ ok: true, result: { set: { triggers: [] } } });
  });
  it('validates and retains the selected Team before add or update', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveWorkflowTeamIds: async () => ['team-one', 'team-two'] });
    for (const visibleTeamId of [undefined, null, 'ungranted']) {
      await expect(actions.add({ workflow, project, trigger, ...(visibleTeamId === undefined ? {} : { visibleTeamId }) }))
        .rejects.toMatchObject({ code: 'visible_team_not_granted' });
    }
    expect(rows.size).toBe(0);
    const added = await actions.add({ workflow, project, trigger, visibleTeamId: 'team-two' });
    expect(added.set.context?.visibleTeamId).toBe('team-two');
    await expect(actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { visibleTeamId: 'ungranted' } })).rejects.toMatchObject({ code: 'visible_team_not_granted' });
    expect(rows.get(added.set.automationId)?.templateVersion).toBe(1);
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision, patch: { enabled: false } });
    expect(updated.set.context?.visibleTeamId).toBe('team-two');
  });
  it('does not project current one-shot recipes as predecessor Workflow triggers', async () => {
    const { rows, actions } = fixture();
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = rows.get(added.set.automationId)!;
    rows.set(row.id, { ...row, targetType: 'newSession', executionRecipe: {
      v: 1, templateVersion: 1, template: { t: 'plain', v: { v: 1, prompt: 'Review retained prompt' } }, triggerEvidence: null,
      target: { kind: 'newSession', spawn: { executionTarget: { serverId: 'source-server', machineId: project.machineId },
        directory: { kind: 'path', path: project.directory }, agentTarget: definition.defaults!.agentTarget! } },
    } });
    const listed = await actions.list({ scope: 'account_inline' });
    expect(listed.sets).toEqual([]);
    expect(rows.get(row.id)?.executionRecipe?.v).toBe(1);
  });
  it('excludes Session-scoped rows from the Account-inline census', async () => {
    const { actions, rows } = fixture();
    const scoped = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = rows.get(scoped.set.automationId)!;
    rows.set(row.id, { ...row, scopeSessionId: 'session-owned' });
    const account = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    expect((await actions.list({ scope: 'account_inline' })).sets.map((set) => set.automationId)).toEqual([account.set.automationId]);
  });
  it('reuses the workflow set without resetting its frozen run context when another trigger is added', async () => {
    const { actions, rows } = fixture();
    const first = await actions.add({ workflow, project, trigger, executionTarget: { kind: 'detached_run' }, inputs: { repository: 'repo' } });
    const second = await actions.add({ workflow, project, trigger });
    expect(rows.size).toBe(1);
    expect(second.set.automationId).toBe(first.set.automationId);
    expect(second.set.triggers).toHaveLength(2);
    expect(second.set.context).toMatchObject({ executionTarget: { kind: 'detached_run' }, inputs: { repository: 'repo' } });
  });
  it('keeps inline definitions only in their payload and changes machine and workspace in one set write', async () => {
    const { actions, rows } = fixture();
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    expect(rows.get(added.set.automationId)?.workflowDefinitionId).toBeNull();
    expect((await actions.list({ scope: 'account_inline' })).sets[0]?.target).toEqual({ kind: 'inline', definition });
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { project: { machineId: 'machine-two', directory: '/other' } } });
    expect(updated.set.project).toEqual({ machineId: 'machine-two', directory: '/other' });
    expect(rows.get(added.set.automationId)?.assignments.map((assignment) => assignment.machineId)).toEqual(['machine-two']);
    await expect(actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'currentness_conflict', details: { revision: updated.set.revision } });
    expect(rows.get(added.set.automationId)?.enabled).toBe(true);
  });
  it('shows missing sources and still removes their final trigger without deleting the Manual set', async () => {
    const { actions, rows, loseSource } = fixture();
    const added = await actions.add({ workflow, project, trigger });
    loseSource();
    expect((await actions.list({ workflow })).sets[0]?.health).toBe('source_unavailable');
    const removed = await actions.remove({ automationId: added.set.automationId, triggerId: added.triggerId! });
    expect(removed.set.triggers).toEqual([]);
    expect(rows.size).toBe(1);
    await actions.removeForWorkflow(workflow);
    expect(rows.size).toBe(0);
  });
  it('deletes every Account and Session trigger set referencing a deleted Artifact', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    await actions.add({ workflow, project, trigger });
    await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    await actions.sessionAdd({ sessionId: 'session-two', target: { kind: 'inline', definition }, trigger });
    await actions.removeForWorkflow(workflow);
    expect([...rows.values()]).toMatchObject([{ scopeSessionId: 'session-two', workflowDefinitionId: null }]);
  });
  it('admits a manual deferred panel without preapproving its trigger authoring or exceeding Run depth', async () => {
    const { deps } = fixture();
    const source = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [
      { kind: 'wait', id: 'choose', document: { text: 'Choose planners', references: [], attachments: [] },
        result: { kind: 'json', schema: { type: 'array', items: { type: 'string' } } } },
      { kind: 'action', id: 'panel', actionId: 'subagents.plan.start', input: {
        target: { kind: 'literal', value: { kind: 'detached' } },
        instructions: { kind: 'literal', value: 'Plan the change' },
        backendTargetKeys: { kind: 'result', producer: { blockId: 'choose', scope: { kind: 'current' } }, path: [] },
      } },
    ] });
    const admitted: string[] = [];
    const actions = createWorkflowTriggerActions({ ...deps,
      automations: { ...deps.automations, runNow: async (automationId) => {
        admitted.push(automationId); return manualReceipt(automationId);
      } },
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } }),
    });
    const caller = { ...ownCaller, agentStartContext: { ...ownCaller.agentStartContext, workDepthLimit: 1 } };
    await expect(actions.add({ target: { kind: 'inline', definition: source }, project, trigger }, caller))
      .rejects.toMatchObject({ code: 'definition_exceeds_authority' });
    const added = await actions.add({ target: { kind: 'inline', definition: source }, project, trigger });
    await expect(actions.runNow({ automationId: added.set.automationId }, caller))
      .resolves.toEqual(manualReceipt(added.set.automationId));
    await expect(actions.runNow({ automationId: added.set.automationId }, { ...caller,
      agentStartContext: { ...caller.agentStartContext, caller: { ...caller.agentStartContext.caller, turnDepth: 1 } },
    })).rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(admitted).toEqual([added.set.automationId]);
  });

  it.each(['agent', 'host', 'birth'] as const)('checks typed Action-only trigger Session authority for its %s authorizer', async authorizer => {
    const { deps, rows } = fixture();
    const address = { serverId: 'home', sessionId: 'unrelated-session' };
    const authored = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [{ name: 'reviewSession',
      valueType: 'json', required: true, inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments',
      actionId: 'reviews.comments.list', input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] });
    const actions = createWorkflowTriggerActions({ ...deps, resolveMaterializer: async () => ({ effects: {
      resolveTargetAvailability: async () => true, resolveSessionTarget: async () => ({ address, machineId: project.machineId }),
      readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }),
    } }) });
    const caller = authorizer === 'host' ? { surface: 'ui' as const, authority: 'present_user' as const } : { ...ownCaller,
      defaultSessionId: 'session-one', actionCaller: { ...ownCaller.agentStartContext.caller } };
    const request = { target: { kind: 'inline' as const, definition: authored }, trigger, inputs: { reviewSession: address } };
    const pending = authorizer === 'birth'
      ? actions.prepareSessionInitialTriggers({ project, initialTriggers: [request], caller })
      : actions.add({ ...request, project }, caller);
    if (authorizer !== 'host') {
      await expect(pending).rejects.toMatchObject({ code: 'subtree_denied' });
      expect(rows.size).toBe(0);
    } else {
      await expect(pending).resolves.toMatchObject({ set: { health: 'available' } });
      expect(rows.size).toBe(1);
    }
  });

  it.each(['current_only', 'birth', 'nested', 'plugin', 'mcp', 'own', 'led', 'birth_own', 'birth_led', 'human', 'wrong_caller', 'foreign_home'] as const)(
    'admits typed trigger targets with starter authority rather than readable-child authority: %s', async scenario => {
      const f = fixture();
      const birth = scenario === 'birth' || scenario === 'birth_own' || scenario === 'birth_led';
      const address = { serverId: scenario === 'foreign_home' ? 'other-home' : 'home',
        sessionId: scenario === 'own' || scenario === 'birth_own' || scenario === 'foreign_home' ? 'session-one' : 'readable-child' };
      const child = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [{ name: 'reviewSession',
        valueType: 'json', required: true, inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments',
        actionId: 'reviews.comments.list', input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] });
      const pluginRef = 'plugin:external.workflow/review';
      const authored = scenario === 'nested' ? WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [{
        kind: 'workflow', id: 'child', workflowRef: pluginRef, input: { reviewSession: { kind: 'literal', value: address } },
      }] }) : child;
      const sessionList: NonNullable<ActionExecutorDeps['sessionList']> = async () => markSessionListQueryResultV1({
        sessions: [{ id: address.sessionId, active: false, presence: 'offline', updatedAt: 1 }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      });
      const sessionRead: NonNullable<ActionExecutorDeps['sessionRead']> = async ({ sessionIds }) => createSessionMembershipReadFixture(sessionIds, [address.sessionId]);
      const caller: ActionExecutorContext = scenario === 'human'
        ? { surface: 'ui', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } }
        : { ...ownCaller, serverId: 'home', defaultSessionId: 'session-one', defaultSessionMachineId: project.machineId,
          authority: 'account_automation', callerPermissionMode: 'default', surface: scenario === 'mcp' ? 'mcp' : 'agent',
          actionCaller: { ...ownCaller.agentStartContext.caller },
          sessionListAccess: scenario === 'led' || scenario === 'birth_led' ? 'led_subtree' : 'current_session',
          // Captured readable/led facts cannot broaden the host's current-only start grant.
          agentStartContext: { ...ownCaller.agentStartContext, ledSubtreeSessionIds: [address.sessionId],
            ...(scenario === 'wrong_caller' ? { caller: { ...ownCaller.agentStartContext.caller, sessionId: 'another-caller' } } : {}) },
        };
      const pluginSources = () => [{ workflow: pluginRef, pluginId: 'external.workflow', version: '1', title: 'Review', definition: child }];
      const actions = createWorkflowTriggerActions({ ...f.deps, sessionList, sessionRead,
        resolveSession: async () => ({ project, nativeGoalOwner: false }),
        resolveWorkflow: async ref => {
          const resolved = await resolveWorkflowDefinitionRefV1(ref, { readPluginWorkflows: pluginSources });
          if (!resolved) throw new Error('source_unavailable');
          return resolved;
        },
        resolveMaterializer: async () => ({ effects: {
          readWorkflowDefinition: async () => ({ definition: child, sourceKey: pluginRef, version: '1' }),
          resolveTargetAvailability: async () => true,
          resolveSessionTarget: async () => ({ address, machineId: project.machineId }),
          readActionContract: async actionId => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(actionId)))),
        } }),
      });
      if (scenario === 'current_only' || scenario === 'birth') {
        // Deliberately keep the real read owner permissive: borrowing its Action
        // identity to populate starter witnesses must fail this composed test.
        await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', address, caller,
          { sessionId: 'current_session' }, { sessionList, sessionRead })).resolves.toBeNull();
      }
      const target = scenario === 'plugin' ? { kind: 'workflow' as const, ref: pluginRef }
        : { kind: 'inline' as const, definition: authored };
      const request = { target, trigger, ...(scenario === 'nested' ? {} : { inputs: { reviewSession: address } }) };
      const positive = ['own', 'led', 'birth_own', 'birth_led', 'human'].includes(scenario);
      if (birth) {
        const pending = actions.prepareSessionInitialTriggers({ project, initialTriggers: [request], caller });
        if (positive) {
          const prepared = await pending;
          expect(SessionInitialTriggerAdmissionV1Schema.parse(prepared[0])).toMatchObject({ executionRecipe: { v: 2 } });
          expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(prepared[0]?.executionRecipe))
            .toMatchObject({ workflow: { t: 'plain', v: { inputs: { reviewSession: address } } } });
        } else await expect(pending).rejects.toMatchObject({ code: 'subtree_denied' });
        expect(f.rows.size).toBe(0);
        return;
      }
      const result = await f.executor(actions, { resolveAgentStartContext: async () => ownCaller.agentStartContext })
        .execute('session.trigger.add', { ...request, sessionId: 'session-one' }, caller);
      if (!positive) {
        expect(result).toMatchObject({ ok: false, errorCode: scenario === 'wrong_caller' ? 'target_unavailable' : 'subtree_denied' });
        expect(f.rows.size).toBe(0);
        return;
      }
      expect(result).toMatchObject({ ok: true, result: { set: { health: 'available' } } });
      expect(f.rows.size).toBe(1);
      const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse([...f.rows.values()][0]?.executionRecipe);
      expect(recipe).toMatchObject({ workflow: { t: 'plain', v: { inputs: { reviewSession: address }, inlineDefinition: child } } });
      expect(SessionTriggerListResultV1Schema.parse(await actions.sessionList({ sessionId: 'session-one' }, caller)).sets)
        .toMatchObject([{ context: { inputs: { reviewSession: address } } }]);
    });

  it('admits the exact human-approved review target without widening the proposing Session authority', async () => {
    const f = fixture();
    const address = { serverId: 'home', sessionId: 'unrelated-session' };
    const authored = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [{ name: 'reviewSession',
      valueType: 'json', required: true, inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments',
      actionId: 'reviews.comments.list', input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] });
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveMaterializer: async () => ({ effects: {
      resolveTargetAvailability: async () => true, resolveSessionTarget: async () => ({ address, machineId: project.machineId }),
      readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }),
    } }) });
    let storedRequest: ApprovalRequest | null = null;
    const executor = f.executor(actions, {
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'review-target-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
        && origin.caller.kind === 'session' && origin.caller.sessionId === 'session-one',
    });
    const caller: ActionExecutorContext = { ...ownCaller, serverId: 'home', defaultSessionId: 'session-one',
      defaultSessionMachineId: project.machineId, authority: 'account_automation', callerPermissionMode: 'default',
      actionRequestId: 'review-target-request', actionCaller: { ...ownCaller.agentStartContext.caller } };
    const request = { target: { kind: 'inline' as const, definition: authored }, project, trigger, inputs: { reviewSession: address } };
    await expect(actions.add(request, caller)).rejects.toMatchObject({ code: 'subtree_denied' });
    expect(await executor.execute('workflow.trigger.add', request, caller))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.size).toBe(0);
    expect(storedRequest).toMatchObject({ actionArgs: { inputs: { reviewSession: address } }, executionOriginV1: {
      caller: { kind: 'session', sessionId: 'session-one' },
    } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'review-target-approval', decision: 'approve' }, caller))
      .toMatchObject({ ok: false });
    expect(f.rows.size).toBe(0);
    const replay = await executor.execute('approval.request.decide', { artifactId: 'review-target-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' },
    });
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
    expect([...f.rows.values()]).toMatchObject([{ executionRecipe: { v: 2,
      workflow: { t: 'plain', v: { inputs: { reviewSession: address } } },
    } }]);
    expect(storedRequest).toMatchObject({ status: 'executed', execution: { ok: true }, executionOriginV1: {
      caller: { kind: 'session', sessionId: 'session-one' },
    } });
    await expect(actions.add(request, caller)).rejects.toMatchObject({ code: 'subtree_denied' });
  });

  it('admits Account agent add/update through the same materialized ORC trigger policy', async () => {
    const { deps, rows } = fixture();
    const admitted: string[] = [];
    const actions = createWorkflowTriggerActions({ ...deps,
      automations: { ...deps.automations, runNow: async (automationId) => {
        admitted.push(automationId); return manualReceipt(automationId);
      } },
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger }, ownCaller);
    expect(added.set.health).toBe('available');
    const retained = rows.get(added.set.automationId);
    await expect(actions.runNow({ automationId: added.set.automationId }, ownCaller))
      .resolves.toEqual(manualReceipt(added.set.automationId));
    await expect(actions.runNow({ automationId: added.set.automationId }, { ...ownCaller,
      agentStartContext: { ...ownCaller.agentStartContext, caller: { ...ownCaller.agentStartContext.caller, turnDepth: 4 } },
    })).rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(admitted).toEqual([added.set.automationId]);
    expect(rows.get(added.set.automationId)).toBe(retained);
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { enabled: false } }, ownCaller);
    expect(updated.set.enabled).toBe(false);
    await expect(actions.add({ workflow, project, trigger }, { ...ownCaller,
      agentStartContext: { ...ownCaller.agentStartContext, caller: { ...ownCaller.agentStartContext.caller, turnDepth: 4 } },
    })).rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(rows.size).toBe(1);
  });
  it('keeps transient source reads retryable in the trigger list', async () => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    await actions.add({ workflow, project, trigger });
    const failure = Object.assign(new Error('Home unavailable'), { code: 'ECONNRESET' });
    const reader = createWorkflowTriggerActions({ ...deps, resolveWorkflow: async () => { throw failure; } });
    await expect(reader.list({ workflow })).rejects.toBe(failure);
  });
  it('uses the Automation owner filters for workflow, inline and scoped reads and deletion', async () => {
    const { deps } = fixture();
    const inputs: unknown[] = [];
    const actions = createWorkflowTriggerActions({ ...deps, automations: { ...deps.automations,
      list: async (input) => { inputs.push(input); return { automations: [], nextCursor: null }; },
      listDetails: async (input) => { inputs.push(input); return { automations: [], nextCursor: null }; } },
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    await actions.list({ workflow });
    await actions.list({ scope: 'account_inline' });
    await actions.sessionList({ sessionId: 'session-one' });
    await actions.removeForWorkflow(workflow);
    expect(inputs).toEqual([{ workflowDefinitionId: workflow }, { scope: 'account_inline' },
      { scopeSessionId: 'session-one' }, { workflowDefinitionId: workflow }]);
  });
  it('refuses agent writes when materialized trigger policy is absent', async () => {
    const { actions, rows } = fixture();
    await expect(actions.add({ target: { kind: 'inline', definition }, project, trigger }, { surface: 'agent' }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(rows.size).toBe(0);
  });
  it('attaches, lists, updates and removes scoped triggers using the authorized Session placement', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const scopedDefinition = WorkflowDefinitionV1Schema.parse({ ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'origin_session' } } });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition: scopedDefinition }, trigger,
      onComplete: { kind: 'originating_session' } });
    expect(rows.get(added.set.automationId)).toMatchObject({ scopeSessionId: 'session-one', assignments: [{ machineId: project.machineId }] });
    expect(added.set.context).toMatchObject({ workspace: { directory: project.directory }, onComplete: { kind: 'originating_session' } });
    expect(added.set.destinations).toMatchObject({ targetSessionIds: ['session-one'] });
    expect((await actions.sessionList({ sessionId: 'session-other' })).sets).toEqual([]);
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([]);
    const updated = await actions.sessionUpdate({ sessionId: 'session-one', triggerId: added.triggerId!, expectedRevision: added.set.revision,
      patch: { enabled: false } });
    expect(updated.set.triggers[0]?.enabled).toBe(false);
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! });
    expect((await actions.sessionList({ sessionId: 'session-one' })).sets[0]?.triggers).toEqual([]);
  });
  it('deletes an empty Session trigger set through the Account Action and strict receipt reader', async () => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! });
    const result = await f.executor(actions).execute('workflow.trigger.remove', { automationId: added.set.automationId }, {
      surface: 'ui', authority: 'present_user', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: { 'workflow.trigger.remove': ['ui'] } }),
    });
    expect(result).toMatchObject({ ok: true, result: { automationId: added.set.automationId, deleted: true } });
    if (!result.ok) throw new Error(result.errorCode);
    expect(WorkflowTriggerRemoveResultV1Schema.parse(result.result)).toEqual({ automationId: added.set.automationId, deleted: true });
    expect(f.rows.has(added.set.automationId)).toBe(false);
  });
  it('executes approved CLI deletion of an empty Session trigger set through the same owner', async () => {
    const f = fixture();
    const actions = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! });
    let approval: ApprovalRequest | null = null;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'workflow.trigger.remove': { approvalRequiredSurfaces: ['cli'] } } });
    const executor = f.executor(actions, {
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'remove-approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
        && origin.accountId === 'owner' && origin.caller.kind === 'host',
    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
      runtimeAccountId: 'owner', actionRequestId: 'remove-request', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('workflow.trigger.remove', { automationId: added.set.automationId }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.rows.has(added.set.automationId)).toBe(true);
    expect(await executor.execute('approval.request.decide', { artifactId: 'remove-approval', decision: 'approve' }, context))
      .toMatchObject({ ok: true });
    const terminal = ApprovalRequestV2Schema.parse(approval);
    expect(terminal).toMatchObject({ status: 'executed', execution: { ok: true,
      result: { automationId: added.set.automationId, deleted: true } } });
    expect(f.rows.has(added.set.automationId)).toBe(false);
  });
  it('keeps Session scope authority when whole-set removal crosses the workflow Action adapter', async () => {
    const f = fixture();
    const triggers = createWorkflowTriggerActions({ ...f.deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const added = await triggers.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    const action = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, triggers, definitions: f.definitions,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } } });
    const input = { automationId: added.set.automationId };
    expect(await action({ actionId: 'workflow.trigger.remove', input, context: {
      surface: 'agent', actionCaller: { kind: 'session', sessionId: 'unrelated-session' },
    } })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(f.rows.has(added.set.automationId)).toBe(true);
    expect(await action({ actionId: 'workflow.trigger.remove', input, context: {
      surface: 'agent', actionCaller: { kind: 'session', sessionId: 'session-one' },
    } })).toMatchObject({ automationId: added.set.automationId, deleted: true });
    expect(f.rows.has(added.set.automationId)).toBe(false);
  });
  it('refuses native Keep going for humans and agents and never accepts caller placement', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: true }) });
    for (const caller of [undefined, ownCaller]) {
      await expect(actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }, caller))
        .rejects.toMatchObject({ code: 'native_goal_owner' });
    }
    const unauthorizedPlacement = { sessionId: 'session-one', target: { kind: 'inline' as const, definition }, trigger,
      project: { machineId: 'elsewhere', directory: '/elsewhere' } };
    await expect(actions.sessionAdd(unauthorizedPlacement)).rejects.toMatchObject({ code: 'invalid_input',
      details: { code: 'session_trigger_project_mismatch' } });
    expect(rows.size).toBe(0);
  });
  it('reads and removes scoped triggers without requiring a reachable native goal control', async () => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async (_sessionId, _caller, options) => {
      // The Session transport is reachable, but its opened-runtime RPC is not.
      if (options?.checkNativeGoalOwner !== false) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
      return { project, nativeGoalOwner: null };
    } });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    expect((await actions.sessionList({ sessionId: 'session-one' })).sets).toHaveLength(1);
    expect((await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! })).set.triggers).toEqual([]);
    await expect(actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
  });
  it('refuses scoped Event updates without Channel permission evidence but permits removal', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    const row = rows.get(added.set.automationId)!;
    // Persisted network input may predate this Action's Channel-aware writer.
    rows.set(row.id, { ...row, triggers: [{ id: added.triggerId!, revision: 0, enabled: false, createdAt: 1, updatedAt: 1,
      kind: 'pluginEvent', eventRef: { pluginId: 'happier.channel.github', localId: 'pull-request-comment' }, sourceSelectorId: 'source',
      sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null,
      sourceCatalogStatus: null, triggerDefinitionEnvelope: '{}',
    }] });
    await expect(actions.sessionUpdate({ sessionId: 'session-one', triggerId: added.triggerId!, expectedRevision: added.set.revision,
      patch: { enabled: true } })).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(rows.get(row.id)?.triggers[0]?.enabled).toBe(false);
    expect((await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! })).set.triggers).toEqual([]);
  });
  it('admits direct own-session agent writes through ORC and denies unrelated Session writes', async () => {
    const { deps, rows, executor } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }),
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const caller = ownCaller;
    const boundary = executor(actions);
    expect(await boundary.execute('session.trigger.add', { sessionId: 'unrelated', target: { kind: 'inline', definition }, trigger }, caller))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(await boundary.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, {
      ...caller, agentStartContext: { ...caller.agentStartContext, caller: { ...caller.agentStartContext.caller, turnDepth: 4 } },
    })).toMatchObject({ ok: false, errorCode: 'work_depth_exceeded' });
    expect(rows.size).toBe(0);
    expect(await boundary.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, caller))
      .toMatchObject({ ok: true, result: { set: { health: 'available' } } });
  });
  it.each(['read', 'read_after_await', 'read_after_projection', 'account_read', 'write', 'sealed_write', 'update', 'sealed_update'] as const)('admits a led Session once per trigger Action and applies withdrawal at the next admission: %s', async (operation) => {
    const { deps, rows, executor } = fixture();
    let accessible = true;
    let revokeDuringRead = false;
    let corpusReads = 0;
    const currentCorpus = {
      sessionRead: async ({ sessionIds }: Parameters<NonNullable<ActionExecutorDeps['sessionRead']>>[0]) => {
        corpusReads += 1;
        return createSessionMembershipReadFixture(sessionIds, accessible ? ['report'] : []);
      },
    };
    const actions = createWorkflowTriggerActions({ ...deps, ...currentCorpus,
      automations: { ...deps.automations, listDetails: async input => {
        const page = await deps.automations.listDetails(input);
        if (revokeDuringRead) accessible = false;
        return page;
      } },
      resolveSession: async () => {
        if (revokeDuringRead) accessible = false;
        return { project, nativeGoalOwner: false };
      },
      resolveMaterializer: async () => {
        if (operation === 'write' || operation === 'update') accessible = false;
        return { effects: { resolveTargetAvailability: async () => true } };
      },
      sealContext: async (input) => {
        if (operation === 'sealed_write' || operation === 'sealed_update') accessible = false;
        return deps.sealContext(input);
      },
      openContext: async (row) => {
        if (operation === 'read_after_projection') accessible = false;
        return deps.openContext(row);
      },
    });
    const boundary = executor(actions);
    const caller = { ...ownCaller, defaultSessionId: 'session-one',
      agentStartContext: { ...ownCaller.agentStartContext, ledSubtreeSessionIds: ['report'] } };
    expect(await boundary.execute('session.trigger.list', { sessionId: 'report' }, caller))
      .toMatchObject({ ok: true, result: { sessionId: 'report', sets: [] } });
    // Exact membership is independent of active/archived list partitions.
    expect(corpusReads).toBe(1);
    corpusReads = 0;
    if (operation === 'read' || operation === 'read_after_await' || operation === 'read_after_projection' || operation === 'account_read') {
      if (operation === 'read_after_projection' || operation === 'account_read') {
        await actions.sessionAdd({ sessionId: 'report', target: { kind: 'inline', definition }, trigger });
      }
      accessible = operation !== 'read';
      revokeDuringRead = operation === 'read_after_await';
      if (operation === 'account_read') accessible = false;
      const result = operation === 'account_read'
        ? await boundary.execute('workflow.trigger.list', { scope: 'account_all' }, caller)
        : await boundary.execute('session.trigger.list', { sessionId: 'report' }, caller);
      expect(result).toMatchObject(operation === 'read' ? { ok: false, errorCode: 'subtree_denied' } : { ok: true });
      expect(corpusReads).toBe(operation === 'account_read' ? 0 : 1);
    } else if (operation === 'update' || operation === 'sealed_update') {
      const added = await actions.sessionAdd({ sessionId: 'report', target: { kind: 'inline', definition }, trigger });
      accessible = true;
      const result = await boundary.execute('session.trigger.update', { sessionId: 'report', triggerId: added.triggerId!,
        expectedRevision: added.set.revision, patch: { enabled: false } }, caller);
      expect(result).toMatchObject({ ok: true });
      expect(rows.get(added.set.automationId)?.triggers[0]?.enabled).toBe(false);
      expect(corpusReads).toBe(1);
    } else {
      expect(await boundary.execute('session.trigger.add', { sessionId: 'report', target: { kind: 'inline', definition }, trigger }, caller))
        .toMatchObject({ ok: true });
      expect(corpusReads).toBe(1);
    }
    if (operation === 'read' || operation === 'read_after_await') expect(rows.size).toBe(0);
    accessible = false;
    corpusReads = 0;
    expect(await boundary.execute('session.trigger.list', { sessionId: 'report' }, caller))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(corpusReads).toBe(1);
  });
  it('fails captured led Session access closed when the current corpus transport is unavailable', async () => {
    const { deps, executor } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    expect(await executor(actions).execute('session.trigger.list', { sessionId: 'report' }, { ...ownCaller,
      agentStartContext: { ...ownCaller.agentStartContext, ledSubtreeSessionIds: ['report'] } }))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
  });
  it('admits own and currently led Sessions while leaving Account triggers independent of Session access', async () => {
    const { deps, executor } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      sessionRead: async ({ sessionIds }) => createSessionMembershipReadFixture(sessionIds, ['report']),
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const boundary = executor(actions);
    for (const sessionId of ['session-one', 'report']) {
      expect(await boundary.execute('session.trigger.add', { sessionId, target: { kind: 'inline', definition }, trigger }, ownCaller))
        .toMatchObject({ ok: true, result: { set: { scopeSessionId: sessionId, health: 'available' } } });
      expect(await boundary.execute('session.trigger.list', { sessionId }, ownCaller))
        .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ scopeSessionId: sessionId })] } });
      const listed = await actions.sessionList({ sessionId }, ownCaller);
      expect(await boundary.execute('session.trigger.remove', { sessionId, triggerId: listed.sets[0]!.triggers[0]!.id }, ownCaller))
        .toMatchObject({ ok: true, result: { set: { scopeSessionId: sessionId, triggers: [] } } });
    }
    const presentUser = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
      presentUserConfirmation: { actionId: 'workflow.trigger.add' as const } };
    expect(await boundary.execute('workflow.trigger.add', { project, target: { kind: 'inline', definition }, trigger }, presentUser))
      .toMatchObject({ ok: true, result: { set: { scopeSessionId: null } } });
    expect(await boundary.execute('workflow.trigger.list', { scope: 'account_inline' }, presentUser))
      .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ scopeSessionId: null })] } });
  });
  it('finishes an admitted led Session removal when access is withdrawn during its read', async () => {
    const { deps, rows, executor } = fixture();
    let accessible = true;
    let revokeDuringRead = false;
    const actions = createWorkflowTriggerActions({ ...deps,
      sessionRead: async ({ sessionIds }) => createSessionMembershipReadFixture(sessionIds, accessible ? ['report'] : []),
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      automations: { ...deps.automations, get: async (id) => {
        const row = await deps.automations.get(id);
        if (revokeDuringRead) accessible = false;
        return row;
      } },
    });
    const added = await actions.sessionAdd({ sessionId: 'report', target: { kind: 'inline', definition }, trigger });
    revokeDuringRead = true;
    expect(await executor(actions).execute('session.trigger.remove', { sessionId: 'report', triggerId: added.triggerId! }, { ...ownCaller,
      agentStartContext: { ...ownCaller.agentStartContext, ledSubtreeSessionIds: ['report'] } }))
      .toMatchObject({ ok: true });
    expect(rows.get(added.set.automationId)?.triggers).toHaveLength(0);
  });
  it('permits an originless run to remove exactly its own firing trigger without opening a missing source', async () => {
    const { deps, rows, loseSource, executor } = fixture();
    let firing: { sessionId: string; triggerId: string; automationId: string } | null = null;
    let revokeDuringRead = false;
    let claimReads = 0;
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }),
      resolveRunTrigger: async () => { claimReads += 1; return firing; },
      automations: { ...deps.automations, get: async (id) => {
        const row = await deps.automations.get(id);
        if (revokeDuringRead) firing = null;
        return row;
      } },
    });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    firing = { sessionId: 'session-one', triggerId: added.triggerId!, automationId: added.set.automationId };
    const caller = { surface: 'agent' as const, actionCaller: { kind: 'workflowRun' as const, runId: 'run-one',
      authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const } } };
    const boundary = executor(actions);
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'other', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: 'other-trigger' }, caller))
      .toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    loseSource();
    revokeDuringRead = true;
    claimReads = 0;
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: true, result: { set: { triggers: [] } } });
    expect(rows.get(added.set.automationId)?.triggers).toHaveLength(0);
    expect(claimReads).toBe(1);
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    revokeDuringRead = false;
    firing = { sessionId: 'session-one', triggerId: added.triggerId!, automationId: added.set.automationId };
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: true, result: { set: { triggers: [] } } });
    // The permitted coalesced occurrence still carries this exact claim after
    // the first occurrence removed the trigger. An unrelated id never does.
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: true, result: { set: { automationId: added.set.automationId, triggers: [] } } });
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: 'unrelated-trigger' }, caller))
      .toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! },
      { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    rows.set(added.set.automationId, { ...rows.get(added.set.automationId)!, scopeSessionId: 'foreign-session' });
    expect(await boundary.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: added.triggerId! }, caller))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it('consumes session trigger writes directly through the real Action executor without an approval', async () => {
    const { deps, rows } = fixture();
    let nativeGoalOwner = false;
    const triggers = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner }),
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [] }), read: async () => null,
      create: async () => { throw new Error('Unexpected Artifact write'); },
      update: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => ({ ok: true }),
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: async () => undefined });
    const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, triggers,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } },
    }) });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, ownCaller))
      .toMatchObject({ ok: true, result: { set: { health: 'available' } } });
    expect(rows.size).toBe(1);
    nativeGoalOwner = true;
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }, ownCaller))
      .toMatchObject({ ok: false, errorCode: 'native_goal_owner' });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger: {
      kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one', events: ['sessionStarted'], policy: { kind: 'everyMatch' },
    } }, ownCaller)).toMatchObject({ ok: false, errorCode: 'session_already_started' });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger: {
      kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'foreign-session', events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
    } }, ownCaller)).toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(rows.size).toBe(1);
    const [row] = rows.values();
    expect(await executor.execute('session.trigger.remove', {
      sessionId: 'session-one', triggerId: row!.triggers[0]!.id,
    }, ownCaller)).toMatchObject({ ok: true, result: { set: { triggers: [] } } });
    expect(rows.get(row!.id)?.triggers).toEqual([]);
  });
});
