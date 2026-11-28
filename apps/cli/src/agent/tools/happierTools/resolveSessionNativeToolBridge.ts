import { MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS } from '@happier-dev/protocol/prompts/isMemoryRecallGuidanceSupported';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { resolveEffectiveCodingPromptBehaviorV1 } from '@happier-dev/protocol/prompts/effectiveCodingPromptBehaviorV1';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionId, ActionsSettingsV1, FeatureId, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentSessionNativeToolDescriptor } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod/mini';

import { projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { isBuiltInHappierToolAdmitted, listBuiltInHappierTools } from './listBuiltInHappierTools';
import { createSessionActionSettingsView } from '@/settings/actionsSettingsProvider';
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
  surface?: 'agent' | 'voice';
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
    { surface: params.surface ?? 'agent', placement: null },
  );
  return isBuiltInHappierToolAdmitted(params.toolName, {
    surface: params.surface ?? 'agent',
    actionsSettings,
    isActionEnabled,
  });
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
  surface?: 'agent' | 'voice';
  accountSettings: Readonly<Record<string, unknown>>;
  profileId?: string | null;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  sessionId: string;
  happierToolsEnabled?: boolean;
  sessionMachineId?: string | null;
  sessionRootPath?: string | null;
  sessionWorkspace?: WorkspaceAddressV1 | null;
  memoryRecallGuidanceEnabled: boolean;
  /** Resolved from current host Session metadata, never Agent arguments. */
  sessionMemoryEnabled?: boolean;
  /** Current decision for the Session runtime's exact Home. Missing is fail-closed. */
  isServerFeatureEnabled?: (featureId: FeatureId) => boolean;
  /** Exact external Action tools admitted by the daemon catalog owner. */
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): readonly AgentSessionNativeToolDescriptor[] {
  const accountActionsSettings = resolveActionsSettingsWithEnvironmentOverride(params.accountSettings);
  const actionsSettings = createSessionActionSettingsView({ getActionsSettings: () => accountActionsSettings },
    () => null, params.surface).getActionsSettings();
  const isActionEnabled = (actionId: ActionId) => isActionEnabledByActionsSettings(
    actionId,
    actionsSettings,
    { surface: params.surface ?? 'agent', placement: null },
  );
  const titleUpdatesEnabled = isSessionAgentToolAvailableWithSettings({
    toolName: 'change_title',
    accountSettings: params.accountSettings,
    profileId: params.profileId,
    codingPromptBehavior: params.codingPromptBehavior,
    actionsSettings,
    surface: params.surface,
  });
  const tools = listBuiltInHappierTools({
    surface: params.surface ?? 'agent',
    happierToolsEnabled: params.happierToolsEnabled,
    actionsSettings,
    isActionEnabled,
    sessionMemoryEnabled: params.surface === 'voice' ? undefined : params.sessionMemoryEnabled === true,
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
            defaultSessionWorkspace: params.sessionWorkspace ?? null,
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
