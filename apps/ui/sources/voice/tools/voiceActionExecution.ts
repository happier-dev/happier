import { z } from 'zod/mini';
import { listVoiceToolActionSpecs, resolveVoiceClientToolNameAlias } from '@happier-dev/protocol/actions/actionSpecs';
import { decodeVoiceAssistantActions } from '@happier-dev/protocol/voice/actions';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol/voice/realtime/events';

/** Transport tool, not an Action: contributed Actions retain action.invoke. */
export const VOICE_ACTION_EXECUTE_TOOL_NAME = 'action_execute';
export const VoiceActionExecuteInputSchema = z.strictObject({
  actionId: z.string().check(z.trim(), z.minLength(1)),
  // As with MCP action_execute, the discovered Action owns its input schema.
  // The realtime call envelope already owns JSON depth/size validation.
  input: z.optional(z.unknown()),
});

export function resolveVoiceActionExecution(parameters: unknown) {
  const parsed = VoiceActionExecuteInputSchema.safeParse(parameters);
  if (!parsed.success) return null;
  const spec = listVoiceToolActionSpecs().find((candidate) => candidate.id === parsed.data.actionId);
  const toolName = spec?.bindings?.voiceClientToolName;
  if (!spec || !toolName) return null;
  // Resolve routing here; the Action executor (or a Voice override) owns input validation.
  return { spec, input: parsed.data.input ?? {}, toolName };
}

export function resolveVoiceExecutionToolName(toolName: string, parameters: unknown): string {
  return toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
    ? resolveVoiceActionExecution(parameters)?.toolName ?? toolName
    : resolveVoiceClientToolNameAlias(toolName) ?? toolName;
}

/** Decode semantic input once, independently of the provider's JSON transport. */
export function decodeVoiceToolInput(toolName: string, parameters: unknown): Readonly<{
  toolName: string;
  arguments: VoiceRealtimeJsonValue;
}> | null {
  const execution = toolName === VOICE_ACTION_EXECUTE_TOOL_NAME ? resolveVoiceActionExecution(parameters) : null;
  if (toolName === VOICE_ACTION_EXECUTE_TOOL_NAME && !execution) return null;
  const decoded = decodeVoiceAssistantActions([{ t: execution?.toolName ?? toolName,
    args: execution?.input ?? parameters }]).actions[0];
  if (!decoded) return null;
  // Voice Action inputs are JSON schemas; the published decoder has admitted them.
  const args = decoded.args as VoiceRealtimeJsonValue;
  return execution
    ? { toolName, arguments: { actionId: execution.spec.id, input: args } }
    : { toolName: decoded.t, arguments: args };
}
