import * as z from '../../zodRuntimePolicy.js';
import { AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1 } from '../../automations/automationApiV3.js';
import type {
  AutomationDefinitionCreateRequest,
  AutomationDefinitionDetail,
  AutomationDefinitionListItem,
  AutomationDefinitionPatchRequest,
  AutomationDefinitionReconcileRequest,
  AutomationTriggerReconcileExistingItem,
} from '../../automations/automationApiV3.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from '../../automations/automationAccountCurrentnessV1.js';
import { AutomationSourceSelectorIdV1Schema } from '../../automations/automationEventJsonBoundsV1.js';
import { pluginJsonValuesEqual } from '../../plugins/contributions/jsonSchemaValues.js';
import { arePluginMachineMaterializationRefsEqual } from '../../machines/administration/pluginMachineExecutionOriginV1.js';
import type { PluginMachineMaterializationRefV1 } from '../../plugins/availability/materializationRefV1.js';
import { AutomationEventTriggerDefinitionStoredPayloadV1Schema } from '../../automations/automationEventV1.js';
import {
  convertLegacyAutomationRecipeToInlineWorkflowV1,
} from '../../automations/automationLegacyWorkflowV1.js';
import { openAutomationTemplateStoredV1, readAutomationTemplateStoredEnvelopeV1,
  type AutomationTemplateRetainedSessionV1 } from '../../automations/automationTemplateStoredV1.js';
import {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationTriggerDefinitionSchema,
  AutomationPullRequestTriggerSchema,
  AutomationSessionLifecycleTriggerSchema,
  projectAutomationSessionLifecycleStructuralTrigger,
  type AutomationTriggerDefinition,
  type AutomationTriggerDefinitionInput,
} from '../../automations/automationTriggerDefinition.js';
import {
  AutomationTriggerDefinitionBindingV1Schema,
  AutomationTriggerDefinitionStoredPayloadV1Schema,
  automationTriggerHasPrivateDefinitionV1,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  createAutomationPluginEventTriggerDefinitionV1,
  sealAutomationPluginEventTriggerInputV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationTriggerDefinitionBindingV1,
} from '../../automations/automationTriggerDefinitionStoredContent.js';
import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationStoredWorkflowDefinitionV2ReadSchema,
  openAutomationStoredWorkflowDefinitionV2,
  type AutomationDefinitionDisplayV1,
  type AutomationStoredWorkflowDefinitionV2,
  type AutomationStoredWorkflowDefinitionRecipeV2,
} from '../../automations/automationWorkflowRecipeV2.js';
import {
  AutomationStoredActionDefinitionRecipeV1Schema,
  openAutomationStoredActionDefinitionTemplateV1,
  sealAutomationStoredActionDefinitionTemplateV1,
  type AutomationStoredActionDefinitionRecipeV1,
} from '../../automations/automationRunExecutionRecipeV1.js';
import {
  hasPrivateAutomationDefinitionDisplayCarrierV1,
  readAutomationDefinitionDisplayV1,
} from '../../automations/automationDefinitionDisplayReaderV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import { readTriggerTargetV1 } from '../../workflows/triggers/triggerTargetV1.js';
import {
  createWorkflowTriggerActions,
  readManagedMachineTriggerAction,
  readSavedHealthCheckSourceSnapshotV1,
  type WorkflowTriggerActionsDependencies,
  type WorkflowTriggerAutomationOperations,
  type WorkflowTriggerActions,
} from './workflowTriggerActions.js';
import type { WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { isConfirmedActionWriteRefusal, readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { DeploymentEnvironmentGetResultV1Schema } from '../../deployments/deploymentActionsV1.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from './types.js';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '../../deployments/healthCheckV1.js';
import {
  createSavedHealthTransitionSourceInstanceIdV1,
  HealthCheckSourceConfigV1Schema,
  isHealthCheckEventSourceV1,
  SavedHealthTransitionSourceV1Schema,
} from '../../deployments/healthCheckSourceV1.js';
import { canonicalizeAutomationSessionLifecycleStructuralConfiguration, projectAutomationSessionLifecycleStructuralConfiguration } from '../../automations/automationSessionLifecycle.js';
import { AutomationActionTriggerSchema, AutomationActionTriggerDefinitionEnvelopeV1Schema, projectAutomationActionTriggerStructuralV1, type AutomationActionTrigger } from '../../automations/automationActionTriggerV1.js';
import { unavailableActionAutomationMatchingV1 } from './actionAutomationAdmission.js';
import { readActionErrorCodeV1 } from '../actionErrorClassV1.js';
import type { AutomationStoredContentEnvelopeV1 } from '../../automations/automationStoredContentEnvelopeV1.js';
import { parseWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';

function unavailable(code = 'content_unavailable', details?: unknown): never {
  throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}

function bindSavedHealthTransitionHome<T extends AutomationTriggerDefinition>(trigger: T): T {
  if (trigger.kind !== 'pluginEvent' || 'triggerDefinitionEnvelope' in trigger || !trigger.subject
    || !isHealthCheckEventSourceV1(trigger)) return trigger;
  const selected = SavedHealthTransitionSourceV1Schema.safeParse(trigger.sourceConfig);
  if (!selected.success || selected.data.serverId === trigger.subject.serverId) return trigger;
  // The watcher reads this Account's saved transitions. Its emitted subject must use the Link's portable Home.
  const sourceConfig = { ...selected.data, serverId: trigger.subject.serverId };
  return {
    ...trigger,
    sourceConfig,
    sourceInstanceId: createSavedHealthTransitionSourceInstanceIdV1(trigger.eventRef.localId, sourceConfig),
  };
}

export type WorkflowTriggerAccountHostParams = Readonly<{
  workflowRequesterCustody?: WorkflowAccountRunActionDeps['workflowRequesterCustody'];
  /** The host's Account Automation HTTP transport; the host adds no trigger semantics. */
  automations: WorkflowTriggerAutomationOperations;
  /** Current validated Account encryption; throws typed when unavailable or stale. */
  resolveEncryption: () => Promise<AvailableAutomationAccountEncryptionV1>;
  /** Read opening may borrow the authenticated Account observation before final disclosure. */
  resolveReadEncryption?: () => Promise<AvailableAutomationAccountEncryptionV1>;
  /** Authenticated Session-mode/key custody, separate from ordinary plain Account material. */
  resolveRetainedSession?: (sessionId: string) => Promise<AutomationTemplateRetainedSessionV1 | null>;
  randomBytes: (length: number) => Uint8Array;
  newId: () => string;
}> & Pick<WorkflowTriggerActionsDependencies, 'nativeAccount' | 'deploymentAction' | 'sessionList' | 'sessionRead' | 'resolveAgentStartContext' | 'resolveWorkflow' | 'readWorkflowChildBodyVersions' | 'resolveWorkflowContent' | 'resolveWorkflowTeamIds' | 'resolveSession' | 'resolveRunTrigger' | 'resolveRunSource' | 'resolveManagedMachine' | 'resolveMaterializer' | 'pullRequests' | 'listContributedActionDefinitions'>;

type WorkflowCodecParams = Pick<WorkflowTriggerAccountHostParams, 'resolveEncryption' | 'randomBytes' | 'deploymentAction'>;

function openWorkflowEnvelope(raw: unknown, current: AvailableAutomationAccountEncryptionV1): AutomationStoredWorkflowDefinitionV2 {
  const opened = openAutomationStoredWorkflowDefinitionV2({ workflow: raw, encryption: current });
  if (opened.kind !== 'available') unavailable();
  return opened.definition;
}

/** Every authoring host and the one-shot migration use this same seal and relationship derivation. */
async function sealWorkflowContext(params: WorkflowCodecParams, input: Readonly<{
  templateVersion: number; context: AutomationStoredWorkflowDefinitionV2;
  caller?: ActionExecutorContext;
  deploymentEnvironment?: AutomationStoredWorkflowDefinitionRecipeV2['deploymentEnvironment'];
}>) {
  const payload = AutomationStoredWorkflowDefinitionV2Schema.parse(input.context);
  let deploymentEnvironment = input.deploymentEnvironment;
  const preview = payload.deploymentPreview;
  if (preview && (!deploymentEnvironment || deploymentEnvironment.serverId !== preview.serverId
    || deploymentEnvironment.environmentId !== preview.environmentId || deploymentEnvironment.previewRole !== 'preview_admission')) {
    if (!input.caller || !params.deploymentAction) unavailable('target_unavailable');
    const loaded = await params.deploymentAction('deployments.environments.get', preview, input.caller);
    const failure = readActionFailureEnvelope(loaded);
    if (failure) throw createActionExecuteFailureError(failure);
    const current = DeploymentEnvironmentGetResultV1Schema.safeParse(loaded);
    if (!current.success) unavailable('invalid_action_output');
    if (!current.data.ok) unavailable(current.data.error, current.data);
    deploymentEnvironment = { ...preview, projectSourceId: current.data.environment.projectSourceId,
      previewRole: 'preview_admission' };
  }
  const current = await params.resolveEncryption();
  const workflow = isAvailableE2eeAutomationAccountEncryptionV1(current)
    ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
      material: current.material.material, payload, randomBytes: params.randomBytes }) }
    : { t: 'plain' as const, v: payload };
  const managed = payload.inlineDefinition && readManagedMachineTriggerAction({ kind: 'inline', definition: payload.inlineDefinition });
  return AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: input.templateVersion,
    workflow, triggerEvidence: null, visibleTeamId: payload.visibleTeamId ?? null,
    ...(payload.workspace === undefined ? { placement: 'action_invocation' } : {}),
    ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
    managedTarget: managed ? { homeId: managed.input.homeId, managedId: managed.input.managedId } : null });
}

/**
 * One admitted client-startup pass, never a read/render subscription or polling effect.
 * Persisted recipe metadata is the completion marker. A lost response or restart cannot repeat
 * a committed write; a conflicting, locked or unavailable row remains unknown without a hot retry.
 */
export async function backfillAutomationManagedTargetsV1(params: WorkflowCodecParams & Readonly<{
  automations: Pick<WorkflowTriggerAutomationOperations, 'listDetails'> & Readonly<{
    patch: (automationId: string, input: AutomationDefinitionPatchRequest, beforeWrite?: () => Promise<void>) => Promise<AutomationDefinitionDetail>;
  }>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>): Promise<Readonly<{ updated: number; unresolved: number }>> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (params.isCurrent?.() === false) unavailable();
  };
  let updated = 0;
  let unresolved = 0;
  let legacyCursor: string | undefined;
  do {
    assertCurrent();
    const page = await params.automations.listDetails({ legacySessionLifecycleSelections: true,
      ...(legacyCursor ? { cursor: legacyCursor } : {}) });
    assertCurrent();
    for (const row of page.legacySessionLifecycleSelections ?? []) {
      assertCurrent();
      try {
        const openedEncryption = await params.resolveEncryption();
        assertCurrent();
        const sameAuthority = (current: AvailableAutomationAccountEncryptionV1) => {
          assertCurrent();
          assertSameAccountEncryption(openedEncryption, current);
        };
        const sessionLifecycleMigrations = row.selections.map(selection => ({
          triggerId: selection.triggerId, expectedRevision: selection.triggerRevision,
          triggerDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(isAvailableE2eeAutomationAccountEncryptionV1(openedEncryption)
              ? { mode: 'e2ee' as const, material: openedEncryption.material.material, randomBytes: params.randomBytes }
              : { mode: 'plain' as const }),
            binding: AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: row.automationId,
              triggerId: selection.triggerId, triggerRevision: selection.triggerRevision, triggerKind: 'sessionLifecycle' }),
            definition: AutomationSessionLifecycleTriggerSchema.parse({ kind: 'sessionLifecycle',
              subject: selection.subject, events: selection.events, policy: selection.policy }),
          }),
        }));
        const beforeWrite = async () => { sameAuthority(await params.resolveEncryption()); };
        await beforeWrite();
        await params.automations.patch(row.automationId, {
          expectedTemplateVersion: row.expectedTemplateVersion, sessionLifecycleMigrations,
        }, beforeWrite);
        updated++;
      } catch {
        assertCurrent();
        unresolved++;
      }
    }
    legacyCursor = page.nextCursor ?? undefined;
  } while (legacyCursor);
  let cursor: string | undefined;
  do {
    assertCurrent();
    const page = await params.automations.listDetails({ managedTargetUnindexed: true, ...(cursor ? { cursor } : {}) });
    assertCurrent();
    for (const row of page.automations) {
      assertCurrent();
      try {
        if (row.managedTarget !== undefined) continue;
        if (row.executionRecipe?.v !== 2) { unresolved++; continue; }
        const openedEncryption = await params.resolveEncryption();
        assertCurrent();
        const context = AutomationStoredWorkflowDefinitionV2ReadSchema.parse(openWorkflowEnvelope(row.executionRecipe.workflow, openedEncryption));
        if (readTriggerTargetV1(row, context).kind !== 'available') unavailable('source_unavailable');
        const sameAuthority = (current: AvailableAutomationAccountEncryptionV1) => {
          assertCurrent();
          assertSameAccountEncryption(openedEncryption, current);
          return current;
        };
        const executionRecipe = await sealWorkflowContext({ ...params,
          resolveEncryption: async () => sameAuthority(await params.resolveEncryption()) }, {
          templateVersion: row.templateVersion + 1, context, deploymentEnvironment: row.executionRecipe.deploymentEnvironment,
        });
        const beforeWrite = async () => { sameAuthority(await params.resolveEncryption()); };
        await beforeWrite();
        // A metadata-only edit need not advance the recipe revision. Patch only the recipe so
        // this migration cannot overwrite a concurrent rename, enablement or placement change.
        await params.automations.patch(row.id, { expectedTemplateVersion: row.templateVersion, executionRecipe }, beforeWrite);
        updated++;
      } catch (error) {
        assertCurrent();
        unresolved++;
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { updated, unresolved };
}

const eventBinding = (automationId: string, triggerId: string, triggerRevision: number,
    eventRef: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>['eventRef'], sourceSelectorId: string) => {
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId, triggerId, triggerRevision,
      triggerKind: 'pluginEvent', eventRef, sourceSelectorId });
    if (binding.triggerKind !== 'pluginEvent') unavailable();
    return binding;
  };

const openEvent = (binding: AutomationTriggerDefinitionBindingV1, envelope: unknown, current: AvailableAutomationAccountEncryptionV1, storedRead = false) => {
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    return (storedRead ? createStoredReadSchema(AutomationEventTriggerDefinitionStoredPayloadV1Schema)
      : AutomationEventTriggerDefinitionStoredPayloadV1Schema).parse(opened.definition);
  };
export const readAccountStoredPluginEventTriggerV1 = (row: AutomationDefinitionDetail, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find((item) => item.id === triggerId);
    if (!trigger || trigger.kind !== 'pluginEvent') unavailable();
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const binding = eventBinding(row.id, trigger.id, trigger.revision, trigger.eventRef, trigger.sourceSelectorId);
    return { trigger, binding, definition: openEvent(binding, envelope, current, true) };
  };

function assertStoredActionDefinitionMatches(definition: AutomationActionTrigger,
  trigger: Pick<ReturnType<typeof projectAutomationActionTriggerStructuralV1>,
    'phase' | 'actionIds' | 'subjectKey' | 'subjectKind' | 'mode' | 'onFailure'>) {
  const projected = projectAutomationActionTriggerStructuralV1(definition);
  if (projected.phase !== trigger.phase || !pluginJsonValuesEqual(projected.actionIds, trigger.actionIds)
    || projected.subjectKey !== trigger.subjectKey || projected.subjectKind !== trigger.subjectKind
    || projected.mode !== trigger.mode || projected.onFailure !== trigger.onFailure) unavailable();
}

export const readAccountStoredActionTriggerV1 = (row: Pick<AutomationDefinitionDetail, 'id' | 'triggers'>, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find(item => item.id === triggerId);
    if (!trigger || trigger.kind !== 'action' || 'consentFor' in trigger) unavailable();
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: row.id,
      triggerId, triggerRevision: trigger.revision, triggerKind: 'action' });
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const definition = openAccountActionDefinition(binding, envelope, current);
    assertStoredActionDefinitionMatches(definition, trigger);
    return { trigger, binding, definition };
  };

function openAccountActionDefinition(binding: AutomationTriggerDefinitionBindingV1, envelope: unknown,
  current: AvailableAutomationAccountEncryptionV1): AutomationActionTrigger {
  const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
    ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
      ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
  if (opened.kind !== 'available') unavailable();
  return AutomationActionTriggerSchema.parse(opened.definition);
}

/**
 * Every Account host (CLI/daemon and the UI front door) composes the one trigger owner through
 * this adapter: private Automation context uses Account material; saved-Workflow Action
 * definitions borrow that Artifact's associated-content codec. Hosts supply transport and crypto.
 */
function createAccountWorkflowTriggerActionOwner(params: WorkflowTriggerAccountHostParams) {
  const workflowContent = async (workflowId: string) => {
    if (!params.resolveWorkflowContent) unavailable();
    return params.resolveWorkflowContent(workflowId);
  };
  const openWorkflowAction = async (workflowId: string, binding: AutomationTriggerDefinitionBindingV1,
    content: AutomationStoredContentEnvelopeV1) => {
    const codec = await workflowContent(workflowId);
    const payload = await codec.openAssociatedContent(content);
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
      envelope: { t: 'plain', v: payload } });
    if (opened.kind !== 'available') unavailable();
    return AutomationActionTriggerSchema.parse(opened.definition);
  };
  const openOwnActionTrigger: NonNullable<WorkflowTriggerActionsDependencies['openOwnActionTrigger']> = async reference => {
    const envelope = reference.ownDefinitionEnvelope;
    if (!envelope) unavailable();
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: reference.automationId,
      triggerId: reference.triggerId, triggerRevision: reference.triggerRevision, triggerKind: 'action' });
    const current = await params.resolveEncryption();
    const definition = envelope.t === 'workflow' ? await openWorkflowAction(reference.workflowId, binding, envelope.content)
      : openAccountActionDefinition(binding, envelope, current);
    assertStoredActionDefinitionMatches(definition, reference);
    return definition;
  };
  const storedAction = async (row: AutomationDefinitionDetail, triggerId: string,
    current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find(item => item.id === triggerId);
    if (!trigger || trigger.kind !== 'action' || 'consentFor' in trigger) unavailable();
    const envelope = AutomationActionTriggerDefinitionEnvelopeV1Schema.parse(JSON.parse(trigger.triggerDefinitionEnvelope));
    if (envelope.t !== 'workflow') {
      return { ...readAccountStoredActionTriggerV1(row, triggerId, current), envelopeKind: envelope.t };
    }
    if (!row.workflowDefinitionId) unavailable();
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: row.id,
      triggerId, triggerRevision: trigger.revision, triggerKind: 'action' });
    const definition = await openWorkflowAction(row.workflowDefinitionId, binding, envelope.content);
    assertStoredActionDefinitionMatches(definition, trigger);
    return { trigger, binding, definition, envelopeKind: envelope.t };
  };
  const sealWorkflowAction = async (workflowId: string, binding: AutomationTriggerDefinitionBindingV1,
    definition: AutomationActionTrigger) => {
    const codec = await workflowContent(workflowId);
    const content = await codec.sealAssociatedContent(AutomationTriggerDefinitionStoredPayloadV1Schema.parse({ v: 1, binding, definition }));
    return AutomationActionTriggerDefinitionEnvelopeV1Schema.parse({ t: 'workflow', revision: codec.revision, content });
  };
  const readStoredLegacy = async (row: AutomationDefinitionDetail) => {
    if (row.templateCiphertext === undefined
      || (row.targetType !== 'newSession' && row.targetType !== 'existingSession')) unavailable('source_unavailable');
    const current = await params.resolveEncryption();
    const stored = readAutomationTemplateStoredEnvelopeV1(row.templateCiphertext);
    const retainedSession = current.witness.mode === 'plain' && row.targetType === 'existingSession' && stored?.legacyExistingSessionId
      ? await params.resolveRetainedSession?.(stored.legacyExistingSessionId) : undefined;
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: row.templateCiphertext,
      ...(retainedSession ? { retainedSession } : {}),
      accountMode: current.witness.mode, ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { material: current.material.material } : {}) });
    if (!opened.ok) unavailable(opened.code);
    const targetType = row.targetType === 'newSession' ? 'new_session' as const : 'existing_session' as const;
    return { template: opened.template, targetType, machineId: row.assignments.length === 1 ? row.assignments[0]!.machineId : null };
  };
  const legacyContext = (definition: WorkflowDefinitionV1,
    project: { directory: string; workspaceRefId?: string; machineId?: string }) => {
    const { machineId: _machineId, ...workspace } = project;
    const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace,
      executionTarget: { kind: 'session' }, inlineDefinition: definition });
    return { target: { kind: 'inline' as const, definition }, context,
      ...(project.machineId === undefined ? {} : { project: { machineId: project.machineId, ...workspace } }) };
  };
  const open = async (raw: unknown) => openWorkflowEnvelope(raw, await params.resolveEncryption());
  const openWorkflowDefinition = async (recipe: Pick<AutomationStoredWorkflowDefinitionRecipeV2, 'workflow'>) => {
    const current = await params.resolveEncryption();
    return { current, context: openWorkflowEnvelope(recipe.workflow, current) };
  };
  const sameEncryption = (before: AvailableAutomationAccountEncryptionV1) => async () => {
    const current = await params.resolveEncryption();
    assertSameAccountEncryption(before, current);
    return current;
  };
  const materializePrivateDisplay = <T extends AutomationDefinitionDetail | AutomationDefinitionListItem>(
    row: T,
    current: AvailableAutomationAccountEncryptionV1,
  ): T => {
    if (!hasPrivateAutomationDefinitionDisplayCarrierV1(row)) return row;
    const opened = readAutomationDefinitionDisplayV1({ definition: row, encryption: current });
    if (opened.kind !== 'available') unavailable();
    return { ...row, name: opened.display.name, description: opened.display.description };
  };
  const materializePrivateDetail = async (row: AutomationDefinitionDetail): Promise<AutomationDefinitionDetail> => {
    if (!hasPrivateAutomationDefinitionDisplayCarrierV1(row)) return row;
    return materializePrivateDisplay(row, await params.resolveEncryption());
  };
  const materializePrivateListItem = async (row: AutomationDefinitionListItem): Promise<AutomationDefinitionListItem> => {
    if (!hasPrivateAutomationDefinitionDisplayCarrierV1(row)) return row;
    return materializePrivateDisplay(row, await params.resolveEncryption());
  };
  const sealPrivateDisplay = async (recipe: Pick<AutomationStoredWorkflowDefinitionRecipeV2, 'workflow' | 'deploymentEnvironment'>,
    templateVersion: number, display: AutomationDefinitionDisplayV1) => {
    const opened = await openWorkflowDefinition(recipe);
    return sealWorkflowContext({ ...params, resolveEncryption: sameEncryption(opened.current) }, {
      templateVersion, context: { ...opened.context, display }, deploymentEnvironment: recipe.deploymentEnvironment,
    });
  };
  const openActionDefinition = async (recipe: AutomationStoredActionDefinitionRecipeV1) => {
    const current = await params.resolveEncryption();
    const opened = openAutomationStoredActionDefinitionTemplateV1({ template: recipe.template, encryption: current });
    if (opened.kind !== 'available') unavailable();
    return { current, template: opened.template };
  };
  const sealActionPrivateDisplay = async (recipe: AutomationStoredActionDefinitionRecipeV1,
    templateVersion: number, display: AutomationDefinitionDisplayV1) => {
    const opened = await openActionDefinition(recipe);
    const current = await sameEncryption(opened.current)();
    return AutomationStoredActionDefinitionRecipeV1Schema.parse({
      ...recipe,
      templateVersion,
      template: sealAutomationStoredActionDefinitionTemplateV1({
        template: { ...opened.template, display }, encryption: current, randomBytes: params.randomBytes,
      }),
    });
  };
  const sealCreatePrivateDisplay = async (input: AutomationDefinitionCreateRequest): Promise<AutomationDefinitionCreateRequest> => {
    if (input.observationOnly) {
      return { ...input, name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1, description: null };
    }
    if (input.executionRecipe?.v === 1 && input.executionRecipe.target.kind === 'contributedAction') {
      return {
        ...input,
        name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1,
        description: null,
        executionRecipe: await sealActionPrivateDisplay({ ...input.executionRecipe, target: input.executionRecipe.target }, input.executionRecipe.templateVersion, {
          name: input.name, description: input.description ?? null,
        }),
      };
    }
    if (input.executionRecipe?.v !== 2) return input;
    return {
      ...input,
      name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1,
      description: null,
      executionRecipe: await sealPrivateDisplay(input.executionRecipe, input.executionRecipe.templateVersion, {
        name: input.name, description: input.description ?? null,
      }),
    };
  };
  const sealReconcilePrivateDisplay = async (input: AutomationDefinitionReconcileRequest,
    row: AutomationDefinitionDetail, observationDisplayStored = false): Promise<AutomationDefinitionReconcileRequest> => {
    if (row.observationOnly) {
      if (!observationDisplayStored) {
        const opened = readAutomationDefinitionDisplayV1({ definition: row, encryption: await params.resolveEncryption() });
        if (opened.kind !== 'available') unavailable();
        if (opened.source === 'legacy') return input;
      }
      return { ...input, name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1, description: null };
    }
    const candidate = input.executionRecipe?.v === 1 ? input.executionRecipe
      : row.executionRecipe?.v === 1 && row.executionRecipe.target.kind === 'contributedAction'
        ? row.executionRecipe : null;
    const actionRecipe = candidate?.target.kind === 'contributedAction'
      ? { ...candidate, target: candidate.target } : null;
    if (actionRecipe) {
      const opened = await openActionDefinition(actionRecipe);
      const display = { name: input.name, description: input.description };
      if (input.executionRecipe === undefined && opened.template.display !== undefined
        && opened.template.display.name === display.name && opened.template.display.description === display.description) {
        return { ...input, name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1, description: null };
      }
      return {
        ...input,
        name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1,
        description: null,
        executionRecipe: await sealActionPrivateDisplay(actionRecipe,
          input.executionRecipe?.v === 1 ? input.executionRecipe.templateVersion : row.templateVersion + 1,
          display),
      };
    }
    const recipe = input.executionRecipe?.v === 2 ? input.executionRecipe
      : row.executionRecipe?.v === 2 ? row.executionRecipe : null;
    if (!recipe) return input;
    const opened = await openWorkflowDefinition(recipe);
    const display = { name: input.name, description: input.description };
    if (input.executionRecipe === undefined && opened.context.display !== undefined
      && opened.context.display.name === display.name && opened.context.display.description === display.description) {
      return { ...input, name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1, description: null };
    }
    return {
      ...input,
      name: AUTOMATION_PRIVATE_DISPLAY_PLACEHOLDER_V1,
      description: null,
      executionRecipe: await sealWorkflowContext({ ...params, resolveEncryption: sameEncryption(opened.current) }, {
        templateVersion: input.executionRecipe?.v === 2 ? input.executionRecipe.templateVersion : row.templateVersion + 1,
        context: { ...opened.context, display }, deploymentEnvironment: recipe.deploymentEnvironment,
      }),
    };
  };
  const pullRequestBinding = (automationId: string, triggerId: string, triggerRevision: number,
    triggerKind: 'prComment' | 'ciFailed') => AutomationTriggerDefinitionBindingV1Schema.parse({
      v: 1, automationId, triggerId, triggerRevision, triggerKind,
    });
  type ConfiguredEvent = Pick<ReturnType<typeof readAccountStoredPluginEventTriggerV1>['definition'], 'sourceInstanceId' | 'sourceConfig'> & Readonly<{
    eventRef: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>['eventRef'];
    watcher: PluginMachineMaterializationRefV1 | null;
  }>;
  const retainedWatcher = (trigger: ReturnType<typeof readAccountStoredPluginEventTriggerV1>['trigger']) =>
    trigger.observation.kind === 'durablePush' ? null : trigger.observation.watcher;
  const requestedEvent = (automationId: string, triggerId: string, revision: number,
    trigger: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1): ConfiguredEvent | null => {
    if (trigger.kind !== 'pluginEvent') return null;
    const definition = 'triggerDefinitionEnvelope' in trigger
      ? openEvent(eventBinding(automationId, triggerId, revision, trigger.eventRef, trigger.sourceSelectorId),
          trigger.triggerDefinitionEnvelope, current)
      : trigger;
    return { eventRef: trigger.eventRef, sourceInstanceId: definition.sourceInstanceId, sourceConfig: definition.sourceConfig,
      watcher: trigger.observationTransport.kind === 'durablePush' ? null : trigger.observationTransport.watcherMaterializationRef };
  };
  // Several Event declarations can observe one native configured source.
  // A declaration's localId must not give it a competing source configuration.
  const sameSourcePlugin = (left: ConfiguredEvent['eventRef'], right: ConfiguredEvent['eventRef']) =>
    left.pluginId === right.pluginId;
  const assertSourceConfigurations = async (automationId: string, candidates: readonly ConfiguredEvent[],
    current: AvailableAutomationAccountEncryptionV1, reuse?: (row: AutomationDefinitionDetail) => boolean) => {
    if (!candidates.length) return [];
    const retained: ConfiguredEvent[] = [];
    const retainedDefinitions: AutomationDefinitionDetail[] = [];
    let cursor: string | undefined;
    do {
      // Source identity/config are private in E2EE Accounts. The existing
      // Account census has no source selector: inspect public Event refs first,
      // and open only matching definitions under the current Account material.
      const page = await params.automations.list({ ...(cursor ? { cursor } : {}) });
      for (const summary of page.automations) {
        if (summary.id === automationId || !summary.triggers.some(trigger => trigger.kind === 'pluginEvent'
          && candidates.some(candidate => sameSourcePlugin(candidate.eventRef, trigger.eventRef)))) continue;
        const raw = await params.automations.get(summary.id);
        if (!raw) continue;
        // Current rows intentionally retain only a neutral display marker.
        // Source-consistency reuse must not later write that marker back over
        // the private display when it reconciles the retained definition.
        const row = materializePrivateDisplay(raw, current);
        retainedDefinitions.push(row);
        for (const trigger of row.triggers) {
          if (trigger.kind !== 'pluginEvent' || !candidates.some(candidate => sameSourcePlugin(candidate.eventRef, trigger.eventRef))) continue;
          const { definition } = readAccountStoredPluginEventTriggerV1(row, trigger.id, current);
          retained.push({ ...definition, eventRef: trigger.eventRef, watcher: retainedWatcher(trigger) });
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // Automatic Environment enrollment replays retain its admitted baseline.
    // Explicit source edits still pass the shared configuration consistency owner.
    if (reuse && retainedDefinitions.some(reuse)) return retainedDefinitions;
    for (const candidate of candidates) {
      for (const existing of retained) {
        if (!sameSourcePlugin(existing.eventRef, candidate.eventRef)
          || existing.sourceInstanceId !== candidate.sourceInstanceId) continue;
        const path = !pluginJsonValuesEqual(existing.sourceConfig, candidate.sourceConfig) ? '/trigger/sourceConfig'
          : existing.watcher !== null && candidate.watcher !== null
            && !arePluginMachineMaterializationRefsEqual(existing.watcher, candidate.watcher) ? '/trigger/observationTransport'
          : null;
        if (path) unavailable('invalid_input', { issues: [{
          code: 'invalid_input', path, severity: 'error',
          message: path === '/trigger/sourceConfig'
            ? 'This source already has a different configuration. Edit the saved source to make this change.'
            : 'This source already uses a different Machine. Edit the saved source to change its Machine.',
        }] });
      }
      // Compare the complete prospective set as well, without comparing a
      // replacement against its own old revision or ignoring retained siblings.
      retained.push(candidate);
    }
    return retainedDefinitions;
  };
  const openPullRequest = (binding: AutomationTriggerDefinitionBindingV1, envelope: unknown,
    current: AvailableAutomationAccountEncryptionV1, storedRead = false) => {
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    const parsed = (storedRead ? createStoredReadSchema(AutomationPullRequestTriggerSchema)
      : AutomationPullRequestTriggerSchema).safeParse(opened.definition);
    if (!parsed.success || parsed.data.kind !== binding.triggerKind) unavailable();
    return parsed.data;
  };
  const storedPullRequest = (row: AutomationDefinitionDetail, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find((item) => item.id === triggerId);
    if (!trigger || (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed')) unavailable();
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const binding = pullRequestBinding(row.id, trigger.id, trigger.revision, trigger.kind);
    return { trigger, binding, definition: openPullRequest(binding, envelope, current, true) };
  };
const storedSessionLifecycle = (row: AutomationDefinitionDetail, triggerId: string,
    current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find(item => item.id === triggerId);
    if (!trigger || trigger.kind !== 'sessionLifecycle') unavailable();
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: row.id,
        triggerId, triggerRevision: trigger.revision, triggerKind: 'sessionLifecycle' });
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
        ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
            ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    const definition = createStoredReadSchema(AutomationSessionLifecycleTriggerSchema).parse(opened.definition);
    if (!pluginJsonValuesEqual(projectAutomationSessionLifecycleStructuralConfiguration(definition),
        canonicalizeAutomationSessionLifecycleStructuralConfiguration(trigger))) unavailable();
    return { trigger, binding, definition };
};


  const prepareEvent = (automationId: string, triggerId: string, triggerRevision: number,
    trigger: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1,
    previous?: ReturnType<typeof readAccountStoredPluginEventTriggerV1>): AutomationTriggerDefinitionInput => {
    if (trigger.kind !== 'pluginEvent') return trigger;
    if ('triggerDefinitionEnvelope' in trigger) {
      openEvent(eventBinding(automationId, triggerId, triggerRevision, trigger.eventRef, trigger.sourceSelectorId),
        trigger.triggerDefinitionEnvelope, current);
      return trigger;
    }
    if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) return trigger;
    const sourceSelectorId = previous?.definition.sourceInstanceId === trigger.sourceInstanceId
      ? previous.trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse(params.newId());
    return sealAutomationPluginEventTriggerInputV1({ trigger,
      binding: eventBinding(automationId, triggerId, triggerRevision, trigger.eventRef, sourceSelectorId),
      seal: ({ binding, definition }) => AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
          randomBytes: params.randomBytes, binding, definition })),
    });
  };
  /** Health observations follow both phases; labels remain with their private source facts. */
  const prepareObservationTrigger = (automationId: string, triggerId: string, triggerRevision: number,
    trigger: AutomationTriggerDefinitionInput, display: AutomationDefinitionDisplayV1,
    current: AvailableAutomationAccountEncryptionV1): AutomationTriggerDefinitionInput => {
    if (trigger.kind !== 'pluginEvent') unavailable('invalid_input');
    const eventRef = isHealthCheckEventSourceV1(trigger) ? HEALTH_CHECK_EVENT_REFS_V1.status : trigger.eventRef;
    if (!('triggerDefinitionEnvelope' in trigger)) {
      return AutomationPluginEventDefinitionTriggerInputSchema.parse({ ...trigger, eventRef, automationDisplay: display });
    }
    if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) unavailable('modeMismatch');
    const binding = eventBinding(automationId, triggerId, triggerRevision, trigger.eventRef, trigger.sourceSelectorId);
    const definition = openEvent(binding, trigger.triggerDefinitionEnvelope, current);
    return AutomationPluginEventDefinitionTriggerInputSchema.parse({
      ...trigger,
      eventRef,
      triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
          randomBytes: params.randomBytes, binding: { ...binding, eventRef },
          definition: AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse({
            ...definition, automationDisplay: display,
          }) }),
      ),
    });
  };
  const resealRetainedObservationDisplay = (row: AutomationDefinitionDetail,
    trigger: Extract<AutomationDefinitionDetail['triggers'][number], { kind: 'pluginEvent' }>,
    enabled: boolean, display: AutomationDefinitionDisplayV1,
    current: AvailableAutomationAccountEncryptionV1): AutomationTriggerReconcileExistingItem => {
    const previous = readAccountStoredPluginEventTriggerV1(row, trigger.id, current);
    const binding = { ...previous.binding, triggerRevision: trigger.revision + 1 };
    const definition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse({
      ...previous.definition,
      automationDisplay: display,
    });
    return {
      kind: 'existing',
      triggerId: trigger.id,
      expectedRevision: trigger.revision,
      enabled,
      triggerDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
        ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
          ? { mode: 'e2ee' as const, material: current.material.material, randomBytes: params.randomBytes }
          : { mode: 'plain' as const }),
        binding,
        definition,
      }),
    };
  };
  const preparePrivateTrigger = async (automationId: string, triggerId: string, triggerRevision: number,
    trigger: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1,
    previous?: ReturnType<typeof readAccountStoredPluginEventTriggerV1>, workflowId?: string | null): Promise<AutomationTriggerDefinitionInput> => {
if (trigger.kind === 'sessionLifecycle') {
    const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId,
        triggerId, triggerRevision, triggerKind: 'sessionLifecycle' });
    if ('triggerDefinitionEnvelope' in trigger) {
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope: trigger.triggerDefinitionEnvelope,
            ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
                ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
        if (opened.kind !== 'available') unavailable();
        const definition = AutomationSessionLifecycleTriggerSchema.parse(opened.definition);
        if (!pluginJsonValuesEqual(projectAutomationSessionLifecycleStructuralConfiguration(definition),
            canonicalizeAutomationSessionLifecycleStructuralConfiguration(trigger))) unavailable();
        return trigger;
    }
    const { enabled: _enabled, ...definition } = trigger;
    return { ...projectAutomationSessionLifecycleStructuralTrigger(definition), enabled: trigger.enabled,
        triggerDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
                ? { mode: 'e2ee' as const, material: current.material.material, randomBytes: params.randomBytes }
                : { mode: 'plain' as const }), binding, definition,
        }) };
}

    if (trigger.kind === 'action' && !('consentFor' in trigger)) {
      const workflowReference = parseWorkflowDefinitionRefV1(workflowId);
      const artifactId = workflowReference?.kind === 'artifact' ? workflowReference.artifactId : null;
      const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId,
        triggerId, triggerRevision, triggerKind: 'action' });
      let definition: AutomationActionTrigger;
      if ('triggerDefinitionEnvelope' in trigger) {
        const envelope = trigger.triggerDefinitionEnvelope;
        if (envelope.t === 'workflow') {
          if (!artifactId) unavailable();
          definition = await openWorkflowAction(artifactId, binding, envelope.content);
        } else {
          const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
            ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
              ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
          if (opened.kind !== 'available') unavailable();
          definition = AutomationActionTriggerSchema.parse(opened.definition);
        }
        const projected = projectAutomationActionTriggerStructuralV1(definition);
        const { enabled: _enabled, triggerDefinitionEnvelope: _envelope, reachesOthers: _reach, ...header } = trigger;
        if (!pluginJsonValuesEqual(projected, header)) unavailable();
      } else {
        const { enabled: _enabled, ...authored } = trigger;
        definition = AutomationActionTriggerSchema.parse(authored);
      }
      return { ...projectAutomationActionTriggerStructuralV1(definition), enabled: trigger.enabled,
        triggerDefinitionEnvelope: artifactId ? await sealWorkflowAction(artifactId, binding, definition)
          : sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
              ? { mode: 'e2ee' as const, material: current.material.material, randomBytes: params.randomBytes }
              : { mode: 'plain' as const }), binding, definition,
          }) };
    }
    if (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed') return prepareEvent(automationId, triggerId, triggerRevision, trigger, current, previous);
    const binding = pullRequestBinding(automationId, triggerId, triggerRevision, trigger.kind);
    if ('triggerDefinitionEnvelope' in trigger) {
      openPullRequest(binding, trigger.triggerDefinitionEnvelope, current);
      return trigger;
    }
    if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) return trigger;
    return { kind: trigger.kind, enabled: trigger.enabled,
      ...(trigger.deadline === undefined ? {} : { deadline: trigger.deadline }),
      triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
          randomBytes: params.randomBytes, binding, definition: { kind: trigger.kind, pullRequest: trigger.pullRequest } })) };
  };
  const isPrivateTrigger = automationTriggerHasPrivateDefinitionV1;
  const privateTriggerMatches = async (row: AutomationDefinitionDetail, retained: AutomationDefinitionDetail['triggers'][number],
    requested: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1): Promise<boolean> => {
    if (retained.kind !== requested.kind || retained.enabled !== requested.enabled || 'triggerDefinitionEnvelope' in requested) return false;
    if (requested.kind === 'sessionLifecycle' && retained.kind === 'sessionLifecycle') {
      const { enabled: _enabled, ...definition } = requested;
      return pluginJsonValuesEqual(storedSessionLifecycle(row, retained.id, current).definition, definition);
    }
    if (requested.kind === 'action' && !('consentFor' in requested) && retained.kind === 'action' && !('consentFor' in retained)) {
      const { enabled: _enabled, ...definition } = requested;
      const stored = await storedAction(row, retained.id, current);
      // An explicit author save upgrades an older Account-sealed filter even
      // when its definition is unchanged. The actor cannot open that codec.
      const needsWorkflowReseal = stored.envelopeKind !== 'workflow'
        && parseWorkflowDefinitionRefV1(row.workflowDefinitionId)?.kind === 'artifact';
      return !needsWorkflowReseal && pluginJsonValuesEqual(stored.definition, definition);
    }
    if (requested.kind === 'prComment' || requested.kind === 'ciFailed') {
      if (retained.kind !== 'prComment' && retained.kind !== 'ciFailed') return false;
      return retained.watch?.deadline.scheduledAt === requested.deadline?.scheduledAt
        && pluginJsonValuesEqual(storedPullRequest(row, retained.id, current).definition,
        { kind: requested.kind, pullRequest: requested.pullRequest });
    }
    if (requested.kind !== 'pluginEvent' || retained.kind !== 'pluginEvent'
      || !pluginJsonValuesEqual(retained.eventRef, requested.eventRef)
      || retained.sourceContractVersion !== requested.sourceContractVersion
      || retained.observation.kind !== requested.observationTransport.kind) return false;
    const transport = requested.observationTransport;
    if (transport.kind === 'durablePush') {
      if (retained.observation.kind !== 'durablePush' || retained.observation.webhookEndpointId !== transport.webhookEndpointId) return false;
    } else {
      const watcher = retainedWatcher(retained);
      if (!watcher || !arePluginMachineMaterializationRefsEqual(watcher, transport.watcherMaterializationRef)) return false;
    }
    return pluginJsonValuesEqual(readAccountStoredPluginEventTriggerV1(row, retained.id, current).definition,
      createAutomationPluginEventTriggerDefinitionV1(requested));
  };
  const requesterScopes = (row: Readonly<{
    id: string;
    enabled: boolean;
    assignments?: readonly Readonly<{ machineId: string; enabled?: boolean }>[];
    triggers: readonly Readonly<{ id: string; enabled: boolean }>[];
  }>) => row.enabled ? (row.assignments ?? []).filter(item => item.enabled !== false).flatMap(assignment =>
    row.triggers.filter(trigger => trigger.enabled).map(trigger => ({
      scopeId: trigger.id, machineId: assignment.machineId, automationId: row.id,
    }))) : [];
  const requesterScopeKey = ({ scopeId, machineId }: ReturnType<typeof requesterScopes>[number]) =>
    JSON.stringify([scopeId, machineId]);
  const retireRequesterScopes = async (previous: ReturnType<typeof requesterScopes>, next: ReturnType<typeof requesterScopes>,
    signal?: AbortSignal, rollback?: ReadonlyMap<string, () => Promise<void>>) => {
    const active = new Set(next.map(requesterScopeKey));
    for (const scope of previous) {
      const key = requesterScopeKey(scope);
      if (active.has(key)) continue;
      const undo = rollback?.get(key);
      if (undo) await undo().catch(() => {});
      else await params.workflowRequesterCustody?.retire(scope, { signal });
    }
  };
  const commitRequesterScopes = async (
    previous: ReturnType<typeof requesterScopes>, next: ReturnType<typeof requesterScopes>,
    write: () => Promise<AutomationDefinitionDetail>, beforeWrite?: () => Promise<void>, signal?: AbortSignal,
  ) => {
    const rollback = new Map<string, () => Promise<void>>();
    try {
      for (const scope of next) {
        const undo = await params.workflowRequesterCustody?.retain(scope, { signal });
        if (undo) rollback.set(requesterScopeKey(scope), undo);
      }
      await beforeWrite?.();
    } catch (error) { await retireRequesterScopes(next, previous, signal, rollback); throw error; }
    let committed: AutomationDefinitionDetail;
    try { committed = await write(); }
    catch (error) {
      if (isConfirmedActionWriteRefusal(error)) await retireRequesterScopes(next, previous, signal, rollback);
      throw error;
    }
    await retireRequesterScopes(previous, requesterScopes(committed), signal);
    return committed;
  };
  return createWorkflowTriggerActions({
    automations: {
      ...(params.automations.readTriggerEventDeclarations ? { readTriggerEventDeclarations: params.automations.readTriggerEventDeclarations } : {}),
      list: async (input) => {
        const page = await params.automations.list(input);
        return { ...page, automations: await Promise.all(page.automations.map(materializePrivateListItem)) };
      },
      listDetails: async (input) => {
        const page = await params.automations.listDetails(input);
        return { ...page, automations: await Promise.all(page.automations.map(materializePrivateDetail)) };
      },
      get: async (automationId) => {
        const row = await params.automations.get(automationId);
        return row ? materializePrivateDetail(row) : null;
      },
      create: async (input, beforeWrite, signal) => {
        const current = input.triggers.some((item) => isPrivateTrigger(item.trigger)) ? await params.resolveEncryption() : null;
        const observationDisplay = input.observationOnly
          ? { name: input.name, description: input.description ?? null }
          : null;
        const triggers = input.triggers.map(item => {
          const trigger = bindSavedHealthTransitionHome(item.trigger);
          return { ...item, trigger: current && observationDisplay
            ? prepareObservationTrigger(input.automationId, item.triggerId, 0, trigger, observationDisplay, current)
            : trigger };
        });
        const environment = input.observationOnly?.deploymentEnvironment;
        const requested = triggers.length === 1 ? triggers[0]!.trigger : undefined;
        const savedHealthCheck = input.observationOnly !== undefined && requested?.kind === 'pluginEvent'
          && !('triggerDefinitionEnvelope' in requested) && isHealthCheckEventSourceV1(requested)
          && HealthCheckSourceConfigV1Schema.safeParse(requested.sourceConfig).success;
        const reuse = current && environment && requested?.kind === 'pluginEvent' && !('triggerDefinitionEnvelope' in requested)
          ? (row: AutomationDefinitionDetail) => {
            const trigger = row.triggers[0];
            if (!pluginJsonValuesEqual(row.observationOnly?.deploymentEnvironment, environment)
              || row.triggers.length !== 1 || trigger?.kind !== 'pluginEvent'
              || !pluginJsonValuesEqual(trigger.eventRef, requested.eventRef)
              || trigger.sourceContractVersion !== requested.sourceContractVersion
              || trigger.observation.kind !== requested.observationTransport.kind) return false;
            const definition = readAccountStoredPluginEventTriggerV1(row, trigger.id, current).definition;
            return definition.sourceInstanceId === requested.sourceInstanceId
              && (!savedHealthCheck || pluginJsonValuesEqual(definition.sourceConfig, requested.sourceConfig));
          } : undefined;
        const retained = current ? await assertSourceConfigurations(input.automationId,
          triggers.flatMap(item => {
            const source = requestedEvent(input.automationId, item.triggerId, 0, item.trigger, current);
            return source ? [source] : [];
          }), current, reuse) : [];
        if (reuse) {
          const existing = retained.find(reuse);
          if (existing?.enabled) return existing;
          if (existing) {
            const nextScopes = requesterScopes({ ...existing, enabled: true });
            return commitRequesterScopes(requesterScopes(existing), nextScopes, async () => materializePrivateDetail(
              await params.automations.reconcile(existing.id, await sealReconcilePrivateDisplay({
              expectedTemplateVersion: existing.templateVersion, name: existing.name, description: existing.description,
              enabled: true, assignments: [], removedTriggers: [], triggers: existing.triggers.map(trigger => ({
                kind: 'existing' as const, triggerId: trigger.id, expectedRevision: trigger.revision,
              })),
              }, existing), existing)), beforeWrite, signal);
          }
        }
        const nextScopes = requesterScopes({ ...input, id: input.automationId,
          triggers: input.triggers.map(item => ({ id: item.triggerId, enabled: item.trigger.enabled })) });
        const privateTriggers = await Promise.all(triggers.map(async item => current ? { ...item,
          trigger: await preparePrivateTrigger(input.automationId, item.triggerId, 0, item.trigger, current, undefined,
            input.workflowDefinitionId) } : item));
        return commitRequesterScopes([], nextScopes, async () => {
          const sealed = await sealCreatePrivateDisplay({ ...input, triggers: privateTriggers });
          let committed: AutomationDefinitionDetail;
          try {
            committed = await params.automations.create(sealed, beforeWrite, signal);
          } catch (error) {
            if (!savedHealthCheck || readActionErrorCodeV1(error) !== 'workflow_outcome_unresolved') throw error;
            // The generated ID belongs to this Save alone. Keep an unresolved outcome
            // if the Home also cannot confirm deletion, including a too-early 404.
            try {
              await params.automations.delete(input.automationId);
            } catch {
              throw error;
            }
            throw Object.assign(new Error('storage_unavailable', { cause: error }), { code: 'storage_unavailable' });
          }
          return materializePrivateDetail(committed);
        }, beforeWrite, signal);
      },
      reconcile: async (automationId, request, row, beforeWrite, signal) => {
        if (!row || row.id !== automationId || row.templateVersion !== request.expectedTemplateVersion) unavailable('currentness_conflict');
        const input: AutomationDefinitionReconcileRequest = { ...request, triggers: request.triggers.map(item => {
          if (item.kind === 'new') return { ...item, trigger: bindSavedHealthTransitionHome(item.trigger) };
          return item.trigger === undefined ? item : { ...item, trigger: bindSavedHealthTransitionHome(item.trigger) };
        }) };
        const needsPrivateWrite = input.triggers.some((item) => item.kind === 'new'
          ? isPrivateTrigger(item.trigger)
          : (item.trigger !== undefined && isPrivateTrigger(item.trigger)) || (item.enabled !== undefined && row.triggers.some((trigger) => trigger.id === item.triggerId && isPrivateTrigger(trigger))));
        const hasRetainedEvent = input.triggers.some(item => item.kind === 'existing'
          && row.triggers.some(trigger => trigger.id === item.triggerId && trigger.kind === 'pluginEvent'));
        const current = needsPrivateWrite || hasRetainedEvent ? await params.resolveEncryption() : null;
        // Pausing a saved observation withdraws it from the source census. A
        // retained conflict must not prevent retiring either exact definition.
        const withdrawingObservation = row.observationOnly !== undefined
          && (!input.enabled || input.triggers.some(item => item.kind === 'existing' && item.enabled === false))
          && input.triggers.every(item => item.kind === 'existing' && item.enabled !== true
            && item.trigger === undefined && item.triggerDefinitionEnvelope === undefined);
        if (current && !withdrawingObservation) await assertSourceConfigurations(automationId,
          input.triggers.flatMap(item => {
            if (item.kind === 'new' || item.trigger !== undefined) {
              const trigger = item.kind === 'new' ? item.trigger : { ...item.trigger!, enabled: item.enabled ?? false };
              const source = requestedEvent(automationId, item.triggerId,
                item.kind === 'new' ? 0 : item.expectedRevision + 1, trigger, current);
              return source ? [source] : [];
            }
            const retained = row.triggers.find(trigger => trigger.id === item.triggerId);
            if (!retained || retained.revision !== item.expectedRevision) unavailable('currentness_conflict');
            if (retained.kind !== 'pluginEvent') return [];
            const { definition } = readAccountStoredPluginEventTriggerV1(row, retained.id, current);
            return [{ eventRef: retained.eventRef, sourceInstanceId: definition.sourceInstanceId, sourceConfig: definition.sourceConfig,
              watcher: retainedWatcher(retained) }];
          }), current);
        const observationDisplay = row.observationOnly
          ? { name: input.name, description: input.description }
          : null;
        const observationDisplayRead = observationDisplay !== null && current !== null
          ? readAutomationDefinitionDisplayV1({ definition: row, encryption: current })
          : null;
        if (observationDisplayRead !== null && observationDisplayRead.kind !== 'available') unavailable();
        const mustStoreObservationDisplay = observationDisplay !== null && observationDisplayRead !== null
          && (observationDisplayRead.source === 'legacy'
            || observationDisplayRead.display.name !== observationDisplay.name
            || observationDisplayRead.display.description !== observationDisplay.description);
        let observationDisplayStored = false;
        const triggers = await Promise.all(input.triggers.map(async (item) => {
          if (item.kind === 'new') {
            if (!current) return item;
            const trigger = observationDisplay
              ? prepareObservationTrigger(automationId, item.triggerId, 0, item.trigger, observationDisplay, current)
              : item.trigger;
            if (observationDisplay) observationDisplayStored = true;
            return { ...item, trigger: await preparePrivateTrigger(automationId, item.triggerId, 0, trigger, current, undefined, row.workflowDefinitionId) };
          }
          const retained = row.triggers.find((trigger) => trigger.id === item.triggerId);
          if (!retained || retained.revision !== item.expectedRevision) unavailable('currentness_conflict');
          if (!current) return item;
          if (mustStoreObservationDisplay && observationDisplay !== null && retained.kind === 'pluginEvent'
            && item.trigger === undefined) {
            observationDisplayStored = true;
            return resealRetainedObservationDisplay(row, retained,
              item.enabled ?? retained.enabled, observationDisplay, current);
          }
          const requested = item.trigger === undefined ? undefined
            : observationDisplay
              ? prepareObservationTrigger(automationId, item.triggerId, item.expectedRevision + 1,
                { ...item.trigger, enabled: item.enabled ?? retained.enabled }, observationDisplay, current)
              : { ...item.trigger, enabled: item.enabled ?? retained.enabled };
          if (requested !== undefined && observationDisplay) observationDisplayStored = true;
          if ((item.trigger === undefined && (item.enabled === undefined || item.enabled === retained.enabled)
            && item.triggerDefinitionEnvelope === undefined)
            || (requested !== undefined && await privateTriggerMatches(row, retained, requested, current))) {
            return { kind: 'existing' as const, triggerId: item.triggerId, expectedRevision: item.expectedRevision };
          }
          if (requested !== undefined) {
            const previous = retained.kind === 'pluginEvent' ? readAccountStoredPluginEventTriggerV1(row, item.triggerId, current) : undefined;
            const { enabled: _enabled, ...trigger } = await preparePrivateTrigger(automationId, item.triggerId, item.expectedRevision + 1,
              requested, current, previous, row.workflowDefinitionId);
            return { ...item, trigger: AutomationTriggerDefinitionSchema.parse(trigger) };
          }
          if (item.enabled === undefined || !isPrivateTrigger(retained)) return item;
          // The Event envelope authenticates its trigger revision. A plain
          // observation-only status change therefore re-seals its incumbent
          // display carrier instead of leaving it bound to the old revision.
          if (retained.kind === 'pluginEvent' && observationDisplay !== null
            && !isAvailableE2eeAutomationAccountEncryptionV1(current)) {
            observationDisplayStored = true;
            return resealRetainedObservationDisplay(row, retained, item.enabled, observationDisplay, current);
          }
          if (retained.kind === 'sessionLifecycle') {
            const previous = storedSessionLifecycle(row, item.triggerId, current);
            return { ...item, triggerDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
              ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
                ? { mode: 'e2ee' as const, material: current.material.material, randomBytes: params.randomBytes }
                : { mode: 'plain' as const }),
              binding: { ...previous.binding, triggerRevision: item.expectedRevision + 1 }, definition: previous.definition,
            }) };
          }
          if (retained.kind === 'action' && !('consentFor' in retained)
            && parseWorkflowDefinitionRefV1(row.workflowDefinitionId)?.kind === 'artifact' && row.workflowDefinitionId) {
            const previous = await storedAction(row, retained.id, current);
            return { ...item, triggerDefinitionEnvelope: await sealWorkflowAction(row.workflowDefinitionId,
              { ...previous.binding, triggerRevision: item.expectedRevision + 1 }, previous.definition) };
          }
          if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) return item;
          const previous = retained.kind === 'pluginEvent' ? readAccountStoredPluginEventTriggerV1(row, item.triggerId, current)
            : retained.kind === 'action' ? readAccountStoredActionTriggerV1(row, item.triggerId, current) : storedPullRequest(row, item.triggerId, current);
          return { ...item, triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
              randomBytes: params.randomBytes, binding: { ...previous.binding, triggerRevision: item.expectedRevision + 1 },
              definition: previous.definition })) };
        }));
        const nextScopes = requesterScopes({ ...input, id: automationId,
          triggers: input.triggers.map(item => ({ id: item.triggerId,
            enabled: item.kind === 'new' ? item.trigger.enabled : item.enabled ?? row.triggers.find(trigger => trigger.id === item.triggerId)!.enabled })) });
        const reconciled: AutomationDefinitionReconcileRequest = { ...input, triggers };
        return commitRequesterScopes(requesterScopes(row), nextScopes, async () => materializePrivateDetail(
          await params.automations.reconcile(automationId,
            await sealReconcilePrivateDisplay(reconciled, row, observationDisplayStored), row),
        ), beforeWrite, signal);
      },
      delete: async (automationId, current, signal) => {
        if (!params.workflowRequesterCustody) return params.automations.delete(automationId);
        const previous = current ?? await params.automations.get(automationId);
        const result = await params.automations.delete(automationId);
        if (previous) await retireRequesterScopes(requesterScopes(previous), [], signal);
        return result;
      },
      ...(params.automations.runNow ? { runNow: params.automations.runNow } : {}),
    },
    newId: () => params.newId(),
    ...(params.nativeAccount ? { nativeAccount: params.nativeAccount } : {}),
    ...(params.listContributedActionDefinitions ? { listContributedActionDefinitions: params.listContributedActionDefinitions } : {}),
    ...(params.deploymentAction ? { deploymentAction: params.deploymentAction } : {}),
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    ...(params.sessionRead ? { sessionRead: params.sessionRead } : {}),
    ...(params.resolveAgentStartContext ? { resolveAgentStartContext: params.resolveAgentStartContext } : {}),
    ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    ...(params.resolveRunTrigger ? { resolveRunTrigger: params.resolveRunTrigger } : {}),
    ...(params.resolveRunSource ? { resolveRunSource: params.resolveRunSource } : {}),
    ...(params.resolveManagedMachine ? { resolveManagedMachine: params.resolveManagedMachine } : {}),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
    ...(params.pullRequests ? { pullRequests: params.pullRequests } : {}),
    openPullRequestTrigger: async (row, trigger) => storedPullRequest(row, trigger.id, await params.resolveEncryption()).definition,
    openPluginEventTrigger: async (row, trigger) => readAccountStoredPluginEventTriggerV1(row, trigger.id, await params.resolveEncryption()).definition,
    openSessionLifecycleTrigger: async (row, trigger) => storedSessionLifecycle(row, trigger.id, await params.resolveEncryption()).definition,
    prepareBirthTrigger: async (automationId, triggerId, trigger) => preparePrivateTrigger(automationId, triggerId, 0, trigger, await params.resolveEncryption()),
    openActionTrigger: async (row, trigger) => (await storedAction(row, trigger.id, await params.resolveEncryption())).definition,
    openOwnActionTrigger,
    openSharedActionTrigger: async (reference) => {
      if (!reference.sharedDefinitionEnvelope) unavailable();
      const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: reference.automationId,
        triggerId: reference.triggerId, triggerRevision: reference.triggerRevision, triggerKind: 'action' });
      return openWorkflowAction(reference.workflowId, binding, reference.sharedDefinitionEnvelope);
    },
    resolveWorkflow: params.resolveWorkflow,
    ...(params.readWorkflowChildBodyVersions ? { readWorkflowChildBodyVersions: params.readWorkflowChildBodyVersions } : {}),
    ...(params.resolveWorkflowTeamIds ? { resolveWorkflowTeamIds: params.resolveWorkflowTeamIds } : {}),
    openContext: async (row) => {
      if (row.executionRecipe?.v !== 2) unavailable('source_unavailable');
      const { display: _display, ...context } = await open(row.executionRecipe.workflow);
      if ((context.workspace === undefined) !== (row.executionRecipe.placement === 'action_invocation')) unavailable('source_unavailable');
      return context;
    },
    sealContext: input => sealWorkflowContext(params, input),
    requiresLegacyReview: async (row) => {
      const current = await params.resolveEncryption();
      const stored = row.templateCiphertext ? readAutomationTemplateStoredEnvelopeV1(row.templateCiphertext) : null;
      return current.witness.mode === 'plain' && Boolean(stored?.legacyExistingSessionId)
        && stored?.envelope.kind !== 'happier_automation_template_plain_v1';
    },
    convertLegacy: async (row, caller) => {
      const legacy = await readStoredLegacy(row);
      // Channel bindings address the Automation id. The canonical same-id recipe CAS
      // keeps that association and every trigger identity intact.
      const session = legacy.targetType === 'existing_session'
        ? await params.resolveSession?.(legacy.template.existingSessionId!, caller) : undefined;
      const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ legacyTemplate: legacy,
        machineId: legacy.machineId, ...(session ? { session } : {}) });
      if (converted.kind !== 'available') unavailable(converted.code, { reason: converted.reason });
      return legacyContext(converted.definition, converted.project);
    },
  });
}

type HealthCheckSourceReaderParams = Readonly<{
  automations: Pick<WorkflowTriggerAutomationOperations, 'listDetails'>;
  resolveEncryption: WorkflowTriggerAccountHostParams['resolveEncryption'];
}>;

function assertSameAccountEncryption(opened: AvailableAutomationAccountEncryptionV1, current: AvailableAutomationAccountEncryptionV1): void {
  if (current.witness.mode !== opened.witness.mode
    || current.witness.contentKeyFingerprint !== opened.witness.contentKeyFingerprint) unavailable();
}

async function assertAccountDisclosureCurrent(opened: AvailableAutomationAccountEncryptionV1,
  resolveEncryption: WorkflowTriggerAccountHostParams['resolveEncryption']) {
  const current = await resolveEncryption();
  assertSameAccountEncryption(opened, current);
}

/** Internal assembly consumers borrow the same decoded census before public selection. */
export function createAccountHealthCheckSourceSnapshotReaderV1(params: HealthCheckSourceReaderParams) {
  return async () => {
    const current = await params.resolveEncryption();
    const sources = await readSavedHealthCheckSourceSnapshotV1({
      automations: params.automations,
      openPluginEventTrigger: async (row, trigger) => readAccountStoredPluginEventTriggerV1(row, trigger.id, current).definition,
    });
    await assertAccountDisclosureCurrent(current, params.resolveEncryption);
    return sources;
  };
}

export function createAccountHealthCheckSourcesReaderV1(params: HealthCheckSourceReaderParams) {
  const read = createAccountHealthCheckSourceSnapshotReaderV1(params);
  return async (sourceInstanceIds: readonly string[]) => {
    if (sourceInstanceIds.length === 0) return new Map<string, import('../../workflows/triggers/workflowTriggerActionsV1.js').WorkflowTriggerHealthSourceV1>();
    const snapshot = await read();
    return new Map(sourceInstanceIds.flatMap(id => {
      const source = snapshot.get(id);
      return source ? [[id, source] as const] : [];
    }));
  };
}

/** Scalar host callers consume the same bulk reader. */
export function createAccountHealthCheckSourceReaderV1(params: HealthCheckSourceReaderParams) {
  const read = createAccountHealthCheckSourcesReaderV1(params);
  return async (sourceInstanceId: string) => (await read([sourceInstanceId])).get(sourceInstanceId) ?? null;
}

export function createAccountWorkflowTriggerActions(params: WorkflowTriggerAccountHostParams): WorkflowTriggerActions {
  const actions = createAccountWorkflowTriggerActionOwner(params);
  const readWithAccountWitness = async <Result>(read: (owner: WorkflowTriggerActions) => Promise<Result>) => {
    // Borrow the connection witness for opening; a fresh read still fences disclosure.
    let encryption: Promise<AvailableAutomationAccountEncryptionV1> | undefined;
    const workflowContents = new Map<string, ReturnType<NonNullable<WorkflowTriggerAccountHostParams['resolveWorkflowContent']>>>();
    const resolveWorkflowContent = params.resolveWorkflowContent;
    const owner = createAccountWorkflowTriggerActionOwner({ ...params,
      resolveEncryption: () => (encryption ??= (params.resolveReadEncryption ?? params.resolveEncryption)()),
      ...(resolveWorkflowContent ? { resolveWorkflowContent: (workflowId: string) => {
        let content = workflowContents.get(workflowId);
        if (!content) { content = resolveWorkflowContent(workflowId); workflowContents.set(workflowId, content); }
        return content;
      } } : {}),
    });
    const result = await read(owner);
    if (encryption) {
      const opened = await encryption;
      // Mode and content-key identity govern disclosure, not a catalog revision.
      await assertAccountDisclosureCurrent(opened, params.resolveEncryption);
    }
    return result;
  };
  return { ...actions,
    prepareActionMatching: accountId => async (selection, context) => {
      try { return await readWithAccountWitness(owner => owner.prepareActionMatching(accountId)(selection, context)); }
      catch (error) { return unavailableActionAutomationMatchingV1(readActionErrorCodeV1(error) ?? 'action_failed'); }
    },
    list: (raw, caller) => readWithAccountWitness(owner => owner.list(raw, caller)),
    listSubjects: raw => readWithAccountWitness(owner => owner.listSubjects(raw)),
  };
}
