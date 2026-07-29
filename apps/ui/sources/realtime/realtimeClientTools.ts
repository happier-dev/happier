import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import {
  listVoiceClientToolNames,
  listVoiceSdkSafeToolActionSpecs,
} from '@happier-dev/protocol';

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with the active coding session.
 */
const allTools = createVoiceToolHandlers({
  resolveSessionId: (explicitSessionId) =>
    resolveToolSessionId({
      explicitSessionId,
      currentSessionId: null,
    }),
});

export const realtimeClientTools = listVoiceClientToolNames().reduce(
  (acc, toolName) => {
    const handler = (allTools as any)[toolName];
    if (typeof handler === 'function') {
      (acc as any)[toolName] = handler;
    }
    return acc;
  },
  {} as Record<string, (parameters: unknown) => Promise<string>>,
);

/**
 * Provider SDKs that do not expose a stable call identity and observable result
 * delivery cannot safely host mutations across connection loss. Keep their
 * tool surface useful by projecting only canonical read-only actions.
 */
export const realtimeReadOnlyClientTools = listVoiceSdkSafeToolActionSpecs().reduce(
  (acc, spec) => {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    const handler = realtimeClientTools[toolName];
    if (toolName && typeof handler === 'function') acc[toolName] = handler;
    return acc;
  },
  {} as Record<string, (parameters: unknown) => Promise<string>>,
);
