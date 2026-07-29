import { publishOpenCodeRuntimeEvent } from './openCodeRuntimeEvents.js';
import type { OpenCodeForegroundToolTracker } from './foregroundToolTracker.js';
import {
  claimOpenCodeActiveTurnForTerminalEvent,
  type OpenCodeServerRuntimeState,
} from './state.js';
import { readStatusType } from './state.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';

export async function completeOpenCodeTurnIfReady(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  state: OpenCodeServerRuntimeState;
  foregroundToolTracker: OpenCodeForegroundToolTracker;
  happierSessionId: string;
  resetCurrentTurnObservations: () => void;
  status: unknown;
  hasTerminalAssistantHistory?: boolean;
  // Generation-aware liveness (Lane E). When provided, completion is blocked only by provider work
  // that is NOT orphaned by a replaced managed-server generation; orphaned old-generation work no
  // longer wedges completion. Defaults to the generation-agnostic `hasActiveProviderWork`.
  hasLiveProviderWork?: () => boolean;
}>): Promise<void> {
  if (!params.state.turnInFlight || !params.state.activeTurnId || !params.state.providerSessionId) return;
  const hasLiveProviderWork = params.hasLiveProviderWork
    ?? (() => params.foregroundToolTracker.hasActiveToolCalls());
  if (hasLiveProviderWork()) return;
  if (readStatusType(params.status) !== 'idle' && params.hasTerminalAssistantHistory !== true) return;

  const turnId = claimOpenCodeActiveTurnForTerminalEvent(params.state);
  if (!turnId) return;
  params.resetCurrentTurnObservations();
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-complete',
    sessionId: params.happierSessionId,
    turnId,
    emittedAtMs: Date.now(),
  });
}
