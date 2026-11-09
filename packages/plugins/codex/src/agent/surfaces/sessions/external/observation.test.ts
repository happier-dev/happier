import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsBoundary = vi.hoisted(() => ({
  open: vi.fn(),
  readdir: vi.fn(),
    stat: vi.fn(),
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
    stat: (...args: Parameters<typeof actual.stat>) => fsBoundary.stat(...args),
  };
});

import { createCodexExternalSessionObservationContribution, codexExternalSessionObservationContribution } from './observation.js';
import { pageCodexExternalSessionTranscript, readAfterCodexExternalSessionTranscript } from './transcriptSource.js';
import { createCodexExternalSessionsContribution } from './contribution.js';
import { codexRolloutObservationInventories, inventoryCodexRootSessionRolloutFiles } from '../../../rollout/discovery/sessionsForHome.js';

type CodexObservationContribution = ReturnType<
  typeof createCodexExternalSessionObservationContribution
>;
const observationLifetimes = new WeakMap<CodexObservationContribution, AbortController>();

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
  let lifetime = observationLifetimes.get(contribution);
  if (!lifetime) { lifetime = new AbortController(); observationLifetimes.set(contribution, lifetime); }
  const result = await contribution.reconcileResource({
    purpose: 'resource_descriptors',
    resourceKey: grouping.resourceKey,
    links: [{ linkKey: grouping.linkKey, linkedSource: identity }],
    signal: new AbortController().signal,
    observation: { lifetime: lifetime.signal },
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
    fsBoundary.stat.mockReset();
    fsBoundary.stat.mockImplementation(actual.stat);
  });

  it('keeps the observed native session id byte-exact, bounds the raw value, and rejects blank', () => {
    // Codex mints these ids; `  x  ` and `x` are different provider sessions,
    // so the opaque link key must not collapse them together.
    const exactRemoteSessionId = '  provider\nses/AB+cd==  ';
    const codexHome = '/tmp/happier-codex-observation-exact-home';
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });

    const exact = contribution.describeResource(
      linkedSource({ codexHome, remoteSessionId: exactRemoteSessionId }),
    );
    const trimmed = contribution.describeResource(
      linkedSource({ codexHome, remoteSessionId: exactRemoteSessionId.trim() }),
    );

    expect(exact.linkKey).not.toBe(trimmed.linkKey);

    // The 2000-char ceiling is a raw-value bound: padding must not buy headroom.
    const overLongRawValue = `${' '.repeat(64)}${'a'.repeat(2_000)}${' '.repeat(64)}`;
    expect(() => contribution.describeResource(
      linkedSource({ codexHome, remoteSessionId: overLongRawValue }),
    )).toThrow(/bounded native session id/);

    expect(() => contribution.describeResource(
      linkedSource({ codexHome, remoteSessionId: ' \n\t ' }),
    )).toThrow(/bounded native session id/);
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
    await reconcileDescriptor(contribution, fixture.identity);
    const replacement = `${fixture.rootFile}.replacement`;
    await writeFile(
      replacement,
      JSON.stringify({ type: 'session_meta', payload: { id: 'another-session' } }),
      'utf8',
    );
    await rm(fixture.rootFile);
    await rename(replacement, fixture.rootFile);

    const after = contribution.describeResource(fixture.identity);

    expect(after.resourceKey).toBe(before.resourceKey);
    expect(after.linkKey).toBe(before.linkKey);
    expect((await reconcileDescriptor(contribution, fixture.identity)).watchFileChanges.files).toEqual([fixture.sidechainFile]);
  });

  it('keeps authority-free grouping stable when a topology root is replaced at the same path', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: fixture.codexHome },
    });
    const before = contribution.describeResource(fixture.identity);
    await reconcileDescriptor(contribution, fixture.identity);
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
    expect((await reconcileDescriptor(contribution, fixture.identity)).watchFileChanges.files).toEqual([fixture.rootFile]);
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

  it('uses demanded file invalidations without per-file work on unchanged ticks and releases facts on retirement', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({ env: { CODEX_HOME: fixture.codexHome } });
    const lifetime = new AbortController();
    const grouping = contribution.describeResource(fixture.identity);
    const request = { purpose: 'resource_descriptors' as const, resourceKey: grouping.resourceKey,
      links: [{ linkKey: grouping.linkKey, linkedSource: fixture.identity }], signal: new AbortController().signal,
      observation: { lifetime: lifetime.signal, changedFiles: [] as string[] } };
    const initial = await contribution.reconcileResource(request);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    fsBoundary.stat.mockImplementation(async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).endsWith('.jsonl')) throw new Error('unchanged file must not be re-read');
      return actual.stat(...args);
    });
    expect(await contribution.reconcileResource(request)).toEqual(initial);
    fsBoundary.stat.mockImplementation(actual.stat);
    await writeFile(fixture.sidechainFile, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-child', session_id: 'other-root' } }));
    const updated = await contribution.reconcileResource({ ...request,
      observation: { lifetime: lifetime.signal, changedFiles: [fixture.sidechainFile] } });
    expect(updated.outcomes[0]).toMatchObject({ kind: 'described', descriptor: { watchFileChanges: { files: [fixture.rootFile] } } });
    lifetime.abort();
    const replacement = new AbortController();
    fsBoundary.stat.mockImplementation(async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).endsWith('.jsonl')) throw new Error('new demand must reacquire native facts');
      return actual.stat(...args);
    });
    const retired = await contribution.reconcileResource({ ...request,
      observation: { lifetime: replacement.signal, changedFiles: [] } });
    expect(retired.outcomes[0]).toMatchObject({ kind: 'unavailable' });
  });

  it('reuses observed rollout heads in transcript refreshes while revalidating native membership', async () => {
    const fixture = await createRolloutSetFixture();
    const unrelated = join(dirname(fixture.rootFile), 'rollout-unrelated.jsonl');
    await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated-session' } }));
    const lifetime = new AbortController();
    vi.stubEnv('CODEX_HOME', fixture.codexHome);
    const contribution = codexExternalSessionObservationContribution;
    const grouping = contribution.describeResource(fixture.identity);
    const request = { purpose: 'resource_descriptors' as const, resourceKey: grouping.resourceKey,
      links: [{ linkKey: grouping.linkKey, linkedSource: fixture.identity }], signal: new AbortController().signal,
      observation: { lifetime: lifetime.signal, changedFiles: [] } };
    const params = { source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome } as const,
      env: { CODEX_HOME: fixture.codexHome }, remoteSessionId: fixture.identity.remoteSessionId, maxBytes: 256 * 1024, maxItems: 100 };
    try {
      await contribution.reconcileResource(request);
      const tail = await readAfterCodexExternalSessionTranscript({ ...params, cursor: 'tail' });
      expect(tail.nextCursor).toBeTruthy();
      fsBoundary.open.mockClear();
      const refreshed = await readAfterCodexExternalSessionTranscript({ ...params, cursor: tail.nextCursor! });
      expect(refreshed.readAfterOutcome).toBe('already_current');
      expect(fsBoundary.open.mock.calls.filter(([file]) => String(file) === unrelated)).toHaveLength(0);
      // A transcript read has no dirty-file hint: it must re-stat remembered
      // facts, and a same-inode rewrite must still change family membership.
      await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'new-child', session_id: 'session-a' } }));
      const changed = await readAfterCodexExternalSessionTranscript({ ...params, cursor: tail.nextCursor! });
      expect(changed.tailCursor).not.toBe(tail.nextCursor);
      expect(fsBoundary.open.mock.calls.some(([file]) => String(file) === unrelated)).toBe(true);
      lifetime.abort();
      fsBoundary.open.mockClear();
      await readAfterCodexExternalSessionTranscript({ ...params, cursor: 'tail' });
      expect(fsBoundary.open.mock.calls.some(([file]) => String(file) === unrelated)).toBe(true);
    } finally {
      lifetime.abort();
      vi.unstubAllEnvs();
    }
  });

  it('uses observed dirty-file hints for transcript paging without re-statting unrelated rollouts', async () => {
    const fixture = await createRolloutSetFixture();
    const unrelated = join(dirname(fixture.rootFile), 'rollout-unrelated.jsonl');
    await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated-session' } }));
    const lifetime = new AbortController();
    const params = { source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome } as const,
      env: { CODEX_HOME: fixture.codexHome }, remoteSessionId: fixture.identity.remoteSessionId,
      direction: 'older' as const, maxBytes: 256 * 1024, maxItems: 100,
      observation: { lifetime: lifetime.signal, changedFiles: [] as string[] } };
    try {
      await appendFile(fixture.rootFile, '\n' + JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(),
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'owned transcript body' }] } }) + '\n');
      const initial = await pageCodexExternalSessionTranscript(params);
      expect(initial.items.length).toBeGreaterThan(0);
      fsBoundary.stat.mockClear();
      const again = await pageCodexExternalSessionTranscript(params);
      expect(again.items).toEqual(initial.items);
      expect(fsBoundary.stat.mock.calls.filter(([file]) => String(file) === unrelated)).toHaveLength(0);
      await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'new-child', session_id: 'session-a' } }) + '\n');
      const changed = await pageCodexExternalSessionTranscript({ ...params,
        observation: { lifetime: lifetime.signal, changedFiles: [unrelated] } });
      expect(changed.tailCursor).not.toBe(again.tailCursor);
    } finally { lifetime.abort(); await rm(fixture.codexHome, { recursive: true, force: true }); }
  });

  it('invalidates linked rollout facts from the physical dirty path delivered by the watcher', async () => {
    const fixture = await createRolloutSetFixture();
    const alias = join(fixture.codexHome, 'linked-home');
    const lifetime = new AbortController();
    await mkdir(alias);
    await symlink(join(fixture.codexHome, 'sessions'), join(alias, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const unrelated = join(dirname(fixture.rootFile), 'rollout-unrelated.jsonl');
    await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated-session' } }) + '\n');
    const params = { source: { kind: 'codexHome', home: 'user', homePath: alias } as const,
      env: { CODEX_HOME: alias }, remoteSessionId: fixture.identity.remoteSessionId,
      direction: 'older' as const, maxBytes: 256 * 1024, maxItems: 100,
      observation: { lifetime: lifetime.signal, changedFiles: [] as string[] } };
    try {
      const initial = await pageCodexExternalSessionTranscript(params);
      await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: fixture.identity.remoteSessionId } }) + '\n'
        + JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'garnet through physical invalidation' }],
      } }) + '\n');
      const changed = await pageCodexExternalSessionTranscript({ ...params,
        observation: { lifetime: lifetime.signal, changedFiles: [await realpath(unrelated)] } });
      expect(JSON.stringify(changed.items)).toContain('garnet through physical invalidation');
      expect(changed.tailCursor).not.toBe(initial.tailCursor);
    } finally { lifetime.abort(); await rm(fixture.codexHome, { recursive: true, force: true }); }
  });

  it('holds one native descriptor per bounded transcript scan rather than per chunk', async () => {
    const fixture = await createRolloutSetFixture();
    try {
      const timestamp = new Date().toISOString();
      await writeFile(fixture.rootFile,
        JSON.stringify({ type: 'session_meta', timestamp, payload: { id: 'session-a', cwd: '/fixture' } }) + '\n'
        + Array.from({ length: 200 }, (_, ordinal) => JSON.stringify({ type: 'response_item', timestamp, payload: {
          type: 'message', role: ordinal % 2 ? 'assistant' : 'user', content: [{
            type: ordinal % 2 ? 'output_text' : 'input_text', text: `r268ordinal${ordinal} café 東京 ${'coastal walk '.repeat(600)}`,
          }],
        } }) + '\n').join(''));
      fsBoundary.open.mockClear();
      const result = await pageCodexExternalSessionTranscript({ source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome },
        env: { CODEX_HOME: fixture.codexHome }, remoteSessionId: 'session-a', direction: 'older', maxBytes: 512 * 1024, maxItems: 500 });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.hasMore).toBe(true);
      // Membership head, native-history discriminator, tail anchor, one scanner
      // descriptor and continuation anchor; body chunk count adds no handles.
      expect(fsBoundary.open.mock.calls.filter(([file]) => String(file) === fixture.rootFile)).toHaveLength(5);
    } finally { await rm(fixture.codexHome, { recursive: true, force: true }); }
  });

  it('stops native chunk reads at an explicit invocation deadline', async () => {
    const fixture = await createRolloutSetFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let clock = Date.now();
    const deadlineAtMs = clock + 1000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let readsAfterDeadline = 0;
    try {
      const timestamp = new Date(clock).toISOString();
      await writeFile(fixture.rootFile, JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }) + '\n'
        + Array.from({ length: 200 }, () => JSON.stringify({ type: 'response_item', timestamp, payload: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: 'owned native text '.repeat(500) }],
        } }) + '\n').join(''));
      fsBoundary.open.mockImplementation(async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (clock >= deadlineAtMs) readsAfterDeadline++;
          const result = await read(...readArgs);
          if (result.bytesRead >= 64 * 1024) clock = deadlineAtMs;
          return result;
        }) as typeof handle.read;
        return handle;
      });
      await expect(pageCodexExternalSessionTranscript({ source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome },
        env: { CODEX_HOME: fixture.codexHome }, remoteSessionId: 'session-a', direction: 'older', maxBytes: 512 * 1024,
        maxItems: 500, deadlineAtMs })).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(readsAfterDeadline).toBe(0);
    } finally { now.mockRestore(); fsBoundary.open.mockImplementation(actual.open); await rm(fixture.codexHome, { recursive: true, force: true }); }
  });

  it.skipIf(process.env.HAPPIER_R268_PROFILE !== '1')('measures Codex native paging allocations with and without demanded dirty hints', async () => {
    const fixture = await createRolloutSetFixture();
    const lifetime = new AbortController();
    const timestamp = new Date().toISOString();
    const params = { source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome } as const,
      env: { CODEX_HOME: fixture.codexHome }, remoteSessionId: 'session-a', direction: 'older' as const,
      maxBytes: 512 * 1024, maxItems: 500 };
    try {
      await writeFile(fixture.rootFile, JSON.stringify({ type: 'session_meta', timestamp, payload: { id: 'session-a' } }) + '\n'
        + Array.from({ length: 200 }, (_, ordinal) => JSON.stringify({ type: 'response_item', timestamp, payload: {
          type: 'message', role: ordinal % 2 ? 'assistant' : 'user', content: [{ type: ordinal % 2 ? 'output_text' : 'input_text',
            text: `r268ordinal${ordinal} café 東京 ${'coastal walk '.repeat(600)}` }],
        } }) + '\n').join(''));
      await Promise.all(Array.from({ length: 2000 }, (_, index) => writeFile(join(dirname(fixture.rootFile), `rollout-unrelated-${index}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: `unrelated-${index}`,
          base_instructions: { text: 'native instructions not retained '.repeat(800) } } }) + '\n')));
      const baselineMemory = process.memoryUsage();
      const coldStarted = performance.now();
      await pageCodexExternalSessionTranscript({ ...params, observation: { lifetime: lifetime.signal } });
      const cold = { elapsedMs: performance.now() - coldStarted, memory: process.memoryUsage() };
      const measure = async (hinted: boolean) => {
        fsBoundary.stat.mockClear(); fsBoundary.open.mockClear();
        const start = performance.now(), cpuBefore = process.cpuUsage(), memoryBefore = process.memoryUsage();
        for (let index = 0; index < 5; index++) {
          const page = await pageCodexExternalSessionTranscript({ ...params,
            observation: { lifetime: lifetime.signal, ...(hinted ? { changedFiles: [] } : {}) } });
          expect(page.hasMore).toBe(true);
          expect(page.items.length).toBeGreaterThan(0);
        }
        const cpu = process.cpuUsage(cpuBefore);
        return { elapsedMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000,
          stats: fsBoundary.stat.mock.calls.length, opens: fsBoundary.open.mock.calls.length,
          memoryBefore, memoryAfter: process.memoryUsage() };
      };
      const unhinted = await measure(false), hinted = await measure(true);
      lifetime.abort();
      console.info('R268_CODEX_PAGING_PROFILE', JSON.stringify({ files: 2002, ticks: 5, baselineMemory, cold, unhinted, hinted,
        afterRetirement: process.memoryUsage() }));
      expect(hinted.stats).toBeLessThan(unhinted.stats / 100);
    } finally { lifetime.abort(); await rm(fixture.codexHome, { recursive: true, force: true }); }
  }, 120_000);

  it('reconciles an unchanged rollout tree without reopening unrelated heads or relisting directories', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({ env: { CODEX_HOME: fixture.codexHome,
      HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000' }, now: () => 100_100 });
    const unrelated = join(dirname(fixture.rootFile), 'rollout-unrelated.jsonl');
    await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated-session' } }));
    await utimes(fixture.rootFile, new Date(90_000), new Date(90_000));
    await utimes(fixture.sidechainFile, new Date(90_000), new Date(90_000));
    const before = await reconcileDescriptor(contribution, fixture.identity);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // Filesystem boundaries reject redundant inventory I/O, while the real
    // matching, directory invalidation and activity projection remain in use.
    fsBoundary.readdir.mockRejectedValue(new Error('unchanged tree must not be listed again'));
    fsBoundary.open.mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === unrelated) throw new Error('unrelated immutable head must not be reopened');
      return actual.open(...args);
    });
    await utimes(fixture.sidechainFile, new Date(100_000), new Date(100_000));
    expect(await reconcileDescriptor(contribution, fixture.identity)).toEqual(before);
    const grouping = contribution.describeResource(fixture.identity);
    const evidence = await contribution.reconcileResource({ purpose: 'observation_evidence', resourceKey: grouping.resourceKey,
      links: [{ linkKey: grouping.linkKey, linkedSource: fixture.identity }], signal: new AbortController().signal,
      observation: { lifetime: observationLifetimes.get(contribution)!.signal } });
    expect(evidence.outcomes[0]?.facts).toContainEqual(expect.objectContaining({ kind: 'recent_activity' }));
  });

  it('measures repeated observation on a synthetic partitioned rollout tree', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-observation-measure-'));
    try {
      for (let day = 1; day <= 20; day += 1) {
        const dir = join(codexHome, 'sessions', '2026', '10', String(day).padStart(2, '0'));
        await mkdir(dir, { recursive: true });
        await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(
          join(dir, `rollout-2026-10-${String(day).padStart(2, '0')}T10-00-00-${day}-${index}.jsonl`),
          JSON.stringify({ type: 'session_meta', payload: { id: index === 0 ? 'session-a' : `unrelated-${day}-${index}`,
            base_instructions: { text: 'discarded-native-instructions '.repeat(800) + index } } }),
        )));
      }
      const contribution = createCodexExternalSessionObservationContribution({ env: { CODEX_HOME: codexHome },
        inventories: codexRolloutObservationInventories });
      const identity = linkedSource({ codexHome });
      let collect: (() => unknown) | undefined;
      if (process.env.HAPPIER_RUN_OBSERVATION_MEMORY_BENCHMARK === '1') {
        setFlagsFromString('--expose_gc');
        const gc: unknown = runInNewContext('gc');
        if (typeof gc !== 'function') throw new Error('Benchmark GC unavailable');
        collect = gc;
      }
      const sample = async () => {
        fsBoundary.open.mockClear(); fsBoundary.stat.mockClear(); fsBoundary.readdir.mockClear();
        await new Promise<void>(resolve => setImmediate(resolve)); collect?.();
        await new Promise<void>(resolve => setImmediate(resolve)); collect?.();
        return process.memoryUsage().heapUsed;
      };
      const heapBefore = await sample();
      await reconcileDescriptor(contribution, identity);
      const heapDemanded = await sample();
      if (collect) expect(heapDemanded - heapBefore).toBeLessThan(2000 * 800 * 29 / 4);
      const baselineStarted = performance.now();
      const baselineCpuBefore = process.cpuUsage();
      for (let tick = 0; tick < 5; tick += 1) {
        expect((await reconcileDescriptor(contribution, identity)).watchFileChanges.files).toHaveLength(20);
      }
      const baselineCpu = process.cpuUsage(baselineCpuBefore);
      const baseline = { elapsedMs: performance.now() - baselineStarted, cpuMs: (baselineCpu.user + baselineCpu.system) / 1000 };
      const cpuBefore = process.cpuUsage();
      const started = performance.now();
      const readsBefore = fsBoundary.readdir.mock.calls.length;
      const opensBefore = fsBoundary.open.mock.calls.length;
      const grouping = contribution.describeResource(identity);
      const lifetime = observationLifetimes.get(contribution)!.signal;
      for (let tick = 0; tick < 5; tick += 1) {
        const result = await contribution.reconcileResource({ purpose: 'resource_descriptors', resourceKey: grouping.resourceKey,
          links: [{ linkKey: grouping.linkKey, linkedSource: identity }], signal: new AbortController().signal,
          observation: { lifetime, changedFiles: [] } });
        expect(result.outcomes[0]).toMatchObject({ kind: 'described', descriptor: { watchFileChanges: { files: expect.any(Array) } } });
        if (result.purpose === 'resource_descriptors' && result.outcomes[0]?.kind === 'described') expect(result.outcomes[0].descriptor.watchFileChanges?.files).toHaveLength(20);
      }
      const cpu = process.cpuUsage(cpuBefore);
      console.info('CODEX_OBSERVATION_SYNTHETIC', JSON.stringify({ files: 2000, ticks: 5,
        elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
        directoryReads: fsBoundary.readdir.mock.calls.length - readsBefore, headOpens: fsBoundary.open.mock.calls.length - opensBefore, baseline }));
      const heapAfterTicks = await sample();
      const parser = vi.spyOn(Date, 'parse').mockImplementation(() => { throw new Error('surviving rollout names must not be reparsed'); });
      try {
        await writeFile(join(codexHome, 'sessions', '2026', '10', '20', 'rollout-new.jsonl'),
          JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated-new' } }));
        expect((await reconcileDescriptor(contribution, identity)).watchFileChanges.files).toHaveLength(20);
      } finally { parser.mockRestore(); }
      observationLifetimes.get(contribution)!.abort();
      const heapReleased = await sample();
      if (collect) console.info('R242_CODEX_HEAP', JSON.stringify({ heapBefore, heapDemanded, heapAfterTicks, heapReleased }));
      const measureTranscriptRefresh = async () => {
        fsBoundary.open.mockClear();
        const cpuBefore = process.cpuUsage();
        const started = performance.now();
        for (let tick = 0; tick < 5; tick += 1) {
          const page = await readAfterCodexExternalSessionTranscript({ source: { kind: 'codexHome', home: 'user' },
            env: { CODEX_HOME: codexHome }, remoteSessionId: 'session-a', cursor: 'tail', maxBytes: 64 * 1024, maxItems: 100 });
          expect(page.tailCursor).toBeTruthy();
        }
        const cpu = process.cpuUsage(cpuBefore);
        return { cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - started,
          headOpens: fsBoundary.open.mock.calls.filter(([file]) => String(file).endsWith('.jsonl')).length };
      };
      const unobservedTranscript = await measureTranscriptRefresh();
      const replacementLifetime = new AbortController();
      try {
        const grouping = contribution.describeResource(identity);
        await contribution.reconcileResource({ purpose: 'resource_descriptors', resourceKey: grouping.resourceKey,
          links: [{ linkKey: grouping.linkKey, linkedSource: identity }], signal: new AbortController().signal,
          observation: { lifetime: replacementLifetime.signal, changedFiles: [] } });
        const observedTranscript = await measureTranscriptRefresh();
        console.info('R246_CODEX_TRANSCRIPT_REFRESH', JSON.stringify({ files: 2001, ticks: 5, unobservedTranscript, observedTranscript }));
        expect(observedTranscript.headOpens).toBeLessThan(unobservedTranscript.headOpens / 2);
      } finally { replacementLifetime.abort(); }
      const { listCodexSessionCandidates } = await import('./candidateSource.js');
      const cursorBytes: number[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await listCodexSessionCandidates({ source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome },
          // Unsearched native-inventory pages never use the process boundary.
          exec: {} as ExecService, limit: 50, includeTitles: false, ...(cursor ? { cursor } : {}) });
        cursor = result.nextCursor ?? undefined;
        cursorBytes.push(Buffer.byteLength(cursor ?? '', 'utf8'));
      }
      console.info('CODEX_SYNTHETIC_NATIVE_INVENTORY_CURSOR_BYTES', JSON.stringify(cursorBytes));
    } finally { await rm(codexHome, { recursive: true, force: true }); }
  }, 60_000);

  it('reads long metadata heads in one bounded probe without pruning a non-time-based root family', async () => {
    const fixture = await createRolloutSetFixture();
    const lifetime = new AbortController();
    try {
      const timestamp = new Date().toISOString();
      const remoteSessionId = 'd4b84a10-0e52-44fa-8147-276000000000';
      const rootFile = join(dirname(fixture.rootFile), `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${remoteSessionId}.jsonl`);
      await rename(fixture.rootFile, rootFile);
      await writeFile(rootFile, JSON.stringify({ type: 'session_meta', timestamp, payload: { id: remoteSessionId, timestamp } }) + '\n'
        + Array.from({ length: 200 }, (_, ordinal) => JSON.stringify({ type: 'response_item', timestamp, payload: {
          type: 'message', role: ordinal % 2 ? 'assistant' : 'user', content: [{ type: ordinal % 2 ? 'output_text' : 'input_text',
            text: `r278ordinal${ordinal} café 東京 ${'coastal walk '.repeat(600)}` }],
        } }) + '\n').join(''));
      const priorTimestamp = new Date(Date.parse(timestamp) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replaceAll(':', '-');
      await Promise.all(Array.from({ length: 8400 }, (_, index) => writeFile(join(dirname(fixture.rootFile), `rollout-${priorTimestamp}-other-${index}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: `other-${index}`,
          base_instructions: { text: 'native instructions '.repeat(800) } } }) + '\n')));
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let unrelatedReads = 0;
      fsBoundary.open.mockImplementation(async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (String(args[0]).includes('-other-')) {
          const read = handle.read.bind(handle);
          handle.read = ((...readArgs: Parameters<typeof read>) => {
            unrelatedReads += 1;
            return read(...readArgs);
          }) as typeof handle.read;
        }
        return handle;
      });
      fsBoundary.open.mockClear();
      const started = performance.now();
      const result = await createCodexExternalSessionsContribution({ env: { CODEX_HOME: fixture.codexHome } }).pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome }, remoteSessionId, direction: 'older',
        maxSerializedBytes: 512 * 1024, maxItems: 200, signal: lifetime.signal, exec: {} as ExecService,
      });
      const unrelatedOpens = fsBoundary.open.mock.calls.filter(([file]) => String(file).includes('-other-')).length;
      console.info('R278_PUBLIC_PAGE', JSON.stringify({ files: 8402, elapsedMs: performance.now() - started,
        unrelatedOpens, unrelatedReads, items: result.ok ? result.value.items.length : 0 }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
      expect(result.value.items.length).toBeGreaterThan(0);
      expect(result.value.nextCursor).toBeTruthy();
      expect(unrelatedOpens).toBe(8400);
      expect(unrelatedReads).toBe(8400);
      const items = [...result.value.items];
      let cursor = result.value.nextCursor;
      while (cursor) {
        const page = await createCodexExternalSessionsContribution({ env: { CODEX_HOME: fixture.codexHome } }).pageTranscript({
          source: { kind: 'codexHome', home: 'user', homePath: fixture.codexHome }, remoteSessionId, direction: 'older',
          cursor, maxSerializedBytes: 512 * 1024, maxItems: 200, signal: lifetime.signal, exec: {} as ExecService,
        });
        if (!page.ok) throw new Error(page.message);
        expect(page.value.nextCursor).not.toBe(cursor);
        items.unshift(...page.value.items);
        cursor = page.value.nextCursor;
      }
      expect(items.map(item => Number(/r278ordinal(\d+)/.exec(JSON.stringify(item.raw))?.[1])))
        .toEqual(Array.from({ length: 200 }, (_, index) => index));
    } finally { lifetime.abort(); await rm(fixture.codexHome, { recursive: true, force: true }); }
  }, 120_000);

  it('retries an incomplete immutable head and admits a newly requested root from the retained inventory', async () => {
    const fixture = await createRolloutSetFixture();
    const incomplete = join(dirname(fixture.rootFile), 'rollout-incomplete.jsonl');
    await writeFile(incomplete, '');
    const contribution = createCodexExternalSessionObservationContribution({ env: { CODEX_HOME: fixture.codexHome } });
    await reconcileDescriptor(contribution, fixture.identity);
    await writeFile(incomplete, JSON.stringify({ type: 'session_meta', payload: { id: 'late-root' } }));
    const lateRoot = linkedSource({ codexHome: fixture.codexHome, remoteSessionId: 'late-root' });
    expect((await reconcileDescriptor(contribution, lateRoot)).watchFileChanges.files).toEqual([incomplete]);
    const child = linkedSource({ codexHome: fixture.codexHome, remoteSessionId: 'thread-child' });
    expect((await reconcileDescriptor(contribution, child)).watchFileChanges.files).toEqual([fixture.sidechainFile]);
  });

  it('refreshes root membership when an existing rollout is rewritten in place', async () => {
    const fixture = await createRolloutSetFixture();
    const contribution = createCodexExternalSessionObservationContribution({ env: { CODEX_HOME: fixture.codexHome } });
    await reconcileDescriptor(contribution, fixture.identity);
    await writeFile(fixture.sidechainFile, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-child', session_id: 'another-root' } }));
    expect((await reconcileDescriptor(contribution, fixture.identity)).watchFileChanges.files).toEqual([fixture.rootFile]);
    const otherRoot = linkedSource({ codexHome: fixture.codexHome, remoteSessionId: 'another-root' });
    expect((await reconcileDescriptor(contribution, otherRoot)).watchFileChanges.files).toEqual([fixture.sidechainFile]);
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
