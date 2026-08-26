import {
  type ActionId,
  type ActionsSettingsV1,
  getActionSpec,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';
import { projectContextualActionToolInputSchema } from './contextualActionToolInput';
import { listBuiltInHappierTools } from './listBuiltInHappierTools';

export type SessionAgentToolDescriptor = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  call: Readonly<{
    toolName: string;
    actionId: string | null;
  }>;
}>;

function toJsonSchema(inputSchema: unknown): Readonly<Record<string, unknown>> {
  if (!(inputSchema instanceof z.ZodType)) {
    throw new Error('Session-Agent tool input schema must be a Zod schema');
  }
  const projected = z.toJSONSchema(inputSchema, { target: 'draft-7' });
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new Error('Session-Agent tool input schema did not project to a JSON Schema object');
  }
  return projected;
}

export function resolveSessionAgentToolPresentation(params: Readonly<{
  actionsSettings?: ActionsSettingsV1 | null;
  isActionEnabled?: (id: ActionId) => boolean;
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  requiredDirectActionIds?: readonly ActionId[];
}>): readonly SessionAgentToolDescriptor[] {
  return listBuiltInHappierTools({
    surface: 'session_agent',
    actionsSettings: params.actionsSettings ?? null,
    isActionEnabled: params.isActionEnabled,
    requiredDirectActionIds: params.requiredDirectActionIds,
  }).map((tool) => {
    const actionId = getEquivalentActionIdForBuiltInTool(tool.name);
    const inputSchema = projectContextualActionToolInputSchema({
      actionId,
      inputSchema: tool.inputSchema,
      context: {
        defaultSessionId: params.defaultSessionId,
        defaultSessionMachineId: params.defaultSessionMachineId ?? null,
      },
    });
    const canonicalActionToolName = actionId
      ? String(getActionSpec(actionId).bindings?.mcpToolName ?? '').trim()
      : '';
    const call = actionId && canonicalActionToolName === tool.name
      ? { toolName: 'action_execute', actionId }
      : { toolName: tool.name, actionId: null };
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toJsonSchema(inputSchema),
      call,
    };
  });
}
