import { z } from 'zod/mini';
import { listVoiceToolActionSpecs, resolveVoiceClientToolNameAlias } from '@happier-dev/protocol/actions/actionSpecs';
import { decodeVoiceAssistantActions } from '@happier-dev/protocol/voice/actions';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol/voice/realtime/events';

/** Transport tool, not an Action: contributed Actions retain action.invoke. */
export const VOICE_ACTION_EXECUTE_TOOL_NAME = 'action_execute';
export const VoiceActionExecuteInputSchema = z.strictObject({
  actionId: z.string().check(z.trim(), z.minLength(1)),
  // As with MCP action_execute, the discovered Action owns its input schema.
  // The realtime call envelope already owns JSON depth/size validation.
  input: z.optional(z.unknown()),
});

function decodeVoiceActionExecution(parameters: unknown) {
  const parsed = VoiceActionExecuteInputSchema.safeParse(parameters);
  if (!parsed.success) return actionInputValidationFailure(parsed.error);
  const spec = listVoiceToolActionSpecs().find((candidate) => candidate.id === parsed.data.actionId);
  const toolName = spec?.bindings?.voiceClientToolName;
  if (!spec || !toolName) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  // Resolve routing here; the Action executor (or a Voice override) owns input validation.
  return { ok: true as const, spec, input: parsed.data.input ?? {}, toolName };
}

export function resolveVoiceActionExecution(parameters: unknown) {
  const decoded = decodeVoiceActionExecution(parameters);
  return decoded.ok ? { spec: decoded.spec, input: decoded.input, toolName: decoded.toolName } : null;
}

export function resolveVoiceExecutionToolName(toolName: string, parameters: unknown): string {
  return toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
    ? resolveVoiceActionExecution(parameters)?.toolName ?? toolName
    : resolveVoiceClientToolNameAlias(toolName) ?? toolName;
}

/** Decode semantic input once, independently of the provider's JSON transport. */
export function decodeVoiceToolInput(toolName: string, parameters: unknown): Readonly<{
  ok: true;
  toolName: string;
  arguments: VoiceRealtimeJsonValue;
}> | NonNullable<ReturnType<typeof decodeVoiceAssistantActions>['failure']> {
  const execution = toolName === VOICE_ACTION_EXECUTE_TOOL_NAME ? decodeVoiceActionExecution(parameters) : null;
  if (execution && !execution.ok) return execution;
  const result = decodeVoiceAssistantActions([{ t: execution?.toolName ?? toolName,
    args: execution?.input ?? parameters }]);
  if (result.failure) return result.failure;
  // The canonical all-or-nothing decoder admitted the single supplied Action.
  const decoded = result.actions[0]!;
  // Voice Action inputs are JSON schemas; the published decoder has admitted them.
  const args = decoded.args as VoiceRealtimeJsonValue;
  return execution
    ? { ok: true, toolName, arguments: { actionId: execution.spec.id, input: args } }
    : { ok: true, toolName: decoded.t, arguments: args };
}
