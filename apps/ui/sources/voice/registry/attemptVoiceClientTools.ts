import type { VoiceClientToolDefinition } from '@happier-dev/plugin-sdk/voice/client';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

function attemptAborted(): Error {
  return Object.assign(new Error('voice_tool_attempt_aborted'), {
    name: 'AbortError',
    code: 'voice_tool_attempt_aborted',
  });
}

async function executeBeforeAttemptAborts<T>(
  execute: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw attemptAborted();
  let rejectAbort: ((reason: Error) => void) | null = null;
  const onAbort = (): void => rejectAbort?.(attemptAborted());
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([execute(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bind host-owned tool execution to the exact provider connection attempt. */
export function bindVoiceClientToolsToAttempt(
  tools: readonly VoiceClientToolDefinition[],
  signal: AbortSignal,
): readonly VoiceClientToolDefinition[] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    ...tool,
    async execute(parameters: VoiceRealtimeJsonValue) {
      if (signal.aborted) throw attemptAborted();
      return await executeBeforeAttemptAborts(() => tool.execute(parameters), signal);
    },
  })));
}
