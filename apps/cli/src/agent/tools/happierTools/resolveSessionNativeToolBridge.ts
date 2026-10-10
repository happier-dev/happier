import { MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS } from '@happier-dev/protocol/prompts/isMemoryRecallGuidanceSupported';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { resolveEffectiveCodingPromptBehaviorV1 } from '@happier-dev/protocol/prompts/effectiveCodingPromptBehaviorV1';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionId, ActionsSettingsV1, FeatureId, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentSessionNativeToolDescriptor } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod';

import { projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { resolveActionsSettingsWithEnvironmentOverride } from '@/settings/actionsSettings';

function projectJsonSchema(schema: unknown) {
  const jsonSchema = schema instanceof z.ZodType
    ? zodSchemaToJsonSchemaObject(schema)
    : schema;
  return AgentRuntimeJsonValueV1Schema.parse(jsonSchema);
}

function isSessionAgentChangeTitleToolAvailableWithSettings(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  actionsSettings: ActionsSettingsV1;
}>): boolean {
  if (params.codingPromptBehavior === null || (params.codingPromptBehavior ?? resolveEffectiveCodingPromptBehaviorV1({
    settings: params.accountSettings,
    profileId: params.profileId ?? null,
  })).sessionTitleUpdates === 'disabled') {
    return false;
  }
  const actionsSettings = params.actionsSettings;
  const isActionEnabled = (actionId: ActionId) => isActionEnabledByActionsSettings(
    actionId,
    actionsSettings,
    { surface: 'agent', placement: null },
  );
  return listBuiltInHappierTools({
    surface: 'agent',
    actionsSettings,
    isActionEnabled,
  }).some((tool) => tool.name === 'change_title');
}

export function isSessionAgentChangeTitleToolAvailable(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
}>): boolean {
  return isSessionAgentChangeTitleToolAvailableWithSettings({
    ...params,
    actionsSettings: resolveActionsSettingsWithEnvironmentOverride(params.accountSettings),
  });
}

export function resolveSessionNativeToolDescriptors(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  sessionId: string;
  sessionMachineId?: string | null;
  memoryRecallGuidanceEnabled: boolean;
  /** Resolved from current host Session metadata, never Agent arguments. */
  sessionMemoryEnabled?: boolean;
  /** Current decision for the Session runtime's exact Home. Missing is fail-closed. */
  isServerFeatureEnabled?: (featureId: FeatureId) => boolean;
}>): readonly AgentSessionNativeToolDescriptor[] {
  const actionsSettings = resolveActionsSettingsWithEnvironmentOverride(params.accountSettings);
  const isActionEnabled = (actionId: ActionId) => isActionEnabledByActionsSettings(
    actionId,
    actionsSettings,
    { surface: 'agent', placement: null },
  );
  const titleUpdatesEnabled = isSessionAgentChangeTitleToolAvailableWithSettings({
    accountSettings: params.accountSettings,
    profileId: params.profileId,
    codingPromptBehavior: params.codingPromptBehavior,
    actionsSettings,
  });
  const tools = listBuiltInHappierTools({
    surface: 'agent',
    actionsSettings,
    isActionEnabled,
    sessionMemoryEnabled: params.sessionMemoryEnabled === true,
    isServerFeatureEnabled: params.isServerFeatureEnabled ?? (() => false),
    requiredDirectActionIds: params.memoryRecallGuidanceEnabled
      ? MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS
      : [],
  });

  return Object.freeze(tools.flatMap((tool) => {
    if (tool.name === 'change_title' && !titleUpdatesEnabled) return [];
    const projectedSchema = tool.actionId
      ? projectSessionBoundActionToolInputSchema({
          actionId: tool.actionId,
          inputSchema: tool.inputSchema,
          contextualDefaults: tool.contextualDefaults ?? null,
          context: {
            defaultSessionId: params.sessionId,
            defaultSessionMachineId: params.sessionMachineId ?? null,
          },
        })
      : tool.inputSchema;
    return [Object.freeze({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: projectJsonSchema(projectedSchema),
    })];
  }));
}
