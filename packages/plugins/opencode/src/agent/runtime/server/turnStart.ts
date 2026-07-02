import type { RuntimeEventV1 } from '@happier-dev/protocol';

import { publishOpenCodeRuntimeEvent } from './openCodeRuntimeEvents.js';
import type { OpenCodeServerRuntimeState } from './state.js';
import { createOpenCodeTurnId } from './state.js';

export async function beginOpenCodeProviderAutonomousBackgroundTurnIfNeeded(params: Readonly<{
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  state: OpenCodeServerRuntimeState;
  happierSessionId: string;
  setThinking: (thinking: boolean) => void;
  reason: 'background-wake' | 'background-output-tool';
}>): Promise<boolean> {
  if (params.state.turnInFlight) return false;
  if (!params.state.providerSessionId) return false;
  if (
    !params.state.pendingProviderAutonomousBackgroundWake &&
    params.reason !== 'background-output-tool'
  ) {
    return false;
  }
  params.state.activeTurnId = createOpenCodeTurnId();
  params.state.turnInFlight = true;
  params.state.pendingProviderAutonomousBackgroundWake = null;
  params.setThinking(true);
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-start',
    sessionId: params.happierSessionId,
    turnId: params.state.activeTurnId,
    emittedAtMs: Date.now(),
  });
  return true;
}
