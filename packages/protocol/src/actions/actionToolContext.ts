import { z } from '../zodRuntimePolicy.js';
import { getActionContextualDefaults, getActionSpec } from './actionSpecs.js';
import { RuntimeActionIdV1Schema } from './actionIds.js';
import { resolveRuntimeActionExecutionFamily } from './executor/dispatch.js';
import type { ActionContextualDefaults } from './contextualDefaults.js';

export type SessionBoundActionToolContext = Readonly<{
  defaultSessionId?: string | null;
  defaultSessionMachineId?: string | null;
  defaultSessionRootPath?: string | null;
}>;

function normalizeContextValue(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function schemaDeclaresField(schema: unknown, field: string): boolean {
  if (schema instanceof z.core.$ZodObject) return Object.prototype.hasOwnProperty.call(schema._zod.def.shape, field);
  if (schema instanceof z.core.$ZodIntersection) {
    return schemaDeclaresField(schema._zod.def.left, field) || schemaDeclaresField(schema._zod.def.right, field);
  }
  return false;
}

/** One normalization for execution and exact transcript correlation; explicit operands stay explicit. */
export function bindContextualActionToolInput(params: Readonly<{
  actionId: string;
  input: unknown;
  contextualDefaults?: ActionContextualDefaults | null;
  context: SessionBoundActionToolContext;
}>): unknown {
  if (!params.input || typeof params.input !== 'object' || Array.isArray(params.input)) return params.input;
  const defaults = params.contextualDefaults ?? getActionContextualDefaults(params.actionId, params.input);
  const input = params.input as Readonly<Record<string, unknown>>;
  const additions: Record<string, string> = {};
  if (defaults?.sessionId === 'current_session' && !Object.prototype.hasOwnProperty.call(input, 'sessionId')) {
    const value = normalizeContextValue(params.context.defaultSessionId);
    if (value) additions.sessionId = value;
  }
  if (defaults?.machineId === 'current_session_machine' && normalizeContextValue(input.machineId) === null) {
    const value = normalizeContextValue(params.context.defaultSessionMachineId);
    if (value) additions.machineId = value;
  }
  if (defaults?.rootPath === 'current_session_root' && !Object.prototype.hasOwnProperty.call(input, 'rootPath')) {
    const machineId = normalizeContextValue(params.context.defaultSessionMachineId);
    const selectedMachineId = normalizeContextValue(input.machineId) ?? additions.machineId;
    const rootPath = normalizeContextValue(params.context.defaultSessionRootPath);
    // The Session root belongs to its Machine; an explicit other Machine needs its own root.
    if (rootPath && machineId && selectedMachineId === machineId) additions.rootPath = rootPath;
  }
  const sessionId = normalizeContextValue(params.context.defaultSessionId);
  if (sessionId && !Object.prototype.hasOwnProperty.call(input, 'browserSessionId')) {
    const action = RuntimeActionIdV1Schema.safeParse(params.actionId);
    if (action.success && resolveRuntimeActionExecutionFamily(action.data) === 'browser'
      && schemaDeclaresField(getActionSpec(action.data).inputSchema, 'browserSessionId')) {
      additions.browserSessionId = sessionId;
    }
  }
  return Object.keys(additions).length === 0 ? params.input : { ...input, ...additions };
}
