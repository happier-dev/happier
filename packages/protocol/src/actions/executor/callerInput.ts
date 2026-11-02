import type { ActionSpec } from '../actionSpecs.js';
import type { ActionExecutorContext } from '../actionExecutor.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { actionInputValidationFailure } from './actionInputValidation.js';
import { isMissingActionSecretInputError, readMissingActionSecretInputPaths } from '../actionInputHintsRuntime.js';

export function callerInputSchema(spec: ActionSpec, ctx: ActionExecutorContext) {
  if (ctx.surface === 'cli') {
    // Friendly argv has already been bound; admit only the declared whole Action input.
    return spec.cli?.wholeInputSchema ?? spec.inputSchema;
  }
  if (ctx.surface === 'mcp') {
    return spec.surfaceBindings?.mcp?.inputSchema ?? spec.inputSchema;
  }
  if (ctx.surface === 'api') {
    return spec.surfaceBindings?.api?.inputSchema ?? spec.inputSchema;
  }
  return ctx.surface === 'plugin' && ctx.actionCaller?.kind === 'plugin'
    ? spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema
    : spec.inputSchema;
}

export async function bindCallerInput(
  spec: ActionSpec,
  input: unknown,
  ctx: ActionExecutorContext,
  hostInternal = false,
  admittedSchema?: ActionSpec['inputSchema'],
): Promise<Readonly<
  | { ok: true; input: unknown; inputSchema?: ActionSpec['inputSchema'] }
  | ActionExecuteFailure
>> {
  // Private children have no surface binding. Core admission parses their
  // semantic input after resolving targets, just as it does for bound input.
  if (hostInternal) return { ok: true, input };
  const schema = callerInputSchema(spec, ctx);
  const result = admittedSchema === schema
    ? { success: true as const, data: input }
    : schema.safeParse(input ?? {});
  const parsed = !result.success && isMissingActionSecretInputError(result.error, input,
    readMissingActionSecretInputPaths(spec, input))
    ? { success: true as const, data: input } : result;
  if (!parsed.success) {
    const timingIssue = spec.id === 'session.permission_mode.set'
      ? parsed.error.issues.find((issue) => issue.path[0] === 'applyTiming')
      : undefined;
    return { ...actionInputValidationFailure(parsed.error), error: timingIssue?.message ?? 'invalid_parameters' };
  }
  const caller = ctx.actionCaller ?? { kind: 'host' as const };
  const apiBinding = ctx.surface === 'api'
    ? spec.surfaceBindings?.api
    : undefined;
  const pluginBinding = ctx.surface === 'plugin' && caller.kind === 'plugin'
    ? spec.surfaceBindings?.plugin
    : undefined;
  const binding = apiBinding ?? pluginBinding;
  if (!binding?.bindInput) return { ok: true, input: parsed.data, inputSchema: schema };
  if (apiBinding && caller.kind !== 'host') {
    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  }
  if (pluginBinding && caller.kind !== 'plugin') {
    return { ok: false, errorCode: 'plugin_action_caller_required', error: 'plugin_action_caller_required' };
  }
  try {
    const bound = await binding.bindInput(parsed.data, {
      actionId: spec.id,
      surface: apiBinding ? 'api' : 'plugin',
      caller,
      ...(ctx.defaultSessionId !== undefined ? { defaultSessionId: ctx.defaultSessionId } : {}),
      ...(ctx.serverId !== undefined ? { serverId: ctx.serverId } : {}),
      ...(ctx.externalActionTarget !== undefined
        ? { externalActionTarget: ctx.externalActionTarget }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { ok: true, input: bound };
  } catch {
    return {
      ok: false,
      errorCode: apiBinding ? 'invalid_parameters' : 'plugin_action_input_binding_failed',
      error: apiBinding ? 'invalid_parameters' : 'plugin_action_input_binding_failed',
    };
  }
}
