import type { ActionId } from '../../actions/actionIds.js';
import { SESSION_AGENT_TRANSITION_ACTION_ID_V1 } from '../../actions/sessionAgentTransitionActionIdsV1.js';
import type { ActionSessionAddressV1 } from '../../actions/sessionAddressV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { WorkflowSessionAuthoringSelection, WorkflowSessionAuthoringSelectionFieldId } from '../../workflows/workflowV1.js';
import type { AcpConfigOptionOverridesV1 } from '../metadata/metadataOverridesV1.js';
import { projectSessionModelRefToExecutionModelSelection } from '../../providers/selection/v2.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionKey.js';
import type { SessionAgentTransitionSelectionV1 } from '../agentTransition.js';
import { SESSION_CAPABILITY_KINDS_V1, readSessionCapabilityOverrideV1, type SessionCapabilitySelectionV1 } from '../../reach/sessionCapabilitySelectionV1.js';
import { EXISTING_SESSION_FIELD_APPLICATIONS } from './existingSessionFieldApplication.js';
import {
  buildExistingSessionModeActionInput, buildExistingSessionConfigOptionActionInput,
  buildExistingSessionPermissionModeActionInput, buildExistingSessionModelActionInput,
  buildExistingSessionConnectedServicesAuthActionInput, buildExistingSessionCapabilitiesActionInput,
  buildExistingSessionAgentTransitionActionInput,
} from './existingSessionActionInputs.js';

export type ExistingSessionPlanningTarget = Readonly<{
  address: ActionSessionAddressV1;
  /** Canonical Agent contribution key from the resolved backend catalog. */
  agentId: string;
  machineId: string;
  availableModeIds?: readonly string[];
  capabilitySelection?: SessionCapabilitySelectionV1;
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

export type ExistingSessionStageTargetResult = Readonly<ActionSessionAddressV1 & {
  actionId: ActionId;
  ok: boolean;
  result?: unknown;
}>;

/** Only accepted transitions advance; equal ids on different Homes stay distinct. */
export function filterExistingSessionStageTargets(
  stage: ExistingSessionChangeStage,
  previousResults: readonly ExistingSessionStageTargetResult[],
): ExistingSessionChangeStage {
  const failed = new Set(previousResults.filter(result => !result.ok
    || (result.actionId === SESSION_AGENT_TRANSITION_ACTION_ID_V1 && readRecord(result.result).type !== 'accepted'))
    .map(result => JSON.stringify([result.serverId, result.sessionId])));
  return { ...stage, targets: stage.targets.filter(target => !failed.has(JSON.stringify([target.serverId, target.sessionId]))) };
}

/** Pure pending-change projection. Action admission and effects remain at the executor. */
export function planExistingSessionChanges(
  selection: WorkflowSessionAuthoringSelection,
  targets: readonly ExistingSessionPlanningTarget[],
  message?: string,
): ExistingSessionChangePlan {
  const unsupportedFields: { field: WorkflowSessionAuthoringSelectionFieldId; reason: string }[] = [];
  for (const field of Object.keys(EXISTING_SESSION_FIELD_APPLICATIONS) as WorkflowSessionAuthoringSelectionFieldId[]) {
    const application = EXISTING_SESSION_FIELD_APPLICATIONS[field];
    if (selection[field] !== undefined && application.via === 'unsupported') unsupportedFields.push({ field, reason: application.reason });
  }
  // The portable transition cannot identify a configured Agent definition.
  if (selection.agentTarget !== undefined && (selection.agentTarget === null || selection.agentTarget.definitionId !== undefined)) return {
    stages: [], unsupportedFields,
    skippedTargets: targets.map(target => ({ address: target.address, reason: 'target_unavailable' })),
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
  const flatModel = selection.modelSelection === null
    ? { modelId: 'default', providerConnectionId: null }
    : model?.modelSelection;
  const selectedAgentId = selection.agentTarget ? buildQualifiedPluginContributionKey(selection.agentTarget.identity) : undefined;
  for (const target of targets) {
    const sessionId = target.address.sessionId;
    const agentId = selectedAgentId ?? target.agentId;
    const transitioning = agentId !== target.agentId;
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
      const transitionSelection: SessionAgentTransitionSelectionV1 = { v: 1, agentId,
        ...(selection.modelSelection ? { modelSelection: selection.modelSelection.ref }
          : flatModel ? { modelId: flatModel.modelId, providerConnectionId: flatModel.providerConnectionId } : {}),
        ...(selection.acpSessionModeId === undefined ? {} : { acpSessionModeId: selection.acpSessionModeId }),
        ...(selection.sessionConfigOptionOverrides === undefined ? {} : { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides ?? { v: 1, updatedAt: 0, overrides: {} } }),
      };
      add(1, 'session.agent.transition', buildExistingSessionAgentTransitionActionInput({ sessionId,
        expectedCurrentAgentId: target.agentId, selection: transitionSelection }), target.address);
    }
    if (selection.connectedServices !== undefined) add(2, EXISTING_SESSION_FIELD_APPLICATIONS.connectedServices.actionId,
      buildExistingSessionConnectedServicesAuthActionInput({ sessionId, serverId: target.address.serverId,
        agentId, machineId: target.machineId, bindings: selection.connectedServices ?? { v: 2, bindingsByServiceId: {} } }), target.address);
    if (selection.capabilitySelection !== undefined) {
      const before = target.capabilitySelection ?? {};
      const after = selection.capabilitySelection ?? {};
      for (const kind of SESSION_CAPABILITY_KINDS_V1) {
        const ids = (value: SessionCapabilitySelectionV1) => kind === 'skill'
          ? [...(value.skills?.forceIncludeSkillIds ?? []), ...(value.skills?.forceExcludeSkillIds ?? [])]
          : kind === 'mcp_server' ? [...(value.mcp?.forceIncludeServerIds ?? []), ...(value.mcp?.forceExcludeServerIds ?? [])]
          : value.skills?.excludeNativeSkillNames ?? [];
        for (const id of new Set([...ids(before), ...ids(after)])) {
          const state = readSessionCapabilityOverrideV1(after, kind, id);
          if (state === readSessionCapabilityOverrideV1(before, kind, id)) continue;
          add(3, EXISTING_SESSION_FIELD_APPLICATIONS.capabilitySelection.actionId,
            buildExistingSessionCapabilitiesActionInput({ sessionId, kind, id, state }), target.address);
        }
      }
    }
    if (model?.teamCredentialModel) add(4, 'session.model.set', buildExistingSessionModelActionInput({ sessionId, teamCredentialModel: model.teamCredentialModel }), target.address);
    if (hasMessage) {
      add(5, 'session.message.send', { message,
        ...(selection.permissionMode === undefined ? {} : { permissionModeOverride: selection.permissionMode ?? 'default' }),
        ...(flatModel ? { modelOverride: selection.modelSelection === null ? null : flatModel.modelId, providerConnectionId: flatModel.providerConnectionId } : {}),
      }, target.address);
    } else {
      if (selection.permissionMode !== undefined) add(4, 'session.permission_mode.set',
        buildExistingSessionPermissionModeActionInput({ sessionId, permissionMode: selection.permissionMode ?? 'default' }), target.address);
      if (flatModel && !transitioning) add(4, 'session.model.set', buildExistingSessionModelActionInput({ sessionId, ...flatModel }), target.address);
    }
  }
  return { stages: [...phases.entries()].sort(([a], [b]) => a - b).flatMap(([, groups]) => [...groups.values()]), unsupportedFields, skippedTargets: [] };
}
