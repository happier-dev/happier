import type { PluginVoiceClientToolDefinition } from '@happier-dev/plugin-sdk/runtime';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

function attemptAborted(): Error {
  return Object.assign(new Error('voice_tool_attempt_aborted'), {
    name: 'AbortError',
    code: 'voice_tool_attempt_aborted',
  });
}

/** Bind host-owned tool execution to the exact provider connection attempt. */
export function bindVoiceClientToolsToAttempt(
  tools: readonly PluginVoiceClientToolDefinition[],
  signal: AbortSignal,
): readonly PluginVoiceClientToolDefinition[] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    ...tool,
    async execute(parameters: VoiceRealtimeJsonValue) {
      if (signal.aborted) throw attemptAborted();
      const result = await tool.execute(parameters);
      if (signal.aborted) throw attemptAborted();
      return result;
    },
  })));
}
