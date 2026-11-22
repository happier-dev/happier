import type { ActionId } from '../../actions/actionIds.js';
import { SESSION_AGENT_TRANSITION_ACTION_ID_V1 } from '../../actions/sessionAgentTransitionActionIdsV1.js';
import type { ActionSessionAddressV1 } from '../../actions/sessionAddressV1.js';
import type { WorkflowSessionAuthoringSelectionFieldId } from '../../workflows/workflowV1.js';
import type { AcpConfigOptionOverridesV1 } from '../metadata/metadataOverridesV1.js';
import { projectSessionModelRefToExecutionModelSelection } from '../../providers/selection/v2.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionKey.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import type { SessionAgentTransitionSelectionV1 } from '../agentTransition.js';
import { buildExistingSessionTransitionAgentId, EXISTING_SESSION_FIELD_APPLICATIONS, resolveExistingSessionAgentTargetApplication, type ExistingSessionChangeSet } from './existingSessionFieldApplication.js';
import {
  buildExistingSessionModeActionInput, buildExistingSessionConfigOptionActionInput,
  buildExistingSessionPermissionModeActionInput, buildExistingSessionModelActionInput,
  buildExistingSessionConnectedServicesAuthActionInput, buildExistingSessionCapabilitiesActionInput,
  buildExistingSessionAgentTransitionActionInput, buildExistingSessionMessageActionInput,
} from './existingSessionActionInputs.js';

export type ExistingSessionPlanningTarget = Readonly<{
  address: ActionSessionAddressV1;
  /** Canonical Agent contribution key from the resolved backend catalog. */
  agentId: string;
  /** Exact current engine, including its definition when several engines share an Agent. */
  agentTarget?: AgentExecutionTargetV1;
  machineId: string;
  availableModeIds?: readonly string[];
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
}>;
export type ExistingSessionChangeStage = Readonly<{
  actionId: ActionId;
  /** Caller supplies the stage's explicit-address selector as sessionId. */
  input: Readonly<Record<string, unknown>>;
  targets: readonly ActionSessionAddressV1[];
}>;
export type ExistingSessionChangePlan = Readonly<{
  stages: readonly ExistingSessionChangeStage[];
  unsupportedFields: readonly Readonly<{ field: WorkflowSessionAuthoringSelectionFieldId; reason: string }>[];
  skippedTargets: readonly Readonly<{ address: ActionSessionAddressV1; reason: string }>[];
}>;

/** Pure pending-change projection. Action admission and effects remain at the executor. */
export function planExistingSessionChanges(
  selection: ExistingSessionChangeSet,
  targets: readonly ExistingSessionPlanningTarget[],
  message?: string,
  messageLocalId?: string,
): ExistingSessionChangePlan {
  const unsupportedFields: { field: WorkflowSessionAuthoringSelectionFieldId; reason: string }[] = [];
  for (const field of Object.keys(EXISTING_SESSION_FIELD_APPLICATIONS) as WorkflowSessionAuthoringSelectionFieldId[]) {
    const application = EXISTING_SESSION_FIELD_APPLICATIONS[field];
    if (field !== 'capabilitySelection' && application.via === 'unsupported' && selection[field] !== undefined) unsupportedFields.push({ field, reason: application.reason });
  }
  const currentAgentIds = selection.agentTarget ? targets.map(target => target.agentTarget
    ? buildExistingSessionTransitionAgentId(target.agentTarget) : target.agentId) : [];
  const engine = resolveExistingSessionAgentTargetApplication(selection.agentTarget, currentAgentIds);
  if (engine.via === 'unavailable') return {
    stages: [], unsupportedFields,
    skippedTargets: targets.map(target => ({ address: target.address, reason: engine.reason })),
  };
  const phases = new Map<number, Map<string, { actionId: ActionId; input: Record<string, unknown>; targets: ActionSessionAddressV1[] }>>();
  const add = (phase: number, actionId: ActionId, raw: Record<string, unknown>, address: ActionSessionAddressV1) => {
    const { sessionId: _sessionId, ...input } = raw;
    let groups = phases.get(phase);
    if (!groups) { groups = new Map(); phases.set(phase, groups); }
    const key = JSON.stringify([actionId, input]);
    const group = groups.get(key);
    if (group) group.targets.push(address);
    else groups.set(key, { actionId, input, targets: [address] });
  };
  const hasMessage = message !== undefined && message.length > 0;
  const model = selection.modelSelection == null ? undefined
    : projectSessionModelRefToExecutionModelSelection(selection.modelSelection.ref);
  const personalModel = model?.modelSelection;
  const flatModel = selection.modelSelection === null
    ? { modelId: 'default', providerConnectionId: null }
    : personalModel && !('source' in personalModel) ? personalModel : undefined;
  const connectedAccountModel = personalModel && 'source' in personalModel ? personalModel : undefined;
  const selectedAgentId = selection.agentTarget ? buildQualifiedPluginContributionKey(selection.agentTarget.identity) : undefined;
  for (const [index, target] of targets.entries()) {
    const sessionId = target.address.sessionId;
    const agentId = selectedAgentId ?? target.agentId;
    const currentAgentId = currentAgentIds[index] ?? target.agentId;
    const transitioning = engine.via === 'transition' && engine.agentId !== currentAgentId;
    if (!transitioning && selection.acpSessionModeId !== undefined) add(0, EXISTING_SESSION_FIELD_APPLICATIONS.acpSessionModeId.actionId,
      buildExistingSessionModeActionInput({ sessionId, modeId: selection.acpSessionModeId ?? '', availableModeIds: target.availableModeIds }), target.address);
    if (!transitioning && selection.sessionConfigOptionOverrides !== undefined) {
      const overrides = selection.sessionConfigOptionOverrides?.overrides ?? {};
      for (const configId of new Set([...Object.keys(target.sessionConfigOptionOverrides?.overrides ?? {}), ...Object.keys(overrides)])) {
        const value = overrides[configId]?.value ?? null;
        add(0, EXISTING_SESSION_FIELD_APPLICATIONS.sessionConfigOptionOverrides.actionId,
          buildExistingSessionConfigOptionActionInput({ sessionId, configId, valueId: value === null ? null : String(value) }), target.address);
      }
    }
    if (transitioning) {
      const transitionSelection: SessionAgentTransitionSelectionV1 = { v: 1, agentId: engine.agentId,
        ...(selection.modelSelection ? { modelSelection: selection.modelSelection.ref }
          : flatModel ? { modelId: flatModel.modelId, providerConnectionId: flatModel.providerConnectionId } : {}),
        ...(selection.acpSessionModeId === undefined ? {} : { acpSessionModeId: selection.acpSessionModeId }),
        ...(selection.sessionConfigOptionOverrides === undefined ? {} : { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides ?? { v: 1, updatedAt: 0, overrides: {} } }),
      };
      add(1, SESSION_AGENT_TRANSITION_ACTION_ID_V1, buildExistingSessionAgentTransitionActionInput({ sessionId,
        expectedCurrentAgentId: currentAgentId, selection: transitionSelection }), target.address);
    }
    if (selection.connectedServices !== undefined) add(2, EXISTING_SESSION_FIELD_APPLICATIONS.connectedServices.actionId,
      buildExistingSessionConnectedServicesAuthActionInput({ sessionId, serverId: target.address.serverId,
        agentId, machineId: target.machineId, bindings: selection.connectedServices ?? { v: 2, bindingsByServiceId: {} } }), target.address);
    for (const delta of selection.capabilityDeltas ?? []) {
      add(3, EXISTING_SESSION_FIELD_APPLICATIONS.capabilitySelection.actionId,
        buildExistingSessionCapabilitiesActionInput({ sessionId, ...delta }), target.address);
    }
    if (selection.permissionMode !== undefined) add(4, 'session.permission_mode.set',
      buildExistingSessionPermissionModeActionInput({ sessionId, permissionMode: selection.permissionMode ?? 'default' }), target.address);
    if (model?.teamCredentialModel) add(4, 'session.model.set', buildExistingSessionModelActionInput({ sessionId, teamCredentialModel: model.teamCredentialModel }), target.address);
    else if (connectedAccountModel && !transitioning) add(4, 'session.model.set', buildExistingSessionModelActionInput({
      sessionId, modelSelection: connectedAccountModel,
    }), target.address);
    else if (flatModel && !transitioning) add(4, 'session.model.set', buildExistingSessionModelActionInput({
      sessionId, modelId: flatModel.modelId, providerConnectionId: flatModel.providerConnectionId,
    }), target.address);
    if (hasMessage) {
      add(5, 'session.message.send', buildExistingSessionMessageActionInput({ sessionId, message,
        ...(messageLocalId === undefined ? {} : { localId: messageLocalId }),
        ...(selection.permissionMode === undefined ? {} : { permissionModeOverride: selection.permissionMode ?? 'default' }),
        ...(connectedAccountModel && selection.modelSelection ? { modelSelection: selection.modelSelection } : {}),
        ...(flatModel ? { modelOverride: selection.modelSelection === null ? null : flatModel.modelId, providerConnectionId: flatModel.providerConnectionId } : {}),
      }), target.address);
    }
  }
  return { stages: [...phases.entries()].sort(([a], [b]) => a - b).flatMap(([, groups]) => [...groups.values()]), unsupportedFields, skippedTargets: [] };
}
