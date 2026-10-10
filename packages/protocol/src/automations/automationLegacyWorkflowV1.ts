import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { DEFAULT_AGENT_ID } from '../agents/defaultAgent.js';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { WorkflowStepExecutionSelectionSchema, type WorkflowDefinitionV1 } from '../workflows/workflowV1.js';
import { decodeAutomationTemplate, type AutomationTemplatePayloadV1 } from './automationTemplatePayloadV1.js';
import type { WorkflowRunExecutionTargetV1 } from '../workflows/workflowDefinitionV1.js';
import { WorkflowProjectTargetV1Schema, type WorkflowProjectTargetV1 } from '../workflows/workflowWorkspaceV1.js';
import { validateWorkflowDefinition } from '../workflows/workflowValidationV1.js';

export const LEGACY_AUTOMATION_WORKFLOW_STEP_ID = 'step-1';

type LegacyStoredTemplate = Readonly<{ template: AutomationTemplatePayloadV1; targetType: 'new_session' | 'existing_session' }>;

function storedTemplateSelection(params: LegacyStoredTemplate, machineId: string | null) {
  const template = decodeAutomationTemplate(JSON.stringify(params.template));
  if (!template) return null;
  const legacyAgentId = template.agent ?? (params.targetType === 'new_session' ? DEFAULT_AGENT_ID : undefined);
  const backend = template.backendTarget ?? (legacyAgentId ? { kind: 'backend' as const, backendId: legacyAgentId } : null);
  const agent = backend ? AgentExecutionTargetV1Schema.safeParse(parseBackendTargetKeyV2(buildBackendTargetKeyV2(backend))) : null;
  const { directory: _directory, prompt: _prompt, displayText: _displayText, agent: _agent,
    agentTarget: _agentTarget, backendTarget: _backend, executionTarget: _executionTarget,
    organizationPlacement: _placement, checkoutCreationDraft, environmentVariables,
    resume, existingSessionId, sessionEncryptionMode: _sessionMode, sessionEncryptionKeyBase64: _key,
    sessionEncryptionVariant: _variant,
    modelId, modelUpdatedAt, agentModeId, ...selection } = template;
  const modelSelection = template.modelSelection !== undefined ? template.modelSelection : (modelId && backend ? {
    v: 1 as const, ref: { agentTargetKey: buildBackendTargetKeyV2(backend), providerConnectionId: null, modelId }, updatedAt: modelUpdatedAt ?? 0,
  } : template.modelSelection);
  return WorkflowStepExecutionSelectionSchema.safeParse({ ...selection,
    ...(agent?.success ? { agentTarget: agent.data } : {}),
    ...(modelSelection === undefined ? {} : { modelSelection }),
    ...(agentModeId === undefined ? {} : { acpSessionModeId: agentModeId }),
    ...(environmentVariables === undefined ? {} : { launchEnvironment: { values: environmentVariables, unset: [] } }),
    ...(resume ? { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: resume } } : {}),
    ...(checkoutCreationDraft === undefined ? {} : { workspace: { kind: 'new_worktree', source: { kind: 'original' },
      displayName: checkoutCreationDraft.displayName, baseRef: checkoutCreationDraft.baseRef } }),
    conversation: params.targetType === 'existing_session'
      ? { kind: 'existing_session', sessionId: existingSessionId, machineId } : { kind: 'fresh' },
  });
}

/** A presentation-only view of retained 0.2 content, never conversion/admission authority. */
export function projectLegacyAutomationTemplateToWorkflowDefinitionV1(params: LegacyStoredTemplate & Readonly<{ machineId: string | null }>): WorkflowDefinitionV1 {
  const selection = storedTemplateSelection(params, params.machineId);
  return { version: 1, inputs: [], defaults: selection?.success ? selection.data : {
    ...(params.targetType === 'existing_session' && params.machineId !== null ? { conversation: { kind: 'existing_session' as const,
      sessionId: params.template.existingSessionId!, machineId: params.machineId } } : {}),
  }, blocks: [{ kind: 'step', id: LEGACY_AUTOMATION_WORKFLOW_STEP_ID,
    ...(params.template.prompt?.trim() ? {} : { inputMode: 'none' as const }),
    document: { text: params.template.prompt?.trim() ? params.template.prompt : '',
      ...(params.template.displayText === undefined ? {} : { displayText: params.template.displayText }),
      references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
}

function convertStoredTemplate(params: LegacyStoredTemplate, machineId: string | null,
  session?: Readonly<{ project: WorkflowProjectTargetV1; executionSelection?: WorkflowDefinitionV1['defaults'] }>): LegacyAutomationWorkflowConversionResultV1 {
  const refuse = (reason: LegacyAutomationWorkflowConversionReasonV1): LegacyAutomationWorkflowConversionResultV1 => (
    { kind: 'unavailable', code: 'legacy_conversion_unsupported', reason }
  );
  if ((params.targetType === 'existing_session') !== Boolean(params.template.existingSessionId?.trim())) {
    return refuse('conversation_unrepresentable');
  }
  if (params.targetType === 'existing_session'
    && (!session?.executionSelection?.agentTarget || (machineId !== null && session.project.machineId !== machineId))) return refuse('conversation_unrepresentable');
  if ((params.targetType === 'new_session' && (params.template.sessionEncryptionKeyBase64
      || params.template.sessionEncryptionMode || params.template.sessionEncryptionVariant))
    || params.template.executionTarget || params.template.agentTarget || params.template.organizationPlacement) return refuse('spawn_unrepresentable');
  const incoming = storedTemplateSelection(params, params.targetType === 'existing_session' ? session!.project.machineId : machineId);
  if (!incoming?.success) return refuse(params.template.runtimeDescriptorV1 ? 'runtime_descriptor_unsupported' : 'settings_unrepresentable');
  // The authenticated Session owns its Agent identity and cwd. Predecessor incoming
  // launch intent is still arbitrated by that Session's canonical runtime owner.
  const { agentTarget: _incomingAgent, conversation: _incomingConversation, workspace: _incomingWorkspace, ...incomingLaunch } = incoming.data;
  const selection = params.targetType === 'existing_session' ? WorkflowStepExecutionSelectionSchema.safeParse({
    ...session!.executionSelection, ...incomingLaunch,
    ...(params.template.modelSelection !== undefined ? { modelSelection: params.template.modelSelection }
      : params.template.modelId ? { modelSelection: { v: 1, updatedAt: params.template.modelUpdatedAt ?? 0,
        ref: { agentTargetKey: buildBackendTargetKeyV2(session!.executionSelection!.agentTarget!), providerConnectionId: null, modelId: params.template.modelId } } } : {}),
    conversation: { kind: 'existing_session', sessionId: params.template.existingSessionId, machineId: session!.project.machineId },
  }) : incoming;
  if (!selection?.success || !selection.data.agentTarget) return refuse(params.template.runtimeDescriptorV1
    ? 'runtime_descriptor_unsupported' : 'settings_unrepresentable');
  const definition = { ...projectLegacyAutomationTemplateToWorkflowDefinitionV1({ ...params, machineId }), defaults: selection.data };
  const validated = validateWorkflowDefinition(definition);
  const project = WorkflowProjectTargetV1Schema.omit({ machineId: true }).extend({
    machineId: WorkflowProjectTargetV1Schema.shape.machineId.optional(),
  }).safeParse(params.targetType === 'existing_session'
    ? session!.project : { ...(machineId === null ? {} : { machineId }), directory: params.template.directory });
  if (!validated.valid || !validated.normalizedDefinition) return refuse('settings_unrepresentable');
  if (!project.success) return refuse('workspace_unrepresentable');
  return { kind: 'available', definition: validated.normalizedDefinition, project: project.data, executionTarget: { kind: 'session' } };
}

import type { LegacyAutomationWorkflowConversionReasonV1 } from './automationLegacyWorkflowConversionReasonV1.js';
export { LegacyAutomationWorkflowConversionReasonV1Schema } from './automationLegacyWorkflowConversionReasonV1.js';
export type { LegacyAutomationWorkflowConversionReasonV1 } from './automationLegacyWorkflowConversionReasonV1.js';

export type LegacyAutomationWorkflowConversionResultV1 =
  | Readonly<{ kind: 'available'; definition: WorkflowDefinitionV1;
      project: Omit<WorkflowProjectTargetV1, 'machineId'> & { machineId?: string }; executionTarget: WorkflowRunExecutionTargetV1 }>
  | Readonly<{ kind: 'unavailable'; code: 'legacy_conversion_unsupported'; reason: LegacyAutomationWorkflowConversionReasonV1 }>;

/** Maps content only. The Automation owner performs the one revision-CAS write. */
export function convertLegacyAutomationRecipeToInlineWorkflowV1(params: Readonly<{
  legacyTemplate: LegacyStoredTemplate;
  machineId: string | null;
  session?: Readonly<{ project: WorkflowProjectTargetV1; executionSelection?: WorkflowDefinitionV1['defaults'] }>;
}>): LegacyAutomationWorkflowConversionResultV1 {
  return convertStoredTemplate(params.legacyTemplate, params.machineId, params.session);
}
