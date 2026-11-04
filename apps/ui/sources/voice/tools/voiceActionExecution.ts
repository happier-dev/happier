import { z } from 'zod/mini';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';

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
  if (!spec || spec.id === 'action.invoke' || !toolName) return null;
  const input = spec.inputSchema.safeParse(parsed.data.input ?? {});
  if (!input.success) return null;
  return { spec, input: input.data, toolName };
}

export function resolveVoiceExecutionToolName(toolName: string, parameters: unknown): string {
  return toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
    ? resolveVoiceActionExecution(parameters)?.toolName ?? toolName
    : toolName;
}
