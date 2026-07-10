import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { publishOpenCodeRuntimeEvent } from './openCodeRuntimeEvents.js';
import type { OpenCodeProviderActivityTracker } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import {
  claimOpenCodeActiveTurnForTerminalEvent,
  type OpenCodeServerRuntimeState,
} from './state.js';
import { readStatusType } from './state.js';

export async function completeOpenCodeTurnIfReady(params: Readonly<{
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  state: OpenCodeServerRuntimeState;
  providerActivityTracker: OpenCodeProviderActivityTracker;
  happierSessionId: string;
  resetCurrentTurnObservations: () => void;
  setThinking: (thinking: boolean) => void;
  status: unknown;
  hasTerminalAssistantHistory?: boolean;
  // Generation-aware liveness (Lane E). When provided, completion is blocked only by provider work
  // that is NOT orphaned by a replaced managed-server generation; orphaned old-generation work no
  // longer wedges completion. Defaults to the generation-agnostic `hasActiveProviderWork`.
  hasLiveProviderWork?: () => boolean;
}>): Promise<void> {
  if (!params.state.turnInFlight || !params.state.activeTurnId || !params.state.providerSessionId) return;
  const hasLiveProviderWork = params.hasLiveProviderWork
    ?? (() => params.providerActivityTracker.hasActiveProviderWork());
  if (hasLiveProviderWork()) return;
  if (readStatusType(params.status) !== 'idle' && params.hasTerminalAssistantHistory !== true) return;

  const turnId = claimOpenCodeActiveTurnForTerminalEvent(params.state);
  if (!turnId) return;
  params.resetCurrentTurnObservations();
  params.setThinking(false);
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-complete',
    sessionId: params.happierSessionId,
    turnId,
    emittedAtMs: Date.now(),
  });
}
