import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs } from '../runtime/rpc/args.js';
import { resolvePiSessionIdFromResumeReference } from '../sessionFiles.js';
import { createPiExternalSessionsContribution } from './contribution.js';

const roots = new Set<string>();

function invocation(maxSerializedBytes = 64 * 1024) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes,
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function createAgentDir(): Promise<Readonly<{
  agentDir: string;
  sessionRoot: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-pi-external-'));
  roots.add(root);
  const agentDir = join(root, '.pi', 'agent');
  const sessionRoot = join(agentDir, 'sessions', '--workspace--');
  await mkdir(sessionRoot, { recursive: true });
  return { agentDir, sessionRoot };
}

async function createSessionFile(params: Readonly<{
  sessionRoot: string;
  sessionId: string;
  createdAt: string;
  title: string;
}>): Promise<string> {
  const filePath = join(params.sessionRoot, `${params.createdAt.replaceAll(':', '-')}_${params.sessionId}.jsonl`);
  await writeFile(filePath, [
    line({
      type: 'session',
      version: 3,
      id: params.sessionId,
      timestamp: params.createdAt,
      cwd: '/workspace',
    }),
    line({
      type: 'message',
      id: `${params.sessionId}-user`,
      parentId: null,
      timestamp: params.createdAt,
      message: { role: 'user', content: `prompt ${params.sessionId}` },
    }),
    line({
      type: 'session_info',
      id: `${params.sessionId}-title`,
      parentId: `${params.sessionId}-user`,
      timestamp: params.createdAt,
      name: params.title,
    }),
  ].join(''), 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('Pi pure External Sessions contribution leaf', () => {
  it('lists source-qualified candidates one bounded page at a time without using mtime as activity truth', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const olderPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-older',
      createdAt: '2026-07-20T10:00:00.000Z',
      title: 'Older Pi session',
    });
    const newerPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-newer',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'Newer Pi session',
    });
    await utimes(olderPath, new Date('2035-01-01T00:00:00.000Z'), new Date('2035-01-01T00:00:00.000Z'));

    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const canonicalOlderPath = await realpath(olderPath);
    const canonicalNewerPath = await realpath(newerPath);

    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.any(Object)],
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || !first.value.nextCursor) return;
    expect(first.value).not.toHaveProperty('preparation');
    expect(JSON.parse(Buffer.from(first.value.nextCursor, 'base64url').toString('utf8'))).toMatchObject({
      v: 2,
      kind: 'piCandidateIndexScan',
      sourceKey: await realpath(agentDir),
      sourceGeneration: expect.any(String),
      scanned: 1,
    });

    const candidates = [...first.value.candidates];
    let cursor: string | null = first.value.nextCursor;
    let calls = 1;
    while (cursor) {
      const page = await contribution.listCandidates({
        ...invocation(),
        source,
        cursor,
        maxItems: 1,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value).not.toHaveProperty('preparation');
      candidates.push(...page.value.candidates);
      cursor = page.value.nextCursor;
      calls += 1;
      expect(calls).toBeLessThanOrEqual(4);
    }
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteSessionId: 'pi-newer',
        title: 'Newer Pi session',
        updatedAtMs: Date.parse('2026-07-21T10:00:00.000Z'),
        linkData: { sessionFile: canonicalNewerPath },
      }),
      expect.objectContaining({
          remoteSessionId: 'pi-older',
          updatedAtMs: Date.parse('2026-07-20T10:00:00.000Z'),
          linkData: { sessionFile: canonicalOlderPath },
      }),
    ]));
  });

  it('starts a fresh bounded scan after EOF so an unchanged source can be paged again', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all([
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-replay-first',
        createdAt: '2026-07-21T10:00:00.000Z',
        title: 'Replay first',
      }),
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-replay-second',
        createdAt: '2026-07-21T11:00:00.000Z',
        title: 'Replay second',
      }),
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-replay-third',
        createdAt: '2026-07-21T12:00:00.000Z',
        title: 'Replay third',
      }),
    ]);
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };

    async function collectCandidateIds(): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | undefined;
      let calls = 0;
      do {
        const page = await contribution.listCandidates({
          ...invocation(),
          source,
          ...(cursor === undefined ? {} : { cursor }),
          maxItems: 1,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) {
          throw new Error(`Pi candidate replay failed with ${page.code}`);
        }
        ids.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
        cursor = page.value.nextCursor ?? undefined;
        calls += 1;
        expect(calls).toBeLessThanOrEqual(4);
      } while (cursor !== undefined);
      return ids;
    }

    const firstScan = await collectCandidateIds();
    const freshScan = await collectCandidateIds();

    expect(new Set(firstScan).size).toBe(3);
    expect(new Set(freshScan).size).toBe(3);
    expect(freshScan.toSorted()).toEqual(firstScan.toSorted());
  });

  it('keeps concurrent root scans independently continuable by their opaque scan ids', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all([
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-concurrent-first',
        createdAt: '2026-07-21T10:00:00.000Z',
        title: 'Concurrent first',
      }),
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-concurrent-second',
        createdAt: '2026-07-21T11:00:00.000Z',
        title: 'Concurrent second',
      }),
    ]);
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };

    const aFirst = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    const bFirst = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(aFirst).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    expect(bFirst).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (
      !aFirst.ok
      || !aFirst.value.nextCursor
      || !bFirst.ok
      || !bFirst.value.nextCursor
    ) return;
    expect(aFirst.value.nextCursor).not.toBe(bFirst.value.nextCursor);

    const aSecond = await contribution.listCandidates({
      ...invocation(),
      source,
      cursor: aFirst.value.nextCursor,
      maxItems: 1,
    });
    const bSecond = await contribution.listCandidates({
      ...invocation(),
      source,
      cursor: bFirst.value.nextCursor,
      maxItems: 1,
    });
    expect(aSecond).toMatchObject({ ok: true, value: { nextCursor: null } });
    expect(bSecond).toMatchObject({ ok: true, value: { nextCursor: null } });
    if (!aSecond.ok || !bSecond.ok) return;

    const expectedIds = ['pi-concurrent-first', 'pi-concurrent-second'];
    expect([
      ...aFirst.value.candidates,
      ...aSecond.value.candidates,
    ].map((candidate) => candidate.remoteSessionId).toSorted()).toEqual(expectedIds);
    expect([
      ...bFirst.value.candidates,
      ...bSecond.value.candidates,
    ].map((candidate) => candidate.remoteSessionId).toSorted()).toEqual(expectedIds);
  });

  it('admits exactly one simultaneous continuation for the same opaque cursor', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all(Array.from({ length: 4 }, (_, index) => createSessionFile({
      sessionRoot,
      sessionId: `pi-duplicate-${index}`,
      createdAt: `2026-07-21T1${index}:00:00.000Z`,
      title: `Duplicate ${index}`,
    })));
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;

    const duplicates = await Promise.all([
      contribution.listCandidates({
        ...invocation(),
        source,
        cursor: first.value.nextCursor,
        maxItems: 1,
      }),
      contribution.listCandidates({
        ...invocation(),
        source,
        cursor: first.value.nextCursor,
        maxItems: 1,
      }),
    ]);
    expect(duplicates.filter((result) => result.ok)).toHaveLength(1);
    expect(duplicates.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        code: 'source_invalid',
        retryable: true,
      }),
    ]);
    const winner = duplicates.find((result) => result.ok);
    if (!winner?.ok) return;

    const ids = [
      ...first.value.candidates,
      ...winner.value.candidates,
    ].map((candidate) => candidate.remoteSessionId);
    let cursor = winner.value.nextCursor;
    while (cursor) {
      const page = await contribution.listCandidates({
        ...invocation(),
        source,
        cursor,
        maxItems: 1,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      ids.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
      cursor = page.value.nextCursor;
    }
    expect(ids.toSorted()).toEqual([
      'pi-duplicate-0',
      'pi-duplicate-1',
      'pi-duplicate-2',
      'pi-duplicate-3',
    ]);
  });

  it('does not publish a continuation after its in-flight scan is evicted', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all(Array.from({ length: 3 }, (_, index) => createSessionFile({
      sessionRoot,
      sessionId: `pi-in-flight-eviction-${index}`,
      createdAt: `2026-07-21T1${index}:00:00.000Z`,
      title: `In-flight eviction ${index}`,
    })));
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;

    // The continuation claims the scan synchronously before its first filesystem await.
    const inFlight = contribution.listCandidates({
      ...invocation(),
      source,
      cursor: first.value.nextCursor,
      maxItems: 1,
    });
    const roots = await Promise.all(Array.from(
      { length: 16 },
      () => contribution.listCandidates({
        ...invocation(),
        source,
        maxItems: 1,
      }),
    ));
    await expect(inFlight).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });

    for (const root of roots) {
      expect(root).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
      if (!root.ok) return;
      let cursor = root.value.nextCursor;
      while (cursor) {
        const page = await contribution.listCandidates({
          ...invocation(),
          source,
          cursor,
          maxItems: 1,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        cursor = page.value.nextCursor;
      }
    }
  });

  it('bounds abandoned continuation resources by evicting only the oldest scan', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all([
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-eviction-first',
        createdAt: '2026-07-21T10:00:00.000Z',
        title: 'Eviction first',
      }),
      createSessionFile({
        sessionRoot,
        sessionId: 'pi-eviction-second',
        createdAt: '2026-07-21T11:00:00.000Z',
        title: 'Eviction second',
      }),
    ]);
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const cursors: string[] = [];

    for (let index = 0; index < 17; index += 1) {
      const page = await contribution.listCandidates({
        ...invocation(),
        source,
        maxItems: 1,
      });
      expect(page).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
      if (!page.ok || !page.value.nextCursor) return;
      cursors.push(page.value.nextCursor);
    }

    await expect(contribution.listCandidates({
      ...invocation(),
      source,
      cursor: cursors[0],
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });

    for (const cursor of cursors.slice(1)) {
      await expect(contribution.listCandidates({
        ...invocation(),
        source,
        cursor,
        maxItems: 1,
      })).resolves.toMatchObject({
        ok: true,
        value: { nextCursor: null },
      });
    }
  });

  it('rejects a candidate continuation when native root membership changes between chunks', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-before-first',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'First existing Pi session',
    });
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-before-second',
      createdAt: '2026-07-20T10:00:00.000Z',
      title: 'Second existing Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const first = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || !first.value.nextCursor) return;
    expect(first.value).not.toHaveProperty('preparation');

    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-inserted-between-pages',
      createdAt: '2026-07-22T10:00:00.000Z',
      title: 'Inserted Pi session',
    });

    await expect(contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      cursor: first.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });
  });

  it('starts a fresh scan that observes membership added after the prior scan completed', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-completed-generation',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'Completed generation',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    let page = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(page.ok).toBe(true);
    while (page.ok && page.value.nextCursor) {
      page = await contribution.listCandidates({
        ...invocation(),
        source,
        cursor: page.value.nextCursor,
        maxItems: 1,
      });
    }
    expect(page).toMatchObject({ ok: true, value: { nextCursor: null } });

    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-after-completion',
      createdAt: '2026-07-22T10:00:00.000Z',
      title: 'Mutation after completion',
    });

    const refreshedIds: string[] = [];
    let refreshed = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    while (refreshed.ok) {
      refreshedIds.push(...refreshed.value.candidates.map((candidate) => candidate.remoteSessionId));
      if (!refreshed.value.nextCursor) break;
      refreshed = await contribution.listCandidates({
        ...invocation(),
        source,
        cursor: refreshed.value.nextCursor,
        maxItems: 1,
      });
    }
    expect(refreshed.ok).toBe(true);
    expect(refreshedIds.toSorted()).toEqual([
      'pi-after-completion',
      'pi-completed-generation',
    ]);
  });

  it('bounds native directory traversal to one candidate page without opting into host indexing', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      const suffix = String(index).padStart(3, '0');
      await createSessionFile({
        sessionRoot,
        sessionId: `pi-bounded-${suffix}`,
        createdAt: `2026-07-21T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        title: `Bounded Pi session ${suffix}`,
      });
    }));
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const signal = new AbortController().signal;
    const nativeThrowIfAborted = signal.throwIfAborted.bind(signal);
    let boundaryChecks = 0;
    Object.defineProperty(signal, 'throwIfAborted', {
      configurable: true,
      value() {
        boundaryChecks += 1;
        if (boundaryChecks > 24) throw new Error('candidate traversal exceeded its bounded chunk');
        nativeThrowIfAborted();
      },
    });

    const page = await contribution.listCandidates({
      ...invocation(),
      signal,
      source: { kind: 'piAgentDir' },
      maxItems: 2,
    });

    expect(page).toMatchObject({
      ok: true,
      value: {
        candidates: expect.any(Array),
        nextCursor: expect.any(String),
      },
    });
    if (page.ok) expect(page.value).not.toHaveProperty('preparation');
    expect(boundaryChecks).toBeLessThanOrEqual(24);
  });

  it('restarts the candidate scan after cancellation advances an unacknowledged native directory read', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-cancel-first',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'First cancellation fixture',
    });
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-cancel-second',
      createdAt: '2026-07-21T11:00:00.000Z',
      title: 'Second cancellation fixture',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;

    const controller = new AbortController();
    const nativeThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    Object.defineProperty(controller.signal, 'throwIfAborted', {
      configurable: true,
      value() {
        checks += 1;
        if (checks === 2) controller.abort();
        nativeThrowIfAborted();
      },
    });
    await expect(contribution.listCandidates({
      ...invocation(),
      signal: controller.signal,
      source,
      cursor: first.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({ ok: false, code: 'cancelled' });

    const recoveredIds: string[] = [];
    let recovered = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    while (recovered.ok) {
      recoveredIds.push(...recovered.value.candidates.map((candidate) => candidate.remoteSessionId));
      if (!recovered.value.nextCursor) break;
      recovered = await contribution.listCandidates({
        ...invocation(),
        source,
        cursor: recovered.value.nextCursor,
        maxItems: 1,
      });
    }
    expect(recoveredIds.sort()).toEqual(['pi-cancel-first', 'pi-cancel-second']);
  });

  it('keeps bounded direct search explicit instead of exposing it as host-index preparation', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-search-first',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'First bounded search result',
    });
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-search-second',
      createdAt: '2026-07-21T11:00:00.000Z',
      title: 'Second bounded search result',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    const result = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      searchTerm: 'search',
      searchMode: 'fast',
      maxItems: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.any(Object)],
        nextCursor: expect.any(String),
        searchIncomplete: true,
      },
    });
    if (result.ok) expect(result.value).not.toHaveProperty('preparation');
  });

  it('round-trips the exact session file through link identity and the existing --session path resume', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-resume',
      createdAt: '2026-07-21T11:00:00.000Z',
      title: 'Resume Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const canonicalAgentDir = await realpath(agentDir);
    const canonicalSessionFile = await realpath(sessionFile);

    const linked = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      remoteSessionId: 'pi-resume',
      linkData: { sessionFile },
    });
    expect(linked).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'piAgentDir',
          agentDir: canonicalAgentDir,
          sessionFile: canonicalSessionFile,
        },
        remoteSessionId: 'pi-resume',
        linkData: {
          sessionFile: canonicalSessionFile,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'pi',
            agent: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              providerSessionId: 'pi-resume',
              sessionFile: canonicalSessionFile,
            },
          },
        },
      },
    });
    if (!linked.ok) return;

    await expect(contribution.resolveLinkedIdentity({
      ...invocation(),
      source: linked.value.source,
      remoteSessionId: 'pi-resume',
      linkData: linked.value.linkData,
    })).resolves.toEqual(linked);
    expect(resolvePiSessionIdFromResumeReference(canonicalSessionFile)).toBe('pi-resume');
    expect(buildPiRpcArgs({ resumeSessionId: canonicalSessionFile }).slice(-2)).toEqual([
      '--session',
      canonicalSessionFile,
    ]);
  });

  it('discovers through the canonical Pi legacy session-root descriptor instead of assuming agentDir/sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-external-legacy-'));
    roots.add(root);
    const sessionRoot = join(root, 'legacy-sessions', '--workdir--');
    await mkdir(sessionRoot, { recursive: true });
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-legacy-root',
      createdAt: '2026-07-21T11:30:00.000Z',
      title: 'Legacy-root Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_SESSION_DIR: join(root, 'legacy-sessions') },
    });

    await expect(contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({
          remoteSessionId: 'pi-legacy-root',
          linkData: { sessionFile: await realpath(sessionFile) },
        })],
      },
    });
  });

  it('pages only the active Pi v3 parent chain while preserving compaction, subagent, and unknown records', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-20T10-00-00-000Z_pi-session-fixture.jsonl');
    const fixture = await readFile(
      new URL('../transcripts/__fixtures__/pi-session-v3-tree.jsonl', import.meta.url),
      'utf8',
    );
    await writeFile(sessionFile, fixture, 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const, agentDir, sessionFile };

    const itemRecords: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let tailCursor: string | null = null;
    do {
      const page = await contribution.pageTranscript({
        ...invocation(),
        source,
        remoteSessionId: 'pi-session-fixture',
        direction: 'older',
        ...(cursor ? { cursor } : {}),
        maxItems: 3,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      tailCursor ??= page.value.tailCursor ?? null;
      itemRecords.unshift(...page.value.items.map((item) => item.raw.record as Record<string, unknown>));
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);

    expect(itemRecords.map((record) => record.id)).toEqual([
      'user-root',
      'assistant-root',
      'subagent-result',
      'branch-summary',
      'active-user',
      'compaction',
      'active-assistant',
      'future-entry',
    ]);
    expect(itemRecords.map((record) => record.id)).not.toContain('abandoned-user');
    expect(itemRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'compaction', firstKeptEntryId: 'active-user' }),
      expect.objectContaining({
        id: 'assistant-root',
        message: expect.objectContaining({
          content: [expect.objectContaining({ type: 'toolCall', name: 'subagent' })],
        }),
      }),
      expect.objectContaining({ id: 'future-entry', type: 'future_entry' }),
    ]));
    expect(tailCursor).toEqual(expect.any(String));
  });

  it('readAfter advances an append but fences a same-path replacement with a new source generation', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-live',
      createdAt: '2026-07-21T12:00:00.000Z',
      title: 'Live Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const, agentDir, sessionFile };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-live',
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;
    expect(JSON.parse(Buffer.from(initial.value.tailCursor, 'base64url').toString('utf8'))).toMatchObject({
      v: 2,
      kind: 'piTranscript',
      sessionFile: await realpath(sessionFile),
      sourceGeneration: expect.any(String),
      endOffsetBytes: expect.any(Number),
      activeLeafId: 'pi-live-title',
      activeLeafFingerprint: expect.any(String),
    });

    await appendFile(sessionFile, [
      line({
        type: 'session_info',
        id: 'pi-live-skipped',
        parentId: 'pi-live-title',
        timestamp: '2026-07-21T12:00:00.500Z',
        name: 'Updated title',
      }),
      line({
        type: 'message',
        id: 'pi-live-assistant',
        parentId: 'pi-live-skipped',
        timestamp: '2026-07-21T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'new answer' }],
          stopReason: 'stop',
        },
      }),
    ].join(''));
    const advanced = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-live',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.items).toHaveLength(1);
    expect(advanced.value.items[0]?.raw.record).toMatchObject({ id: 'pi-live-assistant' });
    expect(advanced.value.diagnostics).toEqual([{
      code: 'non_transcript_record_skipped',
      count: 1,
      positions: [0],
    }]);
    expect(advanced.value.nextCursor).toEqual(expect.any(String));
    expect(advanced.value.outcome).toBe('advanced');
    if (!advanced.value.nextCursor) return;

    const replacement = join(sessionRoot, 'replacement.jsonl');
    await writeFile(replacement, [
      line({
        type: 'session',
        version: 3,
        id: 'pi-live',
        timestamp: '2026-07-21T12:00:00.000Z',
        cwd: '/workspace',
      }),
      line({
        type: 'message',
        id: 'replacement-root',
        parentId: null,
        timestamp: '2026-07-21T12:00:02.000Z',
        message: { role: 'user', content: 'replacement' },
      }),
    ].join(''), 'utf8');
    await rename(replacement, sessionFile);

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-live',
      cursor: advanced.value.nextCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'source_replaced',
      },
    });
  });

  it('readAfter advances appended branch entries in bounded forward pages', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-bounded-read-after',
      createdAt: '2026-07-21T12:15:00.000Z',
      title: 'Bounded Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const, agentDir, sessionFile };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-bounded-read-after',
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    await appendFile(sessionFile, [
      line({
        type: 'message',
        id: 'pi-bounded-read-after-first',
        parentId: 'pi-bounded-read-after-title',
        timestamp: '2026-07-21T12:15:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first bounded answer' }],
          stopReason: 'stop',
        },
      }),
      line({
        type: 'message',
        id: 'pi-bounded-read-after-second',
        parentId: 'pi-bounded-read-after-first',
        timestamp: '2026-07-21T12:15:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second bounded answer' }],
          stopReason: 'stop',
        },
      }),
    ].join(''));

    const first = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-bounded-read-after',
      cursor: initial.value.tailCursor,
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [
          {
            raw: {
              record: { id: 'pi-bounded-read-after-first' },
            },
          },
        ],
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || first.value.outcome !== 'advanced') return;

    const second = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-bounded-read-after',
      cursor: first.value.nextCursor,
      maxItems: 1,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [
          {
            raw: {
              record: { id: 'pi-bounded-read-after-second' },
            },
          },
        ],
        nextCursor: expect.any(String),
      },
    });
  });

  it('fences an in-place rewrite that reuses the active leaf id', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-in-place-rewrite',
      createdAt: '2026-07-21T12:30:00.000Z',
      title: 'Original Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const, agentDir, sessionFile };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-in-place-rewrite',
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const before = await stat(sessionFile);
    await writeFile(sessionFile, [
      line({
        type: 'session',
        version: 3,
        id: 'pi-in-place-rewrite',
        timestamp: '2026-07-21T12:30:00.000Z',
        cwd: '/workspace',
      }),
      line({
        type: 'session_info',
        id: 'pi-in-place-rewrite-title',
        parentId: null,
        timestamp: '2026-07-21T12:30:01.000Z',
        name: 'Rewritten Pi session',
      }),
    ].join(''), 'utf8');
    const after = await stat(sessionFile);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-in-place-rewrite',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'source_replaced',
      },
    });
  });

  it('rejects malformed and source-mismatched candidate cursors', async () => {
    const firstRoot = await createAgentDir();
    await createSessionFile({
      sessionRoot: firstRoot.sessionRoot,
      sessionId: 'pi-first',
      createdAt: '2026-07-21T13:00:00.000Z',
      title: 'First source',
    });
    await createSessionFile({
      sessionRoot: firstRoot.sessionRoot,
      sessionId: 'pi-second',
      createdAt: '2026-07-21T12:00:00.000Z',
      title: 'First source second page',
    });
    const firstContribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: firstRoot.agentDir },
    });
    const first = await firstContribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      maxItems: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.nextCursor) return;

    const secondRoot = await createAgentDir();
    const secondContribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: secondRoot.agentDir },
    });
    await expect(secondContribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      cursor: first.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    await expect(firstContribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      cursor: 'not-a-cursor',
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
