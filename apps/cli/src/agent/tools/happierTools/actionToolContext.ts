import {
  getActionContextualDefaults,
  type ActionContextualDefaults,
} from '@happier-dev/protocol';
import { z } from 'zod';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

export type SessionBoundActionToolContext = Readonly<{
  defaultSessionId?: string | null;
  defaultSessionMachineId?: string | null;
}>;

function normalizeContextValue(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

export function resolveActionToolContextualDefaults(params: Readonly<{
  actionId: string;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionContextualDefaults | null {
  const builtIn = getActionContextualDefaults(params.actionId);
  if (builtIn) return builtIn;

  const projected = params.pluginToolCatalog?.find((tool) => tool.actionId === params.actionId);
  if (projected?.contextualDefaults) return projected.contextualDefaults;

  return params.registry?.actionsById?.get(params.actionId)?.definition.contextualDefaults ?? null;
}

export function bindContextualActionToolInput(params: Readonly<{
  actionId: string;
  input: unknown;
  context: SessionBoundActionToolContext;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): unknown {
  if (!params.input || typeof params.input !== 'object' || Array.isArray(params.input)) return params.input;
  const defaults = resolveActionToolContextualDefaults(params);
  if (!defaults) return params.input;

  const input = params.input as Readonly<Record<string, unknown>>;
  const additions: Record<string, string> = {};
  if (
    defaults.sessionId === 'current_session'
    && normalizeContextValue(input.sessionId) === null
  ) {
    const value = normalizeContextValue(params.context.defaultSessionId);
    if (value) additions.sessionId = value;
  }
  if (
    defaults.machineId === 'current_session_machine'
    && normalizeContextValue(input.machineId) === null
  ) {
    const value = normalizeContextValue(params.context.defaultSessionMachineId);
    if (value) additions.machineId = value;
  }
  return Object.keys(additions).length === 0 ? params.input : { ...input, ...additions };
}

export function projectSessionBoundActionToolInputSchema(params: Readonly<{
  actionId: string;
  inputSchema: unknown;
  context: SessionBoundActionToolContext;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  contextualDefaults?: ActionContextualDefaults | null;
}>): unknown {
  const defaults = params.contextualDefaults ?? resolveActionToolContextualDefaults(params);
  if (!defaults) return params.inputSchema;

  const optionalFields = new Set<string>();
  if (defaults.sessionId && normalizeContextValue(params.context.defaultSessionId)) optionalFields.add('sessionId');
  if (defaults.machineId && normalizeContextValue(params.context.defaultSessionMachineId)) optionalFields.add('machineId');
  if (optionalFields.size === 0) return params.inputSchema;

  if (params.inputSchema instanceof z.ZodObject) {
    const shape = params.inputSchema.shape as Record<string, z.ZodTypeAny>;
    const optionalShape = Object.fromEntries(
      [...optionalFields]
        .filter((field) => Object.prototype.hasOwnProperty.call(shape, field))
        .map((field) => [field, shape[field]!.optional()]),
    );
    return Object.keys(optionalShape).length === 0
      ? params.inputSchema
      : params.inputSchema.safeExtend(optionalShape);
  }

  if (!params.inputSchema || typeof params.inputSchema !== 'object' || Array.isArray(params.inputSchema)) {
    return params.inputSchema;
  }
  const schema = params.inputSchema as Readonly<Record<string, unknown>>;
  if (schema.type !== 'object' || !Array.isArray(schema.required)) return params.inputSchema;
  const required = schema.required.filter((field) => (
    typeof field !== 'string' || !optionalFields.has(field)
  ));
  return required.length === schema.required.length ? params.inputSchema : { ...schema, required };
}
