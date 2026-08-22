import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '../types';
import { resolveTrackedSessionExitSettlementEvidence } from './resolveTrackedSessionExitSettlementEvidence';

describe('resolveTrackedSessionExitSettlementEvidence', () => {
  it('exposes a restart-interrupted turn only on the exit-settlement copy', () => {
    const tracked = {
      pid: 85855,
      startedBy: 'daemon',
      happySessionId: 'session-restarted',
      reattachedInterruptedTurnId: 'native-turn-1',
      agentRuntimeRunnerRestartDisposition: 'runner_authority_unavailable',
    } satisfies TrackedSession;

    const settlement =
      resolveTrackedSessionExitSettlementEvidence(tracked);

    expect(tracked).not.toHaveProperty('activeTurnId');
    expect(settlement.activeTurnId).toBe('native-turn-1');
    expect(settlement).not.toBe(tracked);
  });

  it('prefers a currently active exact turn over older restart evidence', () => {
    const tracked = {
      pid: 85856,
      startedBy: 'daemon',
      activeTurnId: 'current-turn',
      reattachedInterruptedTurnId: 'old-turn',
    } satisfies TrackedSession;

    expect(resolveTrackedSessionExitSettlementEvidence(tracked)).toBe(tracked);
  });
});
