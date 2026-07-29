import { describe, expect, it, vi } from 'vitest';

import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  createPiExternalSessionObservationContribution,
} from './observation.js';
import type { PiExternalSessionFileState } from './files.js';

function linkedSource(params: Readonly<{
  remoteSessionId?: string;
  sessionFile?: string;
  agentDir?: string;
}> = {}): AgentExternalSessionsResolvedIdentity {
  const agentDir = params.agentDir ?? '/tmp/pi-agent';
  const sessionFile =
    params.sessionFile ?? '/tmp/pi-agent/sessions/--tmp-workspace--/session.jsonl';
  return {
    source: {
      kind: 'piAgentDir',
      agentDir,
      sessionFile,
    },
    remoteSessionId: params.remoteSessionId ?? 'pi-session-one',
    linkData: { sessionFile },
  };
}

function fileState(
  overrides: Partial<PiExternalSessionFileState> = {},
): PiExternalSessionFileState {
  return {
    dev: 1,
    ino: 2,
    birthtimeMs: 3,
    mtimeMs: 9_500,
    ...overrides,
  };
}

describe('Pi External Session observation', () => {
  it('groups one natural file resource without reading or granting file authority', async () => {
    const readFileState = vi.fn(async () => fileState());
    const contribution = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
      readFileState,
    });
    const first = contribution.describeResource(linkedSource());
    const repeated = contribution.describeResource(linkedSource());
    const otherGeneration = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
    }).describeResource(linkedSource());
    const largeGenerationA = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
    }).describeResource(linkedSource());
    const largeGenerationB = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
    }).describeResource(linkedSource());

    expect(first).toEqual(repeated);
    expect(Object.keys(first).sort()).toEqual(['linkKey', 'resourceKey']);
    expect(otherGeneration.resourceKey).toBe(first.resourceKey);
    expect(otherGeneration.linkKey).toBe(first.linkKey);
    expect(largeGenerationA.resourceKey).toBe(largeGenerationB.resourceKey);
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify([first, repeated, otherGeneration])).not.toContain('/tmp/');
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: first.linkKey, linkedSource: linkedSource() }],
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...first,
          changeObservation: 'reconcile_only',
        },
      }],
    });
    expect(readFileState).toHaveBeenCalledOnce();
  });

  it('opens no watcher, listener, timer, or transcript refresh path', async () => {
    const contribution = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);
    const emit = vi.fn();
    const requestReconcile = vi.fn();
    const requestTranscriptRefresh = vi.fn();
    const controller = new AbortController();

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: controller.signal,
      emit,
      requestReconcile,
      requestTranscriptRefresh,
    });

    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
    expect(requestTranscriptRefresh).not.toHaveBeenCalled();
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
    controller.abort('generation retired');
    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
    expect(requestTranscriptRefresh).not.toHaveBeenCalled();
  });

  it('reconciles file freshness only as recent activity and keeps all semantic axes unsupported', async () => {
    const readFileState = vi.fn(async () => fileState());
    const contribution = createPiExternalSessionObservationContribution({
      env: {
        PI_CODING_AGENT_DIR: '/tmp/pi-agent',
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 10_000,
      readFileState,
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);

    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'recent_activity',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
            expiresAtMs: 11_000,
          },
          {
            kind: 'unsupported',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
          },
          {
            kind: 'unsupported',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
          },
        ],
      }],
    });
    expect(readFileState).toHaveBeenCalledOnce();
  });

  it('does not turn stale mtime or missing transient RPC lifecycle events into idle or finality', async () => {
    const staleState = fileState({ mtimeMs: 1_000 });
    const contribution = createPiExternalSessionObservationContribution({
      env: {
        PI_CODING_AGENT_DIR: '/tmp/pi-agent',
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 10_000,
      readFileState: async () => staleState,
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);
    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
    });

    expect(result.outcomes[0]?.facts).toEqual([
      {
        kind: 'successful_empty',
        emptyTurnPhase: 'unsupported',
        evidenceClass: 'reconciliation',
        observedAtMs: 10_000,
        expiresAtMs: 11_000,
      },
      {
        kind: 'unsupported',
        axis: 'liveness',
        evidenceClass: 'reconciliation',
        observedAtMs: 10_000,
      },
      {
        kind: 'unsupported',
        axis: 'boundary',
        evidenceClass: 'reconciliation',
        observedAtMs: 10_000,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('working');
    expect(JSON.stringify(result)).not.toContain('idle');
    expect(JSON.stringify(result)).not.toContain('completed_boundary');
    expect(JSON.stringify(result)).not.toContain('agent_settled');
  });

  it('reports unknown file time as a turn-phase retrieval failure and bounds fact time', async () => {
    const unknownTimeState = fileState({ mtimeMs: Number.NaN });
    const contribution = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
      now: () => Number.MAX_SAFE_INTEGER,
      readFileState: async () => unknownTimeState,
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);

    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'retrieval_failed',
            axis: 'turn_phase',
            evidenceClass: 'reconciliation',
            observedAtMs: Number.MAX_SAFE_INTEGER,
          },
          {
            kind: 'unsupported',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: Number.MAX_SAFE_INTEGER,
          },
          {
            kind: 'unsupported',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: Number.MAX_SAFE_INTEGER,
          },
        ],
      }],
    });
  });

  it('reconciles current file evidence after a same-path physical replacement', async () => {
    const contribution = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
      now: () => 10_000,
      readFileState: async () => fileState({ ino: 99 }),
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
    });

    expect(result.outcomes[0]?.facts).toEqual([
      expect.objectContaining({ kind: 'recent_activity' }),
      expect.objectContaining({ kind: 'unsupported', axis: 'liveness' }),
      expect.objectContaining({ kind: 'unsupported', axis: 'boundary' }),
    ]);
  });

  it('re-describes the current resource without changing its canonical identity', async () => {
    const state = fileState();
    const contribution = createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
      readFileState: async () => state,
    });
    const linked = linkedSource();
    const descriptor = contribution.describeResource(linked);

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...descriptor,
          changeObservation: 'reconcile_only',
        },
      }],
    });
  });
});
