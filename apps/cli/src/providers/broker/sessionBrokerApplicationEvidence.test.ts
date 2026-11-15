import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionBrokerApplicationEvidence } from './sessionBrokerApplicationEvidence';
import { logger } from '@/ui/logger';

describe('Session broker application evidence', () => {
  it.each([false, true])('keeps delayed request outcomes on their captured turn and retires them with the host (logging failed=%s)', async loggingFailed => {
    let turnId: string | null = null;
    let current = true;
    let turnReads = 0;
    let generationReads = 0;
    const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => { if (loggingFailed) throw new Error('File logging unavailable'); });
    onTestFinished(() => log.mockRestore());
    const evidence = createSessionBrokerApplicationEvidence({ sessionId: 'session-1', pid: 123, processStartTimeMs: 456,
      readActiveTurnId: () => { turnReads++; return turnId; }, isCurrent: () => { generationReads++; return current; } });
    const denial = { v: 1, resourceId: 'selected-resource', reasonCode: 'broker_unavailable' } as const;
    evidence.beginRequest()?.(denial); // Startup discovery has no turn.
    expect([turnReads, generationReads]).toEqual([1, 0]);
    turnId = 'first';
    const oldRequest = evidence.beginRequest();
    oldRequest?.(denial);
    await expect(evidence.readDenial('first')).resolves.toEqual(denial);
    turnId = 'second';
    const newRequest = evidence.beginRequest();
    newRequest?.(denial);
    oldRequest?.(null); // Late old success must not erase the second turn's denial.
    oldRequest?.(denial); // Nor attribute an old refusal to its successor.
    await expect(evidence.readDenial('first')).resolves.toBeNull();
    await expect(evidence.readDenial('second')).resolves.toEqual(denial);
    newRequest?.(null);
    await expect(evidence.readDenial('second')).resolves.toBeNull();
    newRequest?.(denial);
    current = false;
    evidence.beginRequest()?.(denial);
    await expect(evidence.readDenial('second')).resolves.toBeNull();
    // Diagnostics reuse admission/outcome snapshots, including on refused reads.
    expect([turnReads, generationReads]).toEqual([10, 14]);
    const records = log.mock.calls.filter(([message, data]) => message === '[provider-broker-application]'
      && data && typeof data === 'object' && 'stage' in data && data.stage === 'evidence_capture')
      .map(([, record]) => record);
    const context = { stage: 'evidence_capture', sessionId: 'session-1', pid: 123, processStartTimeMs: 456 };
    expect(records).toEqual([
      { ...context, turnId: null, outcome: 'skipped', reason: 'no_admitted_turn' },
      { ...context, turnId: 'first', outcome: 'captured' },
      { ...context, turnId: 'second', outcome: 'captured' },
      { ...context, turnId: 'first', outcome: 'skipped', reason: 'turn_mismatch' },
      { ...context, turnId: 'second', outcome: 'captured' },
      { ...context, turnId: 'second', outcome: 'skipped', reason: 'pid_mismatch' },
    ]);
    expect(log.mock.calls.filter(([message, data]) => message === '[provider-broker-application]'
      && data && typeof data === 'object' && 'stage' in data && data.stage === 'evidence_read').map(([, data]) => data)).toEqual([
      { ...context, stage: 'evidence_read', turnId: 'first', outcome: 'hit' },
      { ...context, stage: 'evidence_read', turnId: 'first', outcome: 'miss', reason: 'turn_mismatch' },
      { ...context, stage: 'evidence_read', turnId: 'second', outcome: 'hit' },
      { ...context, stage: 'evidence_read', turnId: 'second', outcome: 'miss', reason: 'no_evidence' },
      { ...context, stage: 'evidence_read', turnId: 'second', outcome: 'miss', reason: 'pid_mismatch' },
    ]);
  });
});
