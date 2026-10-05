import type { AutomationDefinitionDetail } from '../../automations/automationApiV3.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from '../../automations/automationAccountCurrentnessV1.js';
import { AutomationSourceSelectorIdV1Schema } from '../../automations/automationEventJsonBoundsV1.js';
import { AutomationEventTriggerDefinitionStoredPayloadV1Schema } from '../../automations/automationEventV1.js';
import {
  projectLegacyAutomationTemplateToWorkflowDefinitionV1,
  convertLegacyAutomationRecipeToInlineWorkflowV1,
} from '../../automations/automationLegacyWorkflowV1.js';
import { openAutomationTemplateStoredV1, readAutomationTemplateStoredEnvelopeV1,
  type AutomationTemplateRetainedSessionV1 } from '../../automations/automationTemplateStoredV1.js';
import { AutomationStoredContentEnvelopeV1Schema } from '../../automations/automationStoredContentEnvelopeV1.js';
import {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationTriggerDefinitionSchema,
  AutomationPullRequestTriggerSchema,
  type AutomationTriggerDefinitionInput,
} from '../../automations/automationTriggerDefinition.js';
import {
  AutomationTriggerDefinitionBindingV1Schema,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  sealAutomationPluginEventTriggerInputV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationTriggerDefinitionBindingV1,
} from '../../automations/automationTriggerDefinitionStoredContent.js';
import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationStoredWorkflowDefinitionV2Schema,
} from '../../automations/automationWorkflowRecipeV2.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import {
  createWorkflowTriggerActions,
  type WorkflowTriggerActionsDependencies,
  type WorkflowTriggerAutomationOperations,
} from './workflowTriggerActions.js';

function unavailable(code = 'content_unavailable', details?: unknown): never {
  throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}

export type WorkflowTriggerAccountHostParams = Readonly<{
  /** The host's Account Automation HTTP transport; the host adds no trigger semantics. */
  automations: WorkflowTriggerAutomationOperations;
  /** Current validated Account encryption; throws typed when unavailable or stale. */
  resolveEncryption: () => Promise<AvailableAutomationAccountEncryptionV1>;
  /** Authenticated Session-mode/key custody, separate from ordinary plain Account material. */
  resolveRetainedSession?: (sessionId: string) => Promise<AutomationTemplateRetainedSessionV1 | null>;
  randomBytes: (length: number) => Uint8Array;
  newId: () => string;
  /** Channels-owned Account-scoped observation; eligibility/listing is not association evidence. */
  observeLegacyChannelAssociation?: (input: Readonly<{ automationId: string; expectedTemplateVersion: number }>, caller?: Parameters<NonNullable<WorkflowTriggerActionsDependencies['resolveSession']>>[1]) => Promise<
    Readonly<{ kind: 'absent' | 'bound' | 'unknown' }>>;
}> & Pick<WorkflowTriggerActionsDependencies, 'resolveWorkflow' | 'resolveWorkflowTeamIds' | 'resolveSession' | 'resolveRunTrigger' | 'resolveRunSource' | 'resolveMaterializer' | 'pullRequests'>;

/**
 * Every Account host (CLI/daemon and the UI front door) composes the one trigger owner through
 * this adapter: Automation recipe/context and private trigger envelopes are opened and sealed with
 * the caller Account's current material. Hosts supply only transport, crypto material and ids.
 */
export function createAccountWorkflowTriggerActions(params: WorkflowTriggerAccountHostParams) {
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
    if ((row.targetType === 'existingSession') !== Boolean(opened.template.existingSessionId?.trim())) unavailable('invalid_template');
    const targetType = row.targetType === 'newSession' ? 'new_session' as const : 'existing_session' as const;
    return { template: opened.template, targetType, machineId: row.assignments.length === 1 ? row.assignments[0]!.machineId : null };
  };
  const legacyContext = (definition: ReturnType<typeof projectLegacyAutomationTemplateToWorkflowDefinitionV1>,
    project: { directory: string; workspaceRefId?: string; machineId?: string }) => {
    const { machineId: _machineId, ...workspace } = project;
    const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace,
      executionTarget: { kind: 'session' }, inlineDefinition: definition });
    return { target: { kind: 'inline' as const, definition }, context };
  };
  const open = async (raw: unknown) => {
    const envelope = AutomationStoredContentEnvelopeV1Schema.parse(raw);
    const current = await params.resolveEncryption();
    if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) {
      if (envelope.t !== 'plain') unavailable();
      return envelope.v;
    }
    if (envelope.t !== 'encrypted') unavailable();
    const opened = openAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
      material: current.material.material, ciphertext: envelope.c });
    if (!opened) unavailable();
    return opened.value;
  };
  const eventBinding = (automationId: string, triggerId: string, triggerRevision: number,
    eventRef: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>['eventRef'], sourceSelectorId: string) => (
    AutomationTriggerDefinitionBindingV1Schema.options[0].parse({ v: 1, automationId, triggerId, triggerRevision,
      triggerKind: 'pluginEvent', eventRef, sourceSelectorId })
  );
  const pullRequestBinding = (automationId: string, triggerId: string, triggerRevision: number,
    triggerKind: 'prComment' | 'ciFailed') => AutomationTriggerDefinitionBindingV1Schema.parse({
      v: 1, automationId, triggerId, triggerRevision, triggerKind,
    });
  const openEvent = (binding: AutomationTriggerDefinitionBindingV1, envelope: unknown, current: AvailableAutomationAccountEncryptionV1) => {
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    return AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse(opened.definition);
  };
  const storedEvent = (row: AutomationDefinitionDetail, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find((item) => item.id === triggerId);
    if (!trigger || trigger.kind !== 'pluginEvent') unavailable();
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const binding = eventBinding(row.id, trigger.id, trigger.revision, trigger.eventRef, trigger.sourceSelectorId);
    return { trigger, binding, definition: openEvent(binding, envelope, current) };
  };
  const openPullRequest = (binding: AutomationTriggerDefinitionBindingV1, envelope: unknown,
    current: AvailableAutomationAccountEncryptionV1) => {
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    const parsed = AutomationPullRequestTriggerSchema.safeParse(opened.definition);
    if (!parsed.success || parsed.data.kind !== binding.triggerKind) unavailable();
    return parsed.data;
  };
  const storedPullRequest = (row: AutomationDefinitionDetail, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find((item) => item.id === triggerId);
    if (!trigger || (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed')) unavailable();
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const binding = pullRequestBinding(row.id, trigger.id, trigger.revision, trigger.kind);
    return { trigger, binding, definition: openPullRequest(binding, envelope, current) };
  };
  const prepareEvent = (automationId: string, triggerId: string, triggerRevision: number,
    trigger: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1,
    previous?: ReturnType<typeof storedEvent>): AutomationTriggerDefinitionInput => {
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
  const preparePrivateTrigger = (automationId: string, triggerId: string, triggerRevision: number,
    trigger: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1,
    previous?: ReturnType<typeof storedEvent>): AutomationTriggerDefinitionInput => {
    if (trigger.kind !== 'prComment' && trigger.kind !== 'ciFailed') return prepareEvent(automationId, triggerId, triggerRevision, trigger, current, previous);
    const binding = pullRequestBinding(automationId, triggerId, triggerRevision, trigger.kind);
    if ('triggerDefinitionEnvelope' in trigger) {
      openPullRequest(binding, trigger.triggerDefinitionEnvelope, current);
      return trigger;
    }
    if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) return trigger;
    return { kind: trigger.kind, enabled: trigger.enabled,
      triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
          randomBytes: params.randomBytes, binding, definition: { kind: trigger.kind, pullRequest: trigger.pullRequest } })) };
  };
  const isPrivateTrigger = (trigger: { kind: string }) => trigger.kind === 'pluginEvent' || trigger.kind === 'prComment' || trigger.kind === 'ciFailed';
  return createWorkflowTriggerActions({
    automations: {
      list: (input) => params.automations.list(input),
      get: (automationId) => params.automations.get(automationId),
      create: async (input) => {
        const current = input.triggers.some((item) => isPrivateTrigger(item.trigger)) ? await params.resolveEncryption() : null;
        const triggers = input.triggers.map((item) => current ? { ...item,
          trigger: preparePrivateTrigger(input.automationId, item.triggerId, 0, item.trigger, current) } : item);
        return params.automations.create({ ...input, triggers });
      },
      reconcile: async (automationId, input, row) => {
        if (!row || row.id !== automationId || row.templateVersion !== input.expectedTemplateVersion) unavailable('currentness_conflict');
        const needsPrivateWrite = input.triggers.some((item) => item.kind === 'new'
          ? isPrivateTrigger(item.trigger)
          : (item.trigger !== undefined && isPrivateTrigger(item.trigger)) || (item.enabled !== undefined && row.triggers.some((trigger) => trigger.id === item.triggerId && isPrivateTrigger(trigger))));
        const current = needsPrivateWrite ? await params.resolveEncryption() : null;
        const triggers = input.triggers.map((item) => {
          if (item.kind === 'new') return current ? { ...item,
            trigger: preparePrivateTrigger(automationId, item.triggerId, 0, item.trigger, current) } : item;
          const retained = row.triggers.find((trigger) => trigger.id === item.triggerId);
          if (!retained || retained.revision !== item.expectedRevision) unavailable('currentness_conflict');
          if (!current) return item;
          if (item.trigger !== undefined) {
            const previous = retained.kind === 'pluginEvent' ? storedEvent(row, item.triggerId, current) : undefined;
            const { enabled: _enabled, ...trigger } = preparePrivateTrigger(automationId, item.triggerId, item.expectedRevision + 1,
              { ...item.trigger, enabled: item.enabled ?? retained.enabled }, current, previous);
            return { ...item, trigger: AutomationTriggerDefinitionSchema.parse(trigger) };
          }
          if (item.enabled === undefined || !isPrivateTrigger(retained) || !isAvailableE2eeAutomationAccountEncryptionV1(current)) return item;
          const previous = retained.kind === 'pluginEvent' ? storedEvent(row, item.triggerId, current) : storedPullRequest(row, item.triggerId, current);
          return { ...item, triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: current.material.material,
              randomBytes: params.randomBytes, binding: { ...previous.binding, triggerRevision: item.expectedRevision + 1 },
              definition: previous.definition })) };
        });
        return params.automations.reconcile(automationId, { ...input, triggers }, row);
      },
      delete: (automationId) => params.automations.delete(automationId),
    },
    newId: () => params.newId(),
    ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    ...(params.resolveRunTrigger ? { resolveRunTrigger: params.resolveRunTrigger } : {}),
    ...(params.resolveRunSource ? { resolveRunSource: params.resolveRunSource } : {}),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
    ...(params.pullRequests ? { pullRequests: params.pullRequests } : {}),
    openPullRequestTrigger: async (row, trigger) => storedPullRequest(row, trigger.id, await params.resolveEncryption()).definition,
    resolveWorkflow: params.resolveWorkflow,
    ...(params.resolveWorkflowTeamIds ? { resolveWorkflowTeamIds: params.resolveWorkflowTeamIds } : {}),
    openContext: async (row) => {
      if (row.executionRecipe?.v !== 2) unavailable('source_unavailable');
      return open(row.executionRecipe.workflow);
    },
    sealContext: async ({ templateVersion, context }) => {
      const payload = AutomationStoredWorkflowDefinitionV2Schema.parse(context);
      const current = await params.resolveEncryption();
      const workflow = isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
          material: current.material.material, payload, randomBytes: params.randomBytes }) }
        : { t: 'plain' as const, v: payload };
      return AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion, workflow, triggerEvidence: null });
    },
    readLegacyContext: async (row) => {
      if (row.templateCiphertext !== undefined) {
        const legacy = await readStoredLegacy(row);
        // Existing Session identity comes from its owner, never an arbitrary multi-placement assignment.
        const machineId = legacy.targetType === 'existing_session' && legacy.machineId === null
          ? (await params.resolveSession?.(legacy.template.existingSessionId!))?.project.machineId ?? null : legacy.machineId;
        if (legacy.targetType === 'existing_session' && machineId === null) unavailable('source_unavailable');
        return { ...legacyContext(projectLegacyAutomationTemplateToWorkflowDefinitionV1({ ...legacy, machineId }),
          { directory: legacy.template.directory }),
          placements: row.assignments.filter((assignment) => assignment.enabled)
            .map(({ machineId }) => ({ machineId, directory: legacy.template.directory })) };
      }
      unavailable('source_unavailable');
    },
    convertLegacy: async (row, caller) => {
      const current = await params.resolveEncryption();
      const stored = row.templateCiphertext ? readAutomationTemplateStoredEnvelopeV1(row.templateCiphertext) : null;
      if (current.witness.mode === 'plain' && stored?.legacyExistingSessionId
        && stored.envelope.kind !== 'happier_automation_template_plain_v1') {
        unavailable('legacy_conversion_unsupported', { reason: 'spawn_unrepresentable' });
      }
      const association = await params.observeLegacyChannelAssociation?.({ automationId: row.id, expectedTemplateVersion: row.templateVersion }, caller);
      if (!association || association.kind === 'unknown') unavailable('legacy_conversion_unsupported', { reason: 'channel_association_unknown' });
      const legacy = await readStoredLegacy(row);
      if (association.kind === 'bound') unavailable('legacy_conversion_unsupported', { reason: 'channel_reply_handoff' });
      const session = legacy.targetType === 'existing_session'
        ? await params.resolveSession?.(legacy.template.existingSessionId!, caller) : undefined;
      const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ legacyTemplate: legacy,
        machineId: legacy.machineId, ...(session ? { session } : {}) });
      if (converted.kind !== 'available') unavailable(converted.code, { reason: converted.reason });
      return legacyContext(converted.definition, converted.project);
    },
  });
}
