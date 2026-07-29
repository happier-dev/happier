import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  createOhMyPiExternalSessionObservationContribution,
  type OhMyPiObservationFileState,
} from './observation.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

function linkedSource(params: Readonly<{
  remoteSessionId: string;
  sessionFilePath?: string;
  agentDir?: string;
}>): AgentExternalSessionsResolvedIdentity {
  const sessionFilePath = params.sessionFilePath ?? '/tmp/omp/session.jsonl';
  const agentDir = params.agentDir ?? '/tmp/omp';
  return {
    source: {
      kind: 'ohMyPiAgentDir',
      agentDir,
      sessionFilePath,
    },
    remoteSessionId: params.remoteSessionId,
    linkData: { sessionFilePath },
  };
}

function fileState(overrides: Partial<OhMyPiObservationFileState> = {}): OhMyPiObservationFileState {
  return {
    dev: 1,
    ino: 2,
    birthtimeMs: 3,
    mtimeMs: 9_500,
    ...overrides,
  };
}

describe('Oh My Pi External Session observation', () => {
  it('groups one natural file resource without reading or granting file authority', async () => {
    const readFileState = vi.fn(async () => fileState());
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
      readFileState,
    });

    const first = contribution.describeResource(linkedSource({ remoteSessionId: 'session-one' }));
    const sameNativeSession = contribution.describeResource(
      linkedSource({ remoteSessionId: 'session-one' }),
    );
    const sameResourceOtherSession = contribution.describeResource(
      linkedSource({ remoteSessionId: 'session-two' }),
    );
    const otherPhysicalGeneration =
      createOhMyPiExternalSessionObservationContribution({
        env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
      }).describeResource(linkedSource({ remoteSessionId: 'session-one' }));

    expect(first).toEqual(sameNativeSession);
    expect(Object.keys(first).sort()).toEqual(['linkKey', 'resourceKey']);
    expect(first.resourceKey).toBe(sameResourceOtherSession.resourceKey);
    expect(first.linkKey).not.toBe(sameResourceOtherSession.linkKey);
    expect(otherPhysicalGeneration.resourceKey).toBe(first.resourceKey);
    expect(otherPhysicalGeneration.linkKey).toBe(first.linkKey);
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify([
      first,
      sameResourceOtherSession,
      otherPhysicalGeneration,
    ])).not.toContain('/tmp/');
    expect(readFileState).not.toHaveBeenCalled();
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: first.resourceKey,
      links: [{
        linkKey: first.linkKey,
        linkedSource: linkedSource({ remoteSessionId: 'session-one' }),
      }],
      signal: new AbortController().signal,
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

  it('opens no watcher or timer when activation cannot reach the canonical host file follower', async () => {
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
    });
    const emit = vi.fn();
    const requestReconcile = vi.fn();
    const controller = new AbortController();

    const disposable = await contribution.observeResource({
      resourceKey: contribution.describeResource(
        linkedSource({ remoteSessionId: 'session-one' }),
      ).resourceKey,
      signal: controller.signal,
      emit,
      requestReconcile,
      requestTranscriptRefresh() {},
    });

    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
    expect(disposable).toEqual({ dispose: expect.any(Function) });
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
    controller.abort('generation retired');
    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
  });

  it('reconciles one pooled physical resource into content-free recent activity only', async () => {
    const readFileState = vi.fn(async () => fileState());
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: {
        PI_CODING_AGENT_DIR: '/tmp/omp',
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 10_000,
      readFileState,
    });
    const firstSource = linkedSource({ remoteSessionId: 'session-one' });
    const secondSource = linkedSource({ remoteSessionId: 'session-two' });
    const resource = contribution.describeResource(firstSource);
    const second = contribution.describeResource(secondSource);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: resource.resourceKey,
      signal: new AbortController().signal,
      links: [
        { linkKey: resource.linkKey, linkedSource: firstSource },
        { linkKey: second.linkKey, linkedSource: secondSource },
      ],
    });

    expect(readFileState).toHaveBeenCalledOnce();
    expect(result.purpose).toBe('observation_evidence');
    expect(result.outcomes).toHaveLength(2);
    for (const outcome of result.outcomes) {
      expect(outcome.facts).toEqual([
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
      ]);
      expect(outcome).not.toHaveProperty('target');
      expect(outcome).not.toHaveProperty('qualifiedLinkIdentity');
    }
    expect(JSON.stringify(result)).not.toContain('session-one');
    expect(JSON.stringify(result)).not.toContain('/tmp/');
    expect(JSON.stringify(result)).not.toContain('agent_end');
    expect(JSON.stringify(result)).not.toContain('agent_settled');
    expect(JSON.stringify(result)).not.toContain('working');
  });

  it('keeps stale mtime and source failure distinct without guessing busy or finality', async () => {
    const currentState = fileState({ mtimeMs: 1_000 });
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: {
        PI_CODING_AGENT_DIR: '/tmp/omp',
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 10_000,
      readFileState: async () => currentState,
    });
    const source = linkedSource({ remoteSessionId: 'session-one' });
    const descriptor = contribution.describeResource(source);

    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: source }],
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
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
        ],
      }],
    });

    const failed = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
      now: () => 10_000,
      readFileState: async () => {
        throw new Error('unavailable');
      },
    });
    await expect(failed.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: source }],
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'retrieval_failed',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
          },
          {
            kind: 'retrieval_failed',
            axis: 'turn_phase',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
          },
          {
            kind: 'retrieval_failed',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: 10_000,
          },
        ],
      }],
    });

    const replaced = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
      now: () => 10_000,
      readFileState: async () => fileState({ ino: 777, mtimeMs: 10_000 }),
    });
    await expect(replaced.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: source }],
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          expect.objectContaining({ kind: 'recent_activity' }),
          expect.objectContaining({ kind: 'unsupported', axis: 'liveness' }),
          expect.objectContaining({ kind: 'unsupported', axis: 'boundary' }),
        ],
      }],
    });
  });

  it('does not reinterpret retrying agent_end or invented agent_settled records as final or busy', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-observation-'));
    tempDirs.add(agentDir);
    const sessionFilePath = join(agentDir, 'session.jsonl');
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'agent_end', willRetry: true }),
      JSON.stringify({ type: 'agent_settled' }),
      '',
    ].join('\n'), 'utf8');
    const source = linkedSource({
      remoteSessionId: 'session-retrying',
      sessionFilePath,
      agentDir,
    });
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
      now: () => Date.now(),
    });
    const descriptor = contribution.describeResource(source);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      links: [{ linkKey: descriptor.linkKey, linkedSource: source }],
    });

    expect(result.outcomes[0]?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recent_activity' }),
      expect.objectContaining({ kind: 'unsupported', axis: 'liveness' }),
      expect.objectContaining({ kind: 'unsupported', axis: 'boundary' }),
    ]));
    expect(result.outcomes[0]?.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'completed_boundary' }),
    ]));
    expect(result.outcomes[0]?.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn_phase', value: 'working' }),
    ]));
  });

  it('returns ordered unavailable descriptor outcomes without inventing file identity', async () => {
    const currentState = fileState();
    const readFileState = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/tmp/omp' },
      readFileState,
    });
    const firstSource = linkedSource({ remoteSessionId: 'session-one' });
    const secondSource = linkedSource({ remoteSessionId: 'session-two' });
    const first = contribution.describeResource(firstSource);
    const second = contribution.describeResource(secondSource);

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      links: [
        { linkKey: second.linkKey, linkedSource: secondSource },
        { linkKey: first.linkKey, linkedSource: firstSource },
      ],
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [
        { kind: 'unavailable', linkKey: second.linkKey },
        { kind: 'unavailable', linkKey: first.linkKey },
      ],
    });
    expect(readFileState).toHaveBeenCalledOnce();

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      links: [{
        linkKey: first.linkKey,
        linkedSource: {
          ...firstSource,
          linkData: { sessionFilePath: '/tmp/omp/other.jsonl' },
        },
      }],
    })).rejects.toThrow(/requires one resolved sessionFilePath/u);
  });
});
