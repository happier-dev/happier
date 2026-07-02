import type { RuntimeEventV1 } from '@happier-dev/protocol';

import { publishOpenCodeRuntimeEvent } from './openCodeRuntimeEvents.js';
import type { OpenCodeProviderActivityTracker } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import type { OpenCodeServerRuntimeState } from './state.js';
import { readStatusType } from './state.js';

export async function completeOpenCodeTurnIfReady(params: Readonly<{
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  state: OpenCodeServerRuntimeState;
  providerActivityTracker: OpenCodeProviderActivityTracker;
  happierSessionId: string;
  resetCurrentTurnObservations: () => void;
  setThinking: (thinking: boolean) => void;
  status: unknown;
}>): Promise<void> {
  if (!params.state.turnInFlight || !params.state.activeTurnId || !params.state.providerSessionId) return;
  if (params.providerActivityTracker.hasActiveProviderWork()) return;
  if (readStatusType(params.status) === 'busy') return;

  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-complete',
    sessionId: params.happierSessionId,
    turnId: params.state.activeTurnId,
    emittedAtMs: Date.now(),
  });
  params.state.turnInFlight = false;
  params.resetCurrentTurnObservations();
  params.setThinking(false);
}
