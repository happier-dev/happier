import { getActionContextualDefaults, getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RuntimeActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import type { ActionContextualDefaults } from '@happier-dev/protocol';
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

function schemaDeclaresField(schema: unknown, field: string): boolean {
  if (schema instanceof z.ZodObject) return Object.prototype.hasOwnProperty.call(schema.shape, field);
  if (schema instanceof z.ZodIntersection) {
    return schemaDeclaresField(schema.def.left, field) || schemaDeclaresField(schema.def.right, field);
  }
  return false;
}

function contextualBrowserSessionId(actionId: string, context: SessionBoundActionToolContext): string | null {
  const sessionId = normalizeContextValue(context.defaultSessionId);
  if (!sessionId) return null;
  const parsed = RuntimeActionIdV1Schema.safeParse(actionId);
  if (!parsed.success || resolveRuntimeActionExecutionFamily(parsed.data) !== 'browser') return null;
  const schema = getActionSpec(parsed.data).inputSchema;
  return schemaDeclaresField(schema, 'browserSessionId')
    ? sessionId
    : null;
}

export function resolveActionToolContextualDefaults(params: Readonly<{
  actionId: string;
  input?: unknown;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): ActionContextualDefaults | null {
  const builtIn = getActionContextualDefaults(params.actionId, params.input);
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
  const browserSessionId = contextualBrowserSessionId(params.actionId, params.context);
  if (!defaults && !browserSessionId) return params.input;

  const input = params.input as Readonly<Record<string, unknown>>;
  const additions: Record<string, string> = {};
  if (
    defaults?.sessionId === 'current_session'
    && !Object.prototype.hasOwnProperty.call(input, 'sessionId')
  ) {
    const value = normalizeContextValue(params.context.defaultSessionId);
    if (value) additions.sessionId = value;
  }
  if (
    defaults?.machineId === 'current_session_machine'
    && normalizeContextValue(input.machineId) === null
  ) {
    const value = normalizeContextValue(params.context.defaultSessionMachineId);
    if (value) additions.machineId = value;
  }
  if (browserSessionId && !Object.prototype.hasOwnProperty.call(input, 'browserSessionId')) {
    additions.browserSessionId = browserSessionId;
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
  const browserSessionId = contextualBrowserSessionId(params.actionId, params.context);
  if (!defaults && !browserSessionId) return params.inputSchema;

  const optionalFields = new Set<string>();
  if (defaults?.sessionId && normalizeContextValue(params.context.defaultSessionId)) optionalFields.add('sessionId');
  if (defaults?.machineId && normalizeContextValue(params.context.defaultSessionMachineId)) optionalFields.add('machineId');
  if (browserSessionId) optionalFields.add('browserSessionId');
  if (optionalFields.size === 0) return params.inputSchema;

  // Browser automation combines the strict request with its action-kind refinement. Project
  // both sides so host defaults are accepted without dropping either validation contract.
  if (params.inputSchema instanceof z.ZodIntersection) {
    const left = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema.def.left });
    const right = projectSessionBoundActionToolInputSchema({ ...params, inputSchema: params.inputSchema.def.right });
    return left instanceof z.ZodType && right instanceof z.ZodType ? z.intersection(left, right) : params.inputSchema;
  }

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
