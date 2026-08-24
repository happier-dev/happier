import {
  MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS,
  isActionEnabledByActionsSettings,
  resolveEffectiveCodingPromptBehaviorV1,
  zodSchemaToJsonSchemaObject,
  type ActionId,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
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
  actionsSettings: ActionsSettingsV1;
}>): boolean {
  if (resolveEffectiveCodingPromptBehaviorV1({
    settings: params.accountSettings,
    profileId: params.profileId ?? null,
  }).sessionTitleUpdates === 'disabled') {
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
}>): boolean {
  return isSessionAgentChangeTitleToolAvailableWithSettings({
    ...params,
    actionsSettings: resolveActionsSettingsWithEnvironmentOverride(params.accountSettings),
  });
}

export function resolveSessionNativeToolDescriptors(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  sessionId: string;
  sessionMachineId?: string | null;
  memoryRecallGuidanceEnabled: boolean;
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
    actionsSettings,
  });
  const tools = listBuiltInHappierTools({
    surface: 'agent',
    actionsSettings,
    isActionEnabled,
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
