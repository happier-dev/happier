import { describe, expect, it } from 'vitest';

import {
  reduceExternalAgentObservationEvidenceV1,
  type ExternalAgentObservationEvidenceV1,
  type ExternalAgentObservationTargetV1,
} from './externalAgentObservationReducer.js';

const TARGET: ExternalAgentObservationTargetV1 = {
  qualifiedLinkIdentity: {
    v: 1,
    agent: {
      pluginId: 'happier.claude',
      localId: 'claude',
    },
    source: {
      kind: 'claudeConfig',
      contractVersion: 1,
    },
  },
  linkGeneration: 'link-generation-7',
};

function evidence<T extends Omit<ExternalAgentObservationEvidenceV1, 'target'>>(
  value: T,
): ExternalAgentObservationEvidenceV1 {
  return { target: TARGET, ...value } as ExternalAgentObservationEvidenceV1;
}

describe('reduceExternalAgentObservationEvidenceV1', () => {
  it('keeps verified liveness, native waiting, and completed boundary independent', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'liveness',
          value: 'running',
          evidenceClass: 'process_probe',
          observedAtMs: 100,
          expiresAtMs: 200,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'agent_native',
          observedAtMs: 110,
          expiresAtMs: 180,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-17',
          evidenceClass: 'qualified_hook',
          observedAtMs: 115,
        }),
      ],
    });

    expect(result.axes.liveness.value).toBe('running');
    expect(result.axes.turnPhase.value).toBe('waiting');
    expect(result.axes.boundary).toMatchObject({ value: 'known', boundaryId: 'turn-17' });
    expect(result.snapshot).toEqual({
      v: 1,
      ...TARGET,
      status: 'waiting',
      observedAtMs: 110,
      expiresAtMs: 180,
      boundary: { id: 'turn-17', observedAtMs: 115 },
    });
  });

  it('keeps a replayed stable boundary reserved even when re-observed later', () => {
    const current = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-17',
          evidenceClass: 'qualified_hook',
          observedAtMs: 100,
        }),
      ],
    });

    const replay = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 220,
      evidence: [
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'agent_native',
          observedAtMs: 210,
          expiresAtMs: 300,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-17',
          evidenceClass: 'qualified_hook',
          observedAtMs: 215,
        }),
      ],
    });

    expect(replay.axes.boundary).toBe(current.axes.boundary);
    expect(replay.snapshot).toEqual({
      v: 1,
      ...TARGET,
      status: 'waiting',
      observedAtMs: 210,
      expiresAtMs: 300,
      boundary: { id: 'turn-17', observedAtMs: 100 },
    });
  });

  it('does not treat a PID without verified start time, SessionStart, or attach as working', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'process_liveness',
          value: 'running',
          processId: 42,
          processStartedAtMs: null,
          startTimeVerified: false,
          observedAtMs: 100,
          expiresAtMs: 200,
        }),
        evidence({ kind: 'lifecycle', event: 'session_started', observedAtMs: 105 }),
        evidence({ kind: 'lifecycle', event: 'attached', observedAtMs: 110 }),
      ],
    });

    expect(result.axes.liveness.value).toBe('unknown');
    expect(result.axes.turnPhase.value).toBe('unknown');
    expect(result.snapshot).toEqual({ v: 1, ...TARGET, status: 'unknown' });
  });

  it('does not let idle or Stop claim process exit or a completed boundary', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'turn_phase',
          value: 'idle',
          evidenceClass: 'agent_native',
          observedAtMs: 100,
          expiresAtMs: 180,
        }),
        evidence({ kind: 'lifecycle', event: 'stop', observedAtMs: 110 }),
      ],
    });

    expect(result.axes.liveness.value).toBe('unknown');
    expect(result.axes.boundary.value).toBe('unknown');
    expect(result.snapshot).toEqual({
      v: 1,
      ...TARGET,
      status: 'idle',
      observedAtMs: 100,
      expiresAtMs: 180,
    });
  });

  it('distinguishes an authoritative empty snapshot from retrieval failure', () => {
    const current = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'reconciliation',
          observedAtMs: 100,
          expiresAtMs: 150,
        }),
      ],
    });

    const failedWhileFresh = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 130,
      evidence: [
        evidence({
          kind: 'retrieval_failed',
          axis: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: 125,
        }),
      ],
    });
    expect(failedWhileFresh.snapshot.status).toBe('working');

    const failedAfterExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 151,
      evidence: [
        evidence({
          kind: 'retrieval_failed',
          axis: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: 151,
        }),
      ],
    });
    expect(failedAfterExpiry.snapshot).toEqual({ v: 1, ...TARGET, status: 'unknown' });

    const successfulEmpty = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 130,
      evidence: [
        evidence({
          kind: 'successful_empty',
          emptyTurnPhase: 'idle',
          evidenceClass: 'reconciliation',
          observedAtMs: 125,
          expiresAtMs: 200,
        }),
      ],
    });
    expect(successfulEmpty.snapshot).toEqual({
      v: 1,
      ...TARGET,
      status: 'idle',
      observedAtMs: 125,
      expiresAtMs: 200,
    });
  });

  it('fences mismatched identity, generation, and stale evidence', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        {
          ...evidence({
            kind: 'turn_phase',
            value: 'working',
            evidenceClass: 'agent_native',
            observedAtMs: 119,
            expiresAtMs: 200,
          }),
          target: {
            ...TARGET,
            qualifiedLinkIdentity: {
              ...TARGET.qualifiedLinkIdentity,
              source: {
                ...TARGET.qualifiedLinkIdentity.source,
                kind: 'differentSource',
              },
            },
          },
        },
        {
          ...evidence({
            kind: 'turn_phase',
            value: 'working',
            evidenceClass: 'agent_native',
            observedAtMs: 118,
            expiresAtMs: 200,
          }),
          target: {
            ...TARGET,
            linkGeneration: 'link-generation-6',
          },
        },
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'agent_native',
          observedAtMs: 110,
          expiresAtMs: 200,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'agent_native',
          observedAtMs: 100,
          expiresAtMs: 200,
        }),
      ],
    });

    expect(result.snapshot.status).toBe('waiting');
  });

  it('reduces equally fresh conflicting claims to unknown per axis', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'agent_native',
          observedAtMs: 110,
          expiresAtMs: 200,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'agent_native',
          observedAtMs: 110,
          expiresAtMs: 200,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-a',
          evidenceClass: 'qualified_hook',
          observedAtMs: 115,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-b',
          evidenceClass: 'qualified_hook',
          observedAtMs: 115,
        }),
      ],
    });

    expect(result.axes.turnPhase.value).toBe('unknown');
    expect(result.axes.boundary.value).toBe('unknown');
    expect(result.snapshot).toEqual({ v: 1, ...TARGET, status: 'unknown' });
  });

  it('degrades unsupported distinctions to unknown instead of guessing', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'unsupported',
          axis: 'liveness',
          evidenceClass: 'reconciliation',
          observedAtMs: 110,
        }),
        evidence({
          kind: 'unsupported',
          axis: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: 110,
        }),
        evidence({
          kind: 'unsupported',
          axis: 'boundary',
          evidenceClass: 'reconciliation',
          observedAtMs: 110,
        }),
      ],
    });

    expect(result.axes).toMatchObject({
      liveness: { value: 'unknown' },
      turnPhase: { value: 'unknown' },
      boundary: { value: 'unknown' },
    });
    expect(result.snapshot).toEqual({ v: 1, ...TARGET, status: 'unknown' });
  });

  it('exposes one earliest expiry for a daemon scheduler without creating timers', () => {
    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 100,
      evidence: [
        evidence({
          kind: 'process_liveness',
          value: 'running',
          processId: 42,
          processStartedAtMs: 10,
          startTimeVerified: true,
          observedAtMs: 90,
          expiresAtMs: 140,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'agent_native',
          observedAtMs: 95,
          expiresAtMs: 130,
        }),
      ],
    });

    expect(result.nextExpiryAtMs).toBe(130);
  });

  it('keeps bounded liveness evidence by class and falls back as stronger claims expire', () => {
    const initial = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'liveness',
          value: 'stopped',
          evidenceClass: 'reconciliation',
          observedAtMs: 90,
          expiresAtMs: 300,
        }),
        evidence({
          kind: 'liveness',
          value: 'stopped',
          evidenceClass: 'agent_native',
          observedAtMs: 100,
          expiresAtMs: 250,
        }),
        evidence({
          kind: 'process_liveness',
          value: 'running',
          processId: 42,
          processStartedAtMs: 10,
          startTimeVerified: true,
          observedAtMs: 110,
          expiresAtMs: 150,
        }),
      ],
    });

    expect(initial.axes.liveness.value).toBe('running');
    expect(initial.nextExpiryAtMs).toBe(150);

    const afterProcessProbeExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: initial,
      nowMs: 151,
      evidence: [],
    });
    expect(afterProcessProbeExpiry.axes.liveness.value).toBe('stopped');
    expect(afterProcessProbeExpiry.axes.liveness.observedAtMs).toBe(100);
    expect(afterProcessProbeExpiry.nextExpiryAtMs).toBe(250);

    const afterNativeExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: afterProcessProbeExpiry,
      nowMs: 251,
      evidence: [],
    });
    expect(afterNativeExpiry.axes.liveness.value).toBe('stopped');
    expect(afterNativeExpiry.axes.liveness.observedAtMs).toBe(90);
    expect(afterNativeExpiry.nextExpiryAtMs).toBe(300);
  });

  it('prefers explicit turn evidence per class and uses recent activity only as fallback', () => {
    const initial = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'turn_phase',
          value: 'idle',
          evidenceClass: 'reconciliation',
          observedAtMs: 90,
          expiresAtMs: 300,
        }),
        evidence({
          kind: 'recent_activity',
          evidenceClass: 'file_watch',
          observedAtMs: 115,
          expiresAtMs: 280,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'qualified_hook',
          observedAtMs: 105,
          expiresAtMs: 260,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'agent_native',
          observedAtMs: 110,
          expiresAtMs: 150,
        }),
      ],
    });

    expect(initial.snapshot.status).toBe('working');
    expect(initial.nextExpiryAtMs).toBe(150);

    const afterNativeExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: initial,
      nowMs: 151,
      evidence: [],
    });
    expect(afterNativeExpiry.snapshot.status).toBe('waiting');
    expect(afterNativeExpiry.nextExpiryAtMs).toBe(260);

    const afterHookExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: afterNativeExpiry,
      nowMs: 261,
      evidence: [],
    });
    expect(afterHookExpiry.snapshot.status).toBe('recentlyActive');
    expect(afterHookExpiry.nextExpiryAtMs).toBe(280);

    const afterActivityExpiry = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: afterHookExpiry,
      nowMs: 281,
      evidence: [],
    });
    expect(afterActivityExpiry.snapshot.status).toBe('idle');
    expect(afterActivityExpiry.nextExpiryAtMs).toBe(300);
  });

  it('scopes unsupported evidence to its class and rejects inadmissible axis claims', () => {
    const current = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'liveness',
          value: 'stopped',
          evidenceClass: 'reconciliation',
          observedAtMs: 90,
          expiresAtMs: 300,
        }),
        evidence({
          kind: 'liveness',
          value: 'running',
          evidenceClass: 'agent_native',
          observedAtMs: 100,
          expiresAtMs: 250,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'retrying',
          evidenceClass: 'qualified_hook',
          observedAtMs: 90,
          expiresAtMs: 300,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'waiting',
          evidenceClass: 'agent_native',
          observedAtMs: 100,
          expiresAtMs: 250,
        }),
      ],
    });

    const result = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 130,
      evidence: [
        evidence({
          kind: 'unsupported',
          axis: 'liveness',
          evidenceClass: 'agent_native',
          observedAtMs: 125,
        }),
        evidence({
          kind: 'unsupported',
          axis: 'turn_phase',
          evidenceClass: 'agent_native',
          observedAtMs: 125,
        }),
        evidence({
          kind: 'liveness',
          value: 'running',
          evidenceClass: 'file_watch',
          observedAtMs: 126,
          expiresAtMs: 400,
        }),
        evidence({
          kind: 'turn_phase',
          value: 'working',
          evidenceClass: 'process_probe',
          observedAtMs: 126,
          expiresAtMs: 400,
        }),
      ],
    });

    expect(result.axes.liveness).toMatchObject({
      value: 'stopped',
      observedAtMs: 90,
    });
    expect(result.axes.turnPhase).toMatchObject({
      value: 'retrying',
      observedAtMs: 90,
    });
  });

  it('keeps completed boundaries durable while enforcing class admission and conflicts', () => {
    const current = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      nowMs: 120,
      evidence: [
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-17',
          evidenceClass: 'qualified_hook',
          observedAtMs: 100,
        }),
      ],
    });

    const preserved = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current,
      nowMs: 180,
      evidence: [
        evidence({
          kind: 'unsupported',
          axis: 'boundary',
          evidenceClass: 'qualified_hook',
          observedAtMs: 150,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'stale-after-unsupported',
          evidenceClass: 'qualified_hook',
          observedAtMs: 140,
        }),
        evidence({
          kind: 'retrieval_failed',
          axis: 'boundary',
          evidenceClass: 'reconciliation',
          observedAtMs: 160,
        }),
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'must-not-be-admitted',
          evidenceClass: 'process_probe',
          observedAtMs: 170,
        }),
      ],
    });
    expect(preserved.axes.boundary).toMatchObject({
      value: 'known',
      boundaryId: 'turn-17',
      observedAtMs: 100,
    });

    const advanced = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: preserved,
      nowMs: 210,
      evidence: [
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-18',
          evidenceClass: 'reconciliation',
          observedAtMs: 200,
        }),
      ],
    });
    expect(advanced.axes.boundary).toMatchObject({
      value: 'known',
      boundaryId: 'turn-18',
      observedAtMs: 200,
    });

    const conflicted = reduceExternalAgentObservationEvidenceV1({
      target: TARGET,
      current: advanced,
      nowMs: 210,
      evidence: [
        evidence({
          kind: 'completed_boundary',
          boundaryId: 'turn-conflict',
          evidenceClass: 'agent_native',
          observedAtMs: 200,
        }),
      ],
    });
    expect(conflicted.axes.boundary).toEqual({
      value: 'unknown',
      observedAtMs: 200,
    });
  });
});
