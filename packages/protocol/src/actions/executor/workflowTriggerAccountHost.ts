import * as z from 'zod/mini';
import type { AutomationDefinitionDetail, AutomationDefinitionPatchRequest } from '../../automations/automationApiV3.js';
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
  createAutomationPluginEventTriggerDefinitionV1,
  sealAutomationPluginEventTriggerInputV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationTriggerDefinitionBindingV1,
} from '../../automations/automationTriggerDefinitionStoredContent.js';
import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationStoredWorkflowDefinitionV2ReadSchema,
  type AutomationStoredWorkflowDefinitionV2,
} from '../../automations/automationWorkflowRecipeV2.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import { readTriggerTargetV1 } from '../../workflows/triggers/triggerTargetV1.js';
import {
  createWorkflowTriggerActions,
  readManagedMachineTriggerAction,
  type WorkflowTriggerActionsDependencies,
  type WorkflowTriggerAutomationOperations,
  type WorkflowTriggerActions,
} from './workflowTriggerActions.js';
import { normalizeStoredWorkflowTriggerConsent } from './workflowTriggerConsent.js';
import type { WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { isConfirmedActionWriteRefusal } from './actionFailureEnvelope.js';

function unavailable(code = 'content_unavailable', details?: unknown): never {
  throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}

export type WorkflowTriggerAccountHostParams = Readonly<{
  workflowRequesterCustody?: WorkflowAccountRunActionDeps['workflowRequesterCustody'];
  /** The host's Account Automation HTTP transport; the host adds no trigger semantics. */
  automations: WorkflowTriggerAutomationOperations;
  /** Current validated Account encryption; throws typed when unavailable or stale. */
  resolveEncryption: () => Promise<AvailableAutomationAccountEncryptionV1>;
  /** Authenticated Session-mode/key custody, separate from ordinary plain Account material. */
  resolveRetainedSession?: (sessionId: string) => Promise<AutomationTemplateRetainedSessionV1 | null>;
  randomBytes: (length: number) => Uint8Array;
  newId: () => string;
}> & Pick<WorkflowTriggerActionsDependencies, 'nativeAccount' | 'deploymentAction' | 'sessionList' | 'sessionRead' | 'resolveWorkflow' | 'resolveWorkflowTeamIds' | 'resolveSession' | 'resolveRunTrigger' | 'resolveRunSource' | 'resolveManagedMachine' | 'resolveMaterializer' | 'pullRequests'>;

type WorkflowCodecParams = Pick<WorkflowTriggerAccountHostParams, 'resolveEncryption' | 'randomBytes'>;

function openWorkflowEnvelope(raw: unknown, current: AvailableAutomationAccountEncryptionV1) {
  const envelope = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema).parse(raw);
  if (!isAvailableE2eeAutomationAccountEncryptionV1(current)) {
    if (envelope.t !== 'plain') unavailable();
    return envelope.v;
  }
  if (envelope.t !== 'encrypted') unavailable();
  const opened = openAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
    material: current.material.material, ciphertext: envelope.c });
  if (!opened) unavailable();
  return opened.value;
}

/** Every authoring host and the one-shot migration use this same seal and relationship derivation. */
async function sealWorkflowContext(params: WorkflowCodecParams, input: Readonly<{
  templateVersion: number; context: AutomationStoredWorkflowDefinitionV2;
}>) {
  const payload = AutomationStoredWorkflowDefinitionV2Schema.parse(input.context);
  const current = await params.resolveEncryption();
  const workflow = isAvailableE2eeAutomationAccountEncryptionV1(current)
    ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
      material: current.material.material, payload, randomBytes: params.randomBytes }) }
    : { t: 'plain' as const, v: payload };
  const managed = payload.inlineDefinition && readManagedMachineTriggerAction({ kind: 'inline', definition: payload.inlineDefinition });
  return AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: input.templateVersion,
    workflow, triggerEvidence: null, visibleTeamId: payload.visibleTeamId ?? null,
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
        let context = AutomationStoredWorkflowDefinitionV2ReadSchema.parse(openWorkflowEnvelope(row.executionRecipe.workflow, openedEncryption));
        if (context.deploymentTriggers?.some(trigger => trigger.approval)) {
          if (row.assignments.length !== 1) unavailable('source_unavailable');
          context = (await normalizeStoredWorkflowTriggerConsent({ automationId: row.id, context,
            project: { machineId: row.assignments[0]!.machineId, ...context.workspace } })).context;
        }
        if (readTriggerTargetV1(row, context).kind !== 'available') unavailable('source_unavailable');
        const sameAuthority = (current: AvailableAutomationAccountEncryptionV1) => {
          assertCurrent();
          if (current.witness.mode !== openedEncryption.witness.mode
            || current.witness.contentKeyFingerprint !== openedEncryption.witness.contentKeyFingerprint) unavailable();
          return current;
        };
        const executionRecipe = await sealWorkflowContext({ ...params,
          resolveEncryption: async () => sameAuthority(await params.resolveEncryption()) }, {
          templateVersion: row.templateVersion + 1, context,
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

/**
 * Every Account host (CLI/daemon and the UI front door) composes the one trigger owner through
 * this adapter: Automation recipe/context and private trigger envelopes are opened and sealed with
 * the caller Account's current material. Hosts supply only transport, crypto material and ids.
 */
function createAccountWorkflowTriggerActionOwner(params: WorkflowTriggerAccountHostParams) {
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
  const eventBinding = (automationId: string, triggerId: string, triggerRevision: number,
    eventRef: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>['eventRef'], sourceSelectorId: string) => (
    AutomationTriggerDefinitionBindingV1Schema._zod.def.options[0].parse({ v: 1, automationId, triggerId, triggerRevision,
      triggerKind: 'pluginEvent', eventRef, sourceSelectorId })
  );
  const pullRequestBinding = (automationId: string, triggerId: string, triggerRevision: number,
    triggerKind: 'prComment' | 'ciFailed') => AutomationTriggerDefinitionBindingV1Schema.parse({
      v: 1, automationId, triggerId, triggerRevision, triggerKind,
    });
  const openEvent = (binding: AutomationTriggerDefinitionBindingV1, envelope: unknown, current: AvailableAutomationAccountEncryptionV1, storedRead = false) => {
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
        ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }) });
    if (opened.kind !== 'available') unavailable();
    return (storedRead ? createStoredReadSchema(AutomationEventTriggerDefinitionStoredPayloadV1Schema)
      : AutomationEventTriggerDefinitionStoredPayloadV1Schema).parse(opened.definition);
  };
  const storedEvent = (row: AutomationDefinitionDetail, triggerId: string, current: AvailableAutomationAccountEncryptionV1) => {
    const trigger = row.triggers.find((item) => item.id === triggerId);
    if (!trigger || trigger.kind !== 'pluginEvent') unavailable();
    let envelope: unknown;
    try { envelope = JSON.parse(trigger.triggerDefinitionEnvelope); } catch { unavailable(); }
    const binding = eventBinding(row.id, trigger.id, trigger.revision, trigger.eventRef, trigger.sourceSelectorId);
    return { trigger, binding, definition: openEvent(binding, envelope, current, true) };
  };
  type ConfiguredEvent = Pick<ReturnType<typeof storedEvent>['definition'], 'sourceInstanceId' | 'sourceConfig'> & Readonly<{
    eventRef: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>['eventRef'];
    watcher: PluginMachineMaterializationRefV1 | null;
  }>;
  const retainedWatcher = (trigger: ReturnType<typeof storedEvent>['trigger']) =>
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
  const assertSourceConfigurations = async (automationId: string, name: string, candidates: readonly ConfiguredEvent[],
    current: AvailableAutomationAccountEncryptionV1, reuse?: (row: AutomationDefinitionDetail) => boolean) => {
    if (!candidates.length) return [];
    const retained: Array<ConfiguredEvent & Readonly<{ automationId: string; name: string }>> = [];
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
        const row = await params.automations.get(summary.id);
        if (!row) continue;
        retainedDefinitions.push(row);
        for (const trigger of row.triggers) {
          if (trigger.kind !== 'pluginEvent' || !candidates.some(candidate => sameSourcePlugin(candidate.eventRef, trigger.eventRef))) continue;
          const { definition } = storedEvent(row, trigger.id, current);
          retained.push({ ...definition, eventRef: trigger.eventRef, watcher: retainedWatcher(trigger), automationId: row.id, name: row.name });
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // Automatic Environment enrollment replays retain its admitted baseline.
    // Explicit source edits still pass the shared configuration consistency owner.
    if (reuse && retainedDefinitions.some(reuse)) return retainedDefinitions;
    for (const candidate of candidates) {
      const conflict = retained.find(existing => sameSourcePlugin(existing.eventRef, candidate.eventRef)
        && existing.sourceInstanceId === candidate.sourceInstanceId
        && (!pluginJsonValuesEqual(existing.sourceConfig, candidate.sourceConfig)
          || (existing.watcher !== null && candidate.watcher !== null
            && !arePluginMachineMaterializationRefsEqual(existing.watcher, candidate.watcher))));
      if (conflict) throw Object.assign(new Error(
        `Source configuration conflicts with existing definition "${conflict.name}" (${conflict.automationId}).`,
      ), { code: 'invalid_input' });
      // Compare the complete prospective set as well, without comparing a
      // replacement against its own old revision or ignoring retained siblings.
      retained.push({ ...candidate, automationId, name });
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
  const privateTriggerMatches = (row: AutomationDefinitionDetail, retained: AutomationDefinitionDetail['triggers'][number],
    requested: AutomationTriggerDefinitionInput, current: AvailableAutomationAccountEncryptionV1): boolean => {
    if (retained.kind !== requested.kind || retained.enabled !== requested.enabled || 'triggerDefinitionEnvelope' in requested) return false;
    if (requested.kind === 'prComment' || requested.kind === 'ciFailed') {
      return pluginJsonValuesEqual(storedPullRequest(row, retained.id, current).definition,
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
    return pluginJsonValuesEqual(storedEvent(row, retained.id, current).definition,
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
  const retainRequesterScopes = async (scopes: ReturnType<typeof requesterScopes>) => {
    for (const scope of scopes) await params.workflowRequesterCustody?.retain(scope);
  };
  const retireRequesterScopes = async (previous: ReturnType<typeof requesterScopes>, next: ReturnType<typeof requesterScopes>, signal?: AbortSignal) => {
    const active = new Set(next.map(({ scopeId, machineId }) => JSON.stringify([scopeId, machineId])));
    for (const scope of previous) {
      if (!active.has(JSON.stringify([scope.scopeId, scope.machineId]))) {
        await params.workflowRequesterCustody?.retire(scope, { signal });
      }
    }
  };
  const commitRequesterScopes = async (
    previous: ReturnType<typeof requesterScopes>, next: ReturnType<typeof requesterScopes>,
    write: () => Promise<AutomationDefinitionDetail>, beforeWrite?: () => Promise<void>, signal?: AbortSignal,
  ) => {
    try { await retainRequesterScopes(next); await beforeWrite?.(); }
    catch (error) { await retireRequesterScopes(next, previous, signal); throw error; }
    let committed: AutomationDefinitionDetail;
    try { committed = await write(); }
    catch (error) {
      if (isConfirmedActionWriteRefusal(error)) await retireRequesterScopes(next, previous, signal);
      throw error;
    }
    await retireRequesterScopes(previous, requesterScopes(committed), signal);
    return committed;
  };
  return createWorkflowTriggerActions({
    automations: {
      list: (input) => params.automations.list(input),
      listDetails: (input) => params.automations.listDetails(input),
      get: (automationId) => params.automations.get(automationId),
      create: async (input, beforeWrite, signal) => {
        const current = input.triggers.some((item) => isPrivateTrigger(item.trigger)) ? await params.resolveEncryption() : null;
        const environment = input.observationOnly?.deploymentEnvironment;
        const requested = input.triggers.length === 1 ? input.triggers[0]!.trigger : undefined;
        const reuse = current && environment && requested?.kind === 'pluginEvent' && !('triggerDefinitionEnvelope' in requested)
          ? (row: AutomationDefinitionDetail) => {
            const trigger = row.triggers[0];
            return pluginJsonValuesEqual(row.observationOnly?.deploymentEnvironment, environment)
              && row.triggers.length === 1 && trigger?.kind === 'pluginEvent'
              && pluginJsonValuesEqual(trigger.eventRef, requested.eventRef)
              && trigger.sourceContractVersion === requested.sourceContractVersion
              && trigger.observation.kind === requested.observationTransport.kind
              && storedEvent(row, trigger.id, current).definition.sourceInstanceId === requested.sourceInstanceId;
          } : undefined;
        const retained = current ? await assertSourceConfigurations(input.automationId, input.name,
          input.triggers.flatMap(item => {
            const source = requestedEvent(input.automationId, item.triggerId, 0, item.trigger, current);
            return source ? [source] : [];
          }), current, reuse) : [];
        if (reuse) {
          const existing = retained.find(reuse);
          if (existing?.enabled) return existing;
          if (existing) {
            const nextScopes = requesterScopes({ ...existing, enabled: true });
            return commitRequesterScopes(requesterScopes(existing), nextScopes, () => params.automations.reconcile(existing.id, {
              expectedTemplateVersion: existing.templateVersion, name: existing.name, description: existing.description,
              enabled: true, assignments: [], removedTriggers: [], triggers: existing.triggers.map(trigger => ({
                kind: 'existing' as const, triggerId: trigger.id, expectedRevision: trigger.revision,
              })),
            }, existing), beforeWrite, signal);
          }
        }
        const triggers = input.triggers.map((item) => current ? { ...item,
          trigger: preparePrivateTrigger(input.automationId, item.triggerId, 0, item.trigger, current) } : item);
        const nextScopes = requesterScopes({ ...input, id: input.automationId,
          triggers: input.triggers.map(item => ({ id: item.triggerId, enabled: item.trigger.enabled })) });
        return commitRequesterScopes([], nextScopes, () => params.automations.create({ ...input, triggers }), beforeWrite, signal);
      },
      reconcile: async (automationId, input, row, beforeWrite, signal) => {
        if (!row || row.id !== automationId || row.templateVersion !== input.expectedTemplateVersion) unavailable('currentness_conflict');
        const needsPrivateWrite = input.triggers.some((item) => item.kind === 'new'
          ? isPrivateTrigger(item.trigger)
          : (item.trigger !== undefined && isPrivateTrigger(item.trigger)) || (item.enabled !== undefined && row.triggers.some((trigger) => trigger.id === item.triggerId && isPrivateTrigger(trigger))));
        const hasRetainedEvent = input.triggers.some(item => item.kind === 'existing'
          && row.triggers.some(trigger => trigger.id === item.triggerId && trigger.kind === 'pluginEvent'));
        const current = needsPrivateWrite || hasRetainedEvent ? await params.resolveEncryption() : null;
        if (current) await assertSourceConfigurations(automationId, input.name,
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
            const { definition } = storedEvent(row, retained.id, current);
            return [{ eventRef: retained.eventRef, sourceInstanceId: definition.sourceInstanceId, sourceConfig: definition.sourceConfig,
              watcher: retainedWatcher(retained) }];
          }), current);
        const triggers = input.triggers.map((item) => {
          if (item.kind === 'new') return current ? { ...item,
            trigger: preparePrivateTrigger(automationId, item.triggerId, 0, item.trigger, current) } : item;
          const retained = row.triggers.find((trigger) => trigger.id === item.triggerId);
          if (!retained || retained.revision !== item.expectedRevision) unavailable('currentness_conflict');
          if (!current) return item;
          if ((item.trigger === undefined && (item.enabled === undefined || item.enabled === retained.enabled)
            && item.triggerDefinitionEnvelope === undefined)
            || (item.trigger !== undefined && privateTriggerMatches(row, retained,
              { ...item.trigger, enabled: item.enabled ?? retained.enabled }, current))) {
            return { kind: 'existing' as const, triggerId: item.triggerId, expectedRevision: item.expectedRevision };
          }
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
        const nextScopes = requesterScopes({ ...input, id: automationId,
          triggers: input.triggers.map(item => ({ id: item.triggerId,
            enabled: item.kind === 'new' ? item.trigger.enabled : item.enabled ?? row.triggers.find(trigger => trigger.id === item.triggerId)!.enabled })) });
        return commitRequesterScopes(requesterScopes(row), nextScopes,
          () => params.automations.reconcile(automationId, { ...input, triggers }, row), beforeWrite, signal);
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
    ...(params.deploymentAction ? { deploymentAction: params.deploymentAction } : {}),
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    ...(params.sessionRead ? { sessionRead: params.sessionRead } : {}),
    ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    ...(params.resolveRunTrigger ? { resolveRunTrigger: params.resolveRunTrigger } : {}),
    ...(params.resolveRunSource ? { resolveRunSource: params.resolveRunSource } : {}),
    ...(params.resolveManagedMachine ? { resolveManagedMachine: params.resolveManagedMachine } : {}),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
    ...(params.pullRequests ? { pullRequests: params.pullRequests } : {}),
    openPullRequestTrigger: async (row, trigger) => storedPullRequest(row, trigger.id, await params.resolveEncryption()).definition,
    openPluginEventTrigger: async (row, trigger) => storedEvent(row, trigger.id, await params.resolveEncryption()).definition,
    resolveWorkflow: params.resolveWorkflow,
    ...(params.resolveWorkflowTeamIds ? { resolveWorkflowTeamIds: params.resolveWorkflowTeamIds } : {}),
    openContext: async (row) => {
      if (row.executionRecipe?.v !== 2) unavailable('source_unavailable');
      return open(row.executionRecipe.workflow);
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

export function createAccountWorkflowTriggerActions(params: WorkflowTriggerAccountHostParams): WorkflowTriggerActions {
  const actions = createAccountWorkflowTriggerActionOwner(params);
  return {
    ...actions,
    list: async (raw, caller) => {
      // The whole census opens under one fresh Account witness, not one HTTP
      // currentness round trip per context/trigger. Nothing survives this call.
      let encryption: Promise<AvailableAutomationAccountEncryptionV1> | undefined;
      const census = createAccountWorkflowTriggerActionOwner({ ...params,
        resolveEncryption: () => (encryption ??= params.resolveEncryption()),
      });
      const result = await census.list(raw, caller);
      if (encryption) {
        const opened = await encryption;
        const current = await params.resolveEncryption();
        // Private disclosure still has a fresh final authority check. The
        // Account-wide sequence may advance during legacy writes; only mode
        // and content-key identity determine whether these bytes can be opened.
        if (current.witness.mode !== opened.witness.mode
          || current.witness.contentKeyFingerprint !== opened.witness.contentKeyFingerprint) unavailable();
      }
      return result;
    },
  };
}
