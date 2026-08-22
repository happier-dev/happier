import {
  createVoiceToolHandlers,
  type VoiceToolHandler,
} from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import {
  listVoiceClientToolNames,
  listVoiceSdkSafeToolActionSpecs,
} from '@happier-dev/protocol';

/**
 * Builds the client-tool map for one composed realtime Voice host.
 *
 * This module must not construct handlers at module evaluation time: the
 * default Action executor reaches the Voice runtime assembly, so a static map
 * here would re-enter that assembly before its imports have initialized. The
 * bundled runtime host is the sole production composition owner and supplies
 * the attempt-local current-UI port when it creates this map.
 */
type RealtimeClientTools = Readonly<Record<string, VoiceToolHandler>>;

export function createRealtimeClientTools(input: Readonly<{
  currentUiContext?: VoiceCurrentUiToolPort;
}> = {}): RealtimeClientTools {
  const allTools = createVoiceToolHandlers({
    resolveSessionId: (explicitSessionId) =>
      resolveToolSessionId({
        explicitSessionId,
        currentSessionId: null,
      }),
    ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
  });
  const tools: Record<string, VoiceToolHandler> = {};
  for (const toolName of listVoiceClientToolNames()) {
    const handler = allTools[toolName];
    if (handler) tools[toolName] = handler;
  }
  return Object.freeze(tools);
}

/**
 * Provider SDKs that do not expose a stable call identity and observable result
 * delivery cannot safely host mutations across connection loss. Keep their
 * tool surface useful by projecting only canonical read-only actions.
 */
export function createRealtimeReadOnlyClientTools(input: Readonly<{
  currentUiContext?: VoiceCurrentUiToolPort;
}> = {}): RealtimeClientTools {
  const allTools = createRealtimeClientTools(input);
  const tools: Record<string, VoiceToolHandler> = {};
  for (const spec of listVoiceSdkSafeToolActionSpecs()) {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    const handler = allTools[toolName];
    if (toolName && handler) tools[toolName] = handler;
  }
  return Object.freeze(tools);
}
