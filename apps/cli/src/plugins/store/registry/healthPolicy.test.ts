import { describe, expect, it } from 'vitest';

import {
  beginGenerationHealthObservation,
  classifyFatalGenerationAttempt,
  completeGenerationHealthObservation,
  consumeGenerationTryOnce,
  createPendingGenerationHealthRecord,
  recordGenerationAttemptResult,
  resolveAutomaticGenerationRecovery,
  resolveFailedGenerationTrial,
} from './healthPolicy';

describe('immutable generation health policy', () => {
  it('counts only unique attributed post-commit fatal activation/bootstrap attempts in the rolling window', () => {
    let record = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'1'.repeat(64)}`,
    });
    const excluded = classifyFatalGenerationAttempt({
      pluginId: 'acme.plugin', attemptId: 'excluded', generationId: 'generation-a', committed: true, kind: 'handler', outcome: 'fatal', attributed: true,
    });
    expect(excluded.eligible).toBe(false);

    for (const [attemptId, nowMs] of [['a', 1_000], ['b', 2_000], ['b', 2_500], ['c', 3_000]] as const) {
      const classification = classifyFatalGenerationAttempt({
        pluginId: 'acme.plugin', attemptId, generationId: 'generation-a', committed: true, kind: 'lazyActivation', outcome: 'fatal', attributed: true,
      });
      const transition = recordGenerationAttemptResult({ record, classification, nowMs });
      record = transition.record;
      if (attemptId === 'c') expect(transition.decision).toBe('recover_or_disable');
    }
    expect(record.eligibleFailures).toHaveLength(3);
    expect(resolveAutomaticGenerationRecovery({ record, lastKnownGood: { available: true, automaticRecoveryEligible: true } }))
      .toMatchObject({ action: 'rollback_to_lkg', record: { state: 'quarantined', tryOnce: 'available' } });
    expect(resolveAutomaticGenerationRecovery({ record, lastKnownGood: null }).action).toBe('disable_plugin');
  });

  it('fails closed for every non-eligible failure source and for ambiguous or non-fatal eligible phases', () => {
    const base = {
      pluginId: 'acme.plugin',
      generationId: 'generation-a',
      committed: true,
      outcome: 'fatal' as const,
      attributed: true,
    };
    const excluded = [
      ...(['handler', 'renderer', 'session', 'connectivity', 'shutdown'] as const).map((kind) => ({
        ...base,
        attemptId: `excluded-${kind}`,
        kind,
        expectedReason: 'ineligible_kind',
      })),
      {
        ...base,
        attemptId: 'excluded-agent-child',
        kind: 'session' as const,
        expectedReason: 'ineligible_kind',
      },
      {
        ...base,
        attemptId: 'excluded-pre-commit',
        kind: 'lazyActivation' as const,
        committed: false,
        expectedReason: 'pre_commit',
      },
      {
        ...base,
        attemptId: 'excluded-unattributed',
        kind: 'primaryBootstrap' as const,
        attributed: false,
        expectedReason: 'unattributed',
      },
      ...(['failure', 'cancelled', 'timeout'] as const).map((outcome) => ({
        ...base,
        attemptId: `excluded-${outcome}`,
        kind: 'primaryBootstrap' as const,
        outcome,
        expectedReason: 'non_fatal',
      })),
    ];

    for (const { expectedReason, ...input } of excluded) {
      expect(classifyFatalGenerationAttempt(input)).toMatchObject({
        eligible: false,
        reason: expectedReason,
      });
    }

    // Abrupt power loss produces no completed supervised attempt to classify.
    // With no input event, persisted health remains unchanged.
    const record = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-a',
      fingerprint: `sha256:${'7'.repeat(64)}`,
    });
    expect(record).toMatchObject({ eligibleFailures: [], consumedAttemptIds: [] });
  });

  it('counts the exact five-minute rolling-window boundary and excludes an attempt one millisecond beyond it', () => {
    const createRecord = () => createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'6'.repeat(64)}`,
    });
    const classification = (attemptId: string) => classifyFatalGenerationAttempt({
      pluginId: 'acme.plugin', attemptId, generationId: 'generation-a', committed: true,
      kind: 'primaryBootstrap', outcome: 'fatal', attributed: true,
    });

    let exactBoundary = createRecord();
    for (const [attemptId, nowMs] of [['a', 1_000], ['b', 300_000], ['c', 301_000]] as const) {
      const transition = recordGenerationAttemptResult({ record: exactBoundary, classification: classification(attemptId), nowMs });
      exactBoundary = transition.record;
      if (attemptId === 'c') expect(transition.decision).toBe('recover_or_disable');
    }
    expect(exactBoundary.eligibleFailures.map((failure) => failure.attemptId)).toEqual(['a', 'b', 'c']);

    let beyondBoundary = createRecord();
    for (const [attemptId, nowMs] of [['a', 1_000], ['b', 300_001], ['c', 301_001]] as const) {
      const transition = recordGenerationAttemptResult({ record: beyondBoundary, classification: classification(attemptId), nowMs });
      beyondBoundary = transition.record;
      if (attemptId === 'c') expect(transition.decision).toBe('recorded');
    }
    expect(beyondBoundary.eligibleFailures.map((failure) => failure.attemptId)).toEqual(['b', 'c']);
  });

  it('rejects an attributed attempt whose plugin or generation identity does not match the health record', () => {
    const record = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'4'.repeat(64)}`,
    });
    const wrongGeneration = classifyFatalGenerationAttempt({
      pluginId: 'acme.plugin', attemptId: 'attempt-a', generationId: 'generation-b', committed: true,
      kind: 'lazyActivation', outcome: 'fatal', attributed: true,
    });
    const wrongPlugin = classifyFatalGenerationAttempt({
      pluginId: 'other.plugin', attemptId: 'attempt-b', generationId: 'generation-a', committed: true,
      kind: 'primaryBootstrap', outcome: 'fatal', attributed: true,
    });

    expect(() => recordGenerationAttemptResult({ record, classification: wrongGeneration, nowMs: 1_000 }))
      .toThrow(/generation identity/i);
    expect(() => recordGenerationAttemptResult({ record, classification: wrongPlugin, nowMs: 1_000 }))
      .toThrow(/plugin identity/i);
  });

  it('never forgets a consumed host attempt id merely because later attempts were recorded', () => {
    let record = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'5'.repeat(64)}`,
    });
    for (let index = 0; index < 129; index += 1) {
      const classification = classifyFatalGenerationAttempt({
        pluginId: 'acme.plugin', attemptId: `attempt-${index}`, generationId: 'generation-a',
        committed: true, kind: 'primaryBootstrap', outcome: 'fatal', attributed: true,
      });
      record = recordGenerationAttemptResult({
        record,
        classification,
        nowMs: index * 6 * 60_000,
      }).record;
    }
    const replay = classifyFatalGenerationAttempt({
      pluginId: 'acme.plugin', attemptId: 'attempt-0', generationId: 'generation-a',
      committed: true, kind: 'primaryBootstrap', outcome: 'fatal', attributed: true,
    });

    expect(recordGenerationAttemptResult({
      record,
      classification: replay,
      nowMs: 129 * 6 * 60_000,
    }).decision).toBe('duplicate');
  });

  it('requires ten continuous minutes in one daemon instance and never counts downtime', () => {
    const pending = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'2'.repeat(64)}`,
    });
    const observing = beginGenerationHealthObservation({ record: pending, daemonInstanceId: 'daemon-a', daemonUptimeMs: 5_000 });

    expect(completeGenerationHealthObservation({ record: observing, daemonInstanceId: 'daemon-b', daemonUptimeMs: 700_000 }).decision)
      .toBe('restart_required');
    expect(completeGenerationHealthObservation({ record: observing, daemonInstanceId: 'daemon-a', daemonUptimeMs: 604_999 }).decision)
      .toBe('monitoring');
    expect(completeGenerationHealthObservation({ record: observing, daemonInstanceId: 'daemon-a', daemonUptimeMs: 605_000 }).decision)
      .toBe('healthy');
  });

  it('consumes Try once before execution and never rearms the same fingerprint', () => {
    const pending = createPendingGenerationHealthRecord({
      pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', fingerprint: `sha256:${'3'.repeat(64)}`,
    });
    const quarantined = { ...pending, state: 'quarantined' as const, tryOnce: 'available' as const };

    const consumed = consumeGenerationTryOnce(quarantined);
    expect(consumed).toMatchObject({ state: 'trial', tryOnce: 'consumed' });
    expect(resolveFailedGenerationTrial({ record: consumed, lastKnownGood: null }))
      .toMatchObject({ action: 'disable_plugin', record: { state: 'quarantined', tryOnce: 'consumed' } });
    expect(() => consumeGenerationTryOnce({ ...quarantined, tryOnce: 'consumed' })).toThrow(/unavailable/i);
  });
});
