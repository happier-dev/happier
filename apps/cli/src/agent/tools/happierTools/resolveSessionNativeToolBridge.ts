import { MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS } from '@happier-dev/protocol/prompts/isMemoryRecallGuidanceSupported';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { resolveEffectiveCodingPromptBehaviorV1 } from '@happier-dev/protocol/prompts/effectiveCodingPromptBehaviorV1';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionId, ActionsSettingsV1, FeatureId, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentSessionNativeToolDescriptor } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod/mini';

import { projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { resolveActionsSettingsWithEnvironmentOverride } from '@/settings/actionsSettings';
import { projectMcpToolInputJsonSchema } from '@/mcp/server/projectMcpToolInputJsonSchema';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

function projectJsonSchema(schema: unknown) {
  const jsonSchema = schema instanceof z.core.$ZodType
    ? zodSchemaToJsonSchemaObject(schema, { reused: 'ref' })
    : schema;
  const objectSchema = jsonSchema && typeof jsonSchema === 'object' && !Array.isArray(jsonSchema)
    ? projectMcpToolInputJsonSchema(jsonSchema as Readonly<Record<string, unknown>>)
    : jsonSchema;
  return AgentRuntimeJsonValueV1Schema.parse(objectSchema);
}

function isSessionAgentToolAvailableWithSettings(params: Readonly<{
  toolName: string;
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  actionsSettings: ActionsSettingsV1;
}>): boolean {
  if (params.toolName === 'change_title' && (params.codingPromptBehavior === null || (params.codingPromptBehavior ?? resolveEffectiveCodingPromptBehaviorV1({
    settings: params.accountSettings,
    profileId: params.profileId ?? null,
  })).sessionTitleUpdates === 'disabled')) {
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
  }).some((tool) => tool.name === params.toolName);
}

export function isSessionAgentToolAvailable(params: Readonly<{
  toolName: string;
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
}>): boolean {
  return isSessionAgentToolAvailableWithSettings({
    ...params,
    actionsSettings: resolveActionsSettingsWithEnvironmentOverride(params.accountSettings),
  });
}

export function isSessionAgentChangeTitleToolAvailable(params: Omit<Parameters<typeof isSessionAgentToolAvailable>[0], 'toolName'>): boolean {
  return isSessionAgentToolAvailable({ ...params, toolName: 'change_title' });
}

export function resolveSessionNativeToolDescriptors(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  sessionId: string;
  sessionMachineId?: string | null;
  sessionRootPath?: string | null;
  memoryRecallGuidanceEnabled: boolean;
  /** Resolved from current host Session metadata, never Agent arguments. */
  sessionMemoryEnabled?: boolean;
  /** Current decision for the Session runtime's exact Home. Missing is fail-closed. */
  isServerFeatureEnabled?: (featureId: FeatureId) => boolean;
  /** Exact external Action tools admitted by the daemon catalog owner. */
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): readonly AgentSessionNativeToolDescriptor[] {
  const actionsSettings = resolveActionsSettingsWithEnvironmentOverride(params.accountSettings);
  const isActionEnabled = (actionId: ActionId) => isActionEnabledByActionsSettings(
    actionId,
    actionsSettings,
    { surface: 'agent', placement: null },
  );
  const titleUpdatesEnabled = isSessionAgentToolAvailableWithSettings({
    toolName: 'change_title',
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
    pluginToolCatalog: params.pluginToolCatalog,
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
            defaultSessionRootPath: params.sessionRootPath ?? null,
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
