import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsBoundary = vi.hoisted(() => ({
  open: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => fsBoundary.open(...args),
    readdir: (...args: Parameters<typeof actual.readdir>) => (
      fsBoundary.readdir(...args)
    ),
  };
});

import { createCodexExternalSessionObservationContribution } from './observation.js';

type CodexObservationContribution = ReturnType<
  typeof createCodexExternalSessionObservationContribution
>;

function linkedSource(params: Readonly<{
  codexHome: string;
  remoteSessionId?: string;
}>): AgentExternalSessionsResolvedIdentity {
  const source = {
    kind: 'codexHome',
    home: 'user',
    homePath: params.codexHome,
  } as const;
  return {
    source,
    remoteSessionId: params.remoteSessionId ?? 'session-a',
    linkData: { source },
  };
}

async function reconcileDescriptor(
  contribution: CodexObservationContribution,
  identity: AgentExternalSessionsResolvedIdentity,
) {
  const grouping = contribution.describeResource(identity);
  const result = await contribution.reconcileResource({
    purpose: 'resource_descriptors',
    resourceKey: grouping.resourceKey,
    links: [{ linkKey: grouping.linkKey, linkedSource: identity }],
    signal: new AbortController().signal,
  });
  const outcome = result.outcomes[0];
  if (!outcome || outcome.kind !== 'described') {
    throw new Error('Expected an authoritative Codex resource descriptor');
  }
  return outcome.descriptor;
}

async function createRolloutSetFixture(): Promise<Readonly<{
  codexHome: string;
  identity: AgentExternalSessionsResolvedIdentity;
  rootFile: string;
  sidechainFile: string;
}>> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-'));
  const sessionsDir = join(codexHome, 'sessions', 'rollout-set');
  const rootFile = join(sessionsDir, 'rollout-root.jsonl');
  const sidechainFile = join(sessionsDir, 'rollout-sidechain.jsonl');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(rootFile, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<turn_aborted>' }],
      },
    }),
  ].join('\n'), 'utf8');
  await writeFile(sidechainFile, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-child', session_id: 'session-a' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'collab_waiting_end',
        agent_statuses: [{
          thread_id: 'thread-child',
          status: { completed: 'done' },
        }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<subagent_notification>{"agent_id":"thread-child","status":{"interrupted":"cancelled"}}</subagent_notification>',
        }],
      },
    }),
  ].join('\n'), 'utf8');
  return {
    codexHome,
    identity: linkedSource({ codexHome }),
    rootFile,
    sidechainFile,
  };
}

describe('Codex External Session observation', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    fsBoundary.open.mockReset();
    fsBoundary.open.mockImplementation(actual.open);
    fsBoundary.readdir.mockReset();
    fsBoundary.readdir.mockImplementation(actual.readdir);
  });

  it('groups rollout links with bounded opaque keys and obtains authority only from descriptor reconciliation', async () => {
    const fixture = await createRolloutSetFixture();
    const otherHomeFixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: fixture.codexHome },
    });
    const first = contribution.describeResource(fixture.identity);
    const duplicate = contribution.describeResource(fixture.identity);
    await writeFile(
      join(dirname(fixture.rootFile), 'rollout-session-b.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-b' } }),
      'utf8',
    );
    const otherIdentity = linkedSource({
      codexHome: fixture.codexHome,
      remoteSessionId: 'session-b',
    });
    const otherSession = contribution.describeResource(otherIdentity);
    const otherHomeContribution =
      createCodexExternalSessionObservationContribution({
        env: { CODEX_HOME: otherHomeFixture.codexHome },
      });
    const otherHome = otherHomeContribution.describeResource(
      otherHomeFixture.identity,
    );

    expect(duplicate).toEqual(first);
    expect(otherSession.resourceKey).toBe(first.resourceKey);
    expect(otherSession.linkKey).not.toBe(first.linkKey);
    expect(otherHome.resourceKey).not.toBe(first.resourceKey);
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(Object.keys(first).sort()).toEqual(['linkKey', 'resourceKey']);
    const descriptor = await reconcileDescriptor(
      contribution,
      fixture.identity,
    );
    expect(descriptor.changeObservation).toBe('watch_file_changes');
    expect(descriptor.watchFileChanges?.files).toEqual(
      [fixture.rootFile, fixture.sidechainFile].sort(),
    );
    expect(descriptor.watchFileChanges?.topologyDirectories).toEqual(
      [
        join(fixture.codexHome, 'sessions'),
        join(fixture.codexHome, 'archived_sessions'),
      ].sort(),
    );
    expect(JSON.stringify([
      first.resourceKey,
      first.linkKey,
      otherSession.resourceKey,
      otherSession.linkKey,
    ])).not.toContain(fixture.codexHome);
    expect(JSON.stringify([
      first.resourceKey,
      first.linkKey,
      otherSession.resourceKey,
      otherSession.linkKey,
    ])).not.toContain('session-a');
    expect(JSON.stringify([
      first.resourceKey,
      first.linkKey,
      otherSession.resourceKey,
      otherSession.linkKey,
    ])).not.toContain('session-b');
  });

  it('re-describes a delayed child after it materializes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-delayed-child-'));
    const sessionsDir = join(codexHome, 'sessions', 'delayed-child');
    const rootFile = join(sessionsDir, 'rollout-root.jsonl');
    const childFile = join(sessionsDir, 'rollout-child-thread.jsonl');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      rootFile,
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }),
      'utf8',
    );
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });
    const identity = linkedSource({ codexHome });
    const staged = contribution.describeResource(identity);
    const stagedDescriptor = await reconcileDescriptor(contribution, identity);
    expect(stagedDescriptor.watchFileChanges?.files).toEqual([rootFile]);

    await writeFile(
      childFile,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-child', session_id: 'session-a' },
      }),
      'utf8',
    );

    const descriptor = await reconcileDescriptor(contribution, identity);
    expect(descriptor.changeObservation).toBe('watch_file_changes');
    if (descriptor.changeObservation !== 'watch_file_changes') {
      throw new Error('Expected a file-watch descriptor');
    }
    expect(descriptor.watchFileChanges.files).toContain(childFile);
  });

  it('re-describes requested roots from one inventory with official children and unavailable links', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-descriptors-'));
    const sessionsDir = join(codexHome, 'sessions', 'descriptor-batch');
    const archivedDir = join(
      codexHome,
      'archived_sessions',
      'descriptor-batch',
    );
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    const rootA = join(sessionsDir, 'rollout-root-a.jsonl');
    const rootB = join(archivedDir, 'rollout-root-b.jsonl');
    await writeFile(
      rootA,
      JSON.stringify({ type: 'session_meta', payload: { id: 'root-a' } }),
      'utf8',
    );
    await writeFile(
      rootB,
      JSON.stringify({ type: 'session_meta', payload: { id: 'root-b' } }),
      'utf8',
    );
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });
    const identityA = linkedSource({ codexHome, remoteSessionId: 'root-a' });
    const identityB = linkedSource({ codexHome, remoteSessionId: 'root-b' });
    const beforeA = contribution.describeResource(identityA);
    const beforeB = contribution.describeResource(identityB);
    const childA = join(sessionsDir, 'rollout-child-a.jsonl');
    await writeFile(
      childA,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'child-a', session_id: 'root-a' },
      }),
      'utf8',
    );
    await writeFile(
      join(sessionsDir, 'rollout-unrelated-child.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'unrelated-child',
          session_id: 'unrelated-root',
        },
      }),
      'utf8',
    );

    fsBoundary.open.mockClear();
    fsBoundary.readdir.mockClear();
    const result = await contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: beforeA.resourceKey,
      links: [
        { linkKey: beforeB.linkKey, linkedSource: identityB },
        {
          linkKey: 'codex-rollout-set-link-v1:missing',
          linkedSource: linkedSource({
            codexHome,
            remoteSessionId: 'missing-root',
          }),
        },
        { linkKey: beforeA.linkKey, linkedSource: identityA },
      ],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      purpose: 'resource_descriptors',
      outcomes: [
        {
          kind: 'described',
          descriptor: expect.objectContaining({
            linkKey: beforeB.linkKey,
            watchFileChanges: expect.objectContaining({
              files: [rootB],
            }),
          }),
        },
        {
          kind: 'unavailable',
          linkKey: 'codex-rollout-set-link-v1:missing',
        },
        {
          kind: 'described',
          descriptor: expect.objectContaining({
            linkKey: beforeA.linkKey,
            watchFileChanges: expect.objectContaining({
              files: [childA, rootA].sort(),
            }),
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('unrelated-child');
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'sessions'),
      ),
    ).toHaveLength(1);
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'archived_sessions'),
      ),
    ).toHaveLength(1);
    expect(fsBoundary.open).toHaveBeenCalledTimes(4);
  });

  it('keeps the pooled resource key when a rollout file is replaced at the same path', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: fixture.codexHome },
    });
    const before = contribution.describeResource(fixture.identity);
    const replacement = `${fixture.rootFile}.replacement`;
    await writeFile(
      replacement,
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }),
      'utf8',
    );
    await rm(fixture.rootFile);
    await rename(replacement, fixture.rootFile);

    const after = contribution.describeResource(fixture.identity);

    expect(after.resourceKey).toBe(before.resourceKey);
    expect(after.linkKey).toBe(before.linkKey);
  });

  it('keeps authority-free grouping stable when a topology root is replaced at the same path', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: fixture.codexHome },
    });
    const before = contribution.describeResource(fixture.identity);
    const replacementRoot = join(fixture.codexHome, 'sessions-replacement');
    const replacementSet = join(replacementRoot, 'rollout-set');
    await mkdir(replacementSet, { recursive: true });
    await writeFile(
      join(replacementSet, 'rollout-root.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }),
      'utf8',
    );
    await rm(join(fixture.codexHome, 'sessions'), {
      recursive: true,
      force: true,
    });
    await rename(replacementRoot, join(fixture.codexHome, 'sessions'));

    const after = contribution.describeResource(fixture.identity);

    expect(after).toEqual(before);
  });

  it('keeps the pooled resource key when the complete sidechain file set changes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-'));
    const remoteSessionId = '019c5b0c-b765-72e0-b799-6eca4714a46b';
    const rootDir = join(codexHome, 'sessions', '2026', '02', '14');
    const sidechainDir = join(
      codexHome,
      'archived_sessions',
      'sidechains',
    );
    await mkdir(rootDir, { recursive: true });
    await mkdir(sidechainDir, { recursive: true });
    await writeFile(
      join(
        rootDir,
        `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`,
      ),
      JSON.stringify({
        type: 'session_meta',
        payload: { id: remoteSessionId },
      }),
      'utf8',
    );
    const identity = linkedSource({ codexHome, remoteSessionId });
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });
    const beforeGrouping = contribution.describeResource(identity);
    const before = await reconcileDescriptor(contribution, identity);
    const addedSidechain = join(
      sidechainDir,
      'rollout-added-sidechain.jsonl',
    );
    await writeFile(
      addedSidechain,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: remoteSessionId },
      }),
      'utf8',
    );

    const afterAdd = await reconcileDescriptor(contribution, identity);
    await rm(addedSidechain);
    const afterRemove = await reconcileDescriptor(contribution, identity);

    expect(contribution.describeResource(identity)).toEqual(beforeGrouping);
    expect(afterAdd.resourceKey).toBe(before.resourceKey);
    expect(afterAdd.linkKey).toBe(before.linkKey);
    expect(afterAdd.watchFileChanges.files).toContain(addedSidechain);
    expect(afterRemove).toEqual(before);
  });

  it('fails closed instead of watching a partial rollout set above the protocol bound', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-'));
    const sessionsDir = join(codexHome, 'sessions', 'bounded-set');
    await mkdir(sessionsDir, { recursive: true });
    await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      await writeFile(
        join(sessionsDir, `rollout-${index}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-over-bound' },
        }),
        'utf8',
      );
    }));
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });

    const identity = linkedSource({
      codexHome,
      remoteSessionId: 'session-over-bound',
    });
    const grouping = contribution.describeResource(identity);
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: grouping.resourceKey,
      links: [{ linkKey: grouping.linkKey, linkedSource: identity }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'unavailable',
        linkKey: grouping.linkKey,
      }],
    });
  });

  it('returns unavailable when topology growth exceeds 32 exact files', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-over-bound-'));
    const sessionsDir = join(codexHome, 'sessions', 'bounded-set');
    await mkdir(sessionsDir, { recursive: true });
    const firstFile = join(sessionsDir, 'rollout-initial.jsonl');
    await writeFile(
      firstFile,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-over-bound' },
      }),
      'utf8',
    );
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });
    const identity = linkedSource({
      codexHome,
      remoteSessionId: 'session-over-bound',
    });
    const descriptor = contribution.describeResource(identity);
    await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      await writeFile(
        join(sessionsDir, `rollout-added-${index}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-over-bound' },
        }),
        'utf8',
      );
    }));

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links: [{ linkKey: descriptor.linkKey, linkedSource: identity }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'unavailable',
        linkKey: descriptor.linkKey,
      }],
    });
    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{ linkKey: descriptor.linkKey, linkedSource: identity }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          expect.objectContaining({
            kind: 'retrieval_failed',
            axis: 'liveness',
          }),
          expect.objectContaining({
            kind: 'retrieval_failed',
            axis: 'turn_phase',
          }),
          expect.objectContaining({
            kind: 'retrieval_failed',
            axis: 'boundary',
          }),
        ],
      }],
    });
  });

  it('opens no watcher or timer when activation cannot reach the canonical host file follower', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: fixture.codexHome },
    });
    const descriptor = contribution.describeResource(fixture.identity);
    const emit = vi.fn();
    const requestReconcile = vi.fn();

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      emit,
      requestReconcile,
      requestTranscriptRefresh() {},
    });

    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
    expect(disposable).toEqual({ dispose: expect.any(Function) });
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('reuses the qualified connected-service home boundary', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'codex-observation-connected-'),
    );
    const codexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'service-a',
      'profile-a',
      'codex',
      'codex-home',
    );
    const sessionsDir = join(codexHome, 'sessions');
    const rolloutFile = join(sessionsDir, 'rollout-connected.jsonl');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      rolloutFile,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-connected' },
      }),
      'utf8',
    );
    await utimes(rolloutFile, new Date(99_500), new Date(99_500));
    const source = {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'service-a',
      connectedServiceProfileId: 'profile-a',
      homePath: codexHome,
    } as const;
    const identity: AgentExternalSessionsResolvedIdentity = {
      source,
      remoteSessionId: 'session-connected',
      linkData: { source },
    };
    const contribution = createCodexExternalSessionObservationContribution({
      env: {
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 100_000,
    });
    const grouping = contribution.describeResource(identity);
    const descriptor = await reconcileDescriptor(contribution, identity);

    expect(grouping).toEqual({
      resourceKey: descriptor.resourceKey,
      linkKey: descriptor.linkKey,
    });
    expect(descriptor.watchFileChanges?.topologyDirectories).toEqual(
      [
        join(codexHome, 'sessions'),
        join(codexHome, 'archived_sessions'),
      ].sort(),
    );
    expect(JSON.stringify([
      descriptor.resourceKey,
      descriptor.linkKey,
    ])).not.toContain(codexHome);
    expect(JSON.stringify([
      descriptor.resourceKey,
      descriptor.linkKey,
    ])).not.toContain('HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS');

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{ linkKey: descriptor.linkKey, linkedSource: identity }],
      signal: new AbortController().signal,
    });

    expect(result.outcomes).toEqual([{
      linkKey: descriptor.linkKey,
      facts: expect.arrayContaining([
        expect.objectContaining({ kind: 'recent_activity' }),
        expect.objectContaining({ kind: 'unsupported', axis: 'liveness' }),
        expect.objectContaining({ kind: 'unsupported', axis: 'boundary' }),
      ]),
    }]);
    expect(JSON.stringify(result)).not.toContain(activeServerDir);
    expect(JSON.stringify(result)).not.toContain('session-connected');
  });

  it('reconciles the complete rollout set as content-free recent activity only', async () => {
    const fixture = await createRolloutSetFixture();
    await utimes(fixture.rootFile, new Date(90_000), new Date(90_000));
    await utimes(fixture.sidechainFile, new Date(99_500), new Date(99_500));
    const contribution = createCodexExternalSessionObservationContribution({
      env: {
        CODEX_HOME: fixture.codexHome,
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 100_000,
    });
    const descriptor = contribution.describeResource(fixture.identity);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'recent_activity',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
            expiresAtMs: 115_000,
          },
          {
            kind: 'unsupported',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
          {
            kind: 'unsupported',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
        ],
      }],
    });
    expect(JSON.stringify(result)).not.toContain(fixture.codexHome);
    expect(JSON.stringify(result)).not.toContain('session-a');
    expect(JSON.stringify(result)).not.toMatch(
      /completed_boundary|turn_phase|working|waiting|retrying|idle|stopped|interrupted/u,
    );
  });

  it('inventories one large Codex home once for a batch of evidence links', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-batch-'));
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '25');
    const archivedDir = join(
      codexHome,
      'archived_sessions',
      '2026',
      '07',
      '24',
    );
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const requestedIds = Array.from(
      { length: 24 },
      (_, index) => `requested-${String(index).padStart(2, '0')}`,
    );
    await Promise.all([
      ...requestedIds.map(async (remoteSessionId, index) => {
        const targetDir = index % 2 === 0 ? sessionsDir : archivedDir;
        await writeFile(
          join(targetDir, `rollout-requested-${index}.jsonl`),
          JSON.stringify({
            type: 'session_meta',
            payload: { id: remoteSessionId },
          }),
          'utf8',
        );
      }),
      ...Array.from({ length: 120 }, async (_, index) => {
        await writeFile(
          join(sessionsDir, `rollout-unrelated-${index}.jsonl`),
          JSON.stringify({
            type: 'session_meta',
            payload: { id: `unrelated-${index}` },
          }),
          'utf8',
        );
      }),
    ]);

    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
      now: () => 100_000,
    });
    const links = requestedIds.map((remoteSessionId) => {
      const identity = linkedSource({ codexHome, remoteSessionId });
      const descriptor = contribution.describeResource(identity);
      return {
        linkKey: descriptor.linkKey,
        linkedSource: identity,
      };
    });
    const resourceKey = contribution.describeResource(
      links[0]!.linkedSource,
    ).resourceKey;

    fsBoundary.open.mockClear();
    fsBoundary.readdir.mockClear();
    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey,
      links,
      signal: new AbortController().signal,
    });

    expect(result.outcomes.map((outcome) => outcome.linkKey)).toEqual(
      links.map((link) => link.linkKey),
    );
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'sessions'),
      ),
    ).toHaveLength(1);
    expect(
      fsBoundary.readdir.mock.calls.filter(
        ([path]) => String(path) === join(codexHome, 'archived_sessions'),
      ),
    ).toHaveLength(1);
    expect(fsBoundary.open).toHaveBeenCalledTimes(144);
  });

  it('keeps stale rollout sets unknown and fails closed when no complete watch set exists', async () => {
    const fixture = await createRolloutSetFixture();
    await utimes(fixture.rootFile, new Date(1_000), new Date(1_000));
    await utimes(fixture.sidechainFile, new Date(1_000), new Date(1_000));
    const contribution = createCodexExternalSessionObservationContribution({
      env: {
        CODEX_HOME: fixture.codexHome,
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 100_000,
    });
    const descriptor = contribution.describeResource(fixture.identity);

    const stale = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{ linkKey: descriptor.linkKey, linkedSource: fixture.identity }],
      signal: new AbortController().signal,
    });
    expect(stale).toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'successful_empty',
            emptyTurnPhase: 'unsupported',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
            expiresAtMs: 115_000,
          },
          {
            kind: 'unsupported',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
          {
            kind: 'unsupported',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
        ],
      }],
    });
    expect(JSON.stringify(stale)).not.toMatch(/completed_boundary|working|stopped/u);

    const missingIdentity = linkedSource({
      codexHome: fixture.codexHome,
      remoteSessionId: 'missing-session',
    });
    const missingGrouping = contribution.describeResource(missingIdentity);
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: missingGrouping.resourceKey,
      links: [{
        linkKey: missingGrouping.linkKey,
        linkedSource: missingIdentity,
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'unavailable',
        linkKey: missingGrouping.linkKey,
      }],
    });
  });
});
