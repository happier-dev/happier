import { getActionSpec, type ActionId } from '@happier-dev/protocol';
import { z } from 'zod';

export type SessionBoundActionToolContext = Readonly<{
  defaultSessionId?: string | null;
  defaultSessionMachineId?: string | null;
}>;

function normalizeContextValue(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUsableExplicitValue(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length > 0;
}

function resolveContextValue(
  source: 'current_session' | 'current_session_machine',
  context: SessionBoundActionToolContext,
): string | null {
  return source === 'current_session'
    ? normalizeContextValue(context.defaultSessionId)
    : normalizeContextValue(context.defaultSessionMachineId);
}

function getContextualDefaults(actionId: string): Readonly<Record<string, 'current_session' | 'current_session_machine'>> {
  try {
    return getActionSpec(actionId as ActionId).contextualDefaults ?? {};
  } catch {
    return {};
  }
}

export function bindContextualActionToolInput(params: Readonly<{
  actionId: string;
  input: unknown;
  context: SessionBoundActionToolContext;
}>): unknown {
  if (!isInputRecord(params.input)) return params.input;

  let result = params.input;
  for (const [field, source] of Object.entries(getContextualDefaults(params.actionId))) {
    if (Object.prototype.hasOwnProperty.call(result, field) && hasUsableExplicitValue(result[field])) {
      continue;
    }
    const contextualValue = resolveContextValue(source, params.context);
    if (!contextualValue) continue;
    if (result === params.input) result = { ...params.input };
    result[field] = contextualValue;
  }
  return result;
}

export function projectContextualActionToolInputSchema(params: Readonly<{
  actionId: string | null | undefined;
  inputSchema: unknown;
  context: SessionBoundActionToolContext;
}>): unknown {
  if (!params.actionId || !(params.inputSchema instanceof z.ZodObject)) return params.inputSchema;

  const shape = params.inputSchema.shape as Record<string, z.ZodTypeAny>;
  const overrides: Record<string, z.ZodTypeAny> = {};
  for (const [field, source] of Object.entries(getContextualDefaults(params.actionId))) {
    if (!shape[field] || !resolveContextValue(source, params.context)) continue;
    overrides[field] = shape[field].optional();
  }
  return Object.keys(overrides).length > 0
    ? params.inputSchema.safeExtend(overrides)
    : params.inputSchema;
}
