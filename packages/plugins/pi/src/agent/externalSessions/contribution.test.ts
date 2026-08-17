import {
  appendFile,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  createSessionOwnerMetadataV1,
  TranscriptRawRecordV1Schema,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs } from '../runtime/rpc/args.js';
import { resolvePiSessionIdFromResumeReference } from '../sessionFiles.js';
import { createPiExternalSessionsContribution } from './contribution.js';
import { createPiExternalSessionObservationContribution } from './observation.js';

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

/**
 * A real Pi session file carries no `session_info` record: Pi never persists an
 * agent-authored title, so the first user message is the only title evidence.
 */
async function createUntitledSessionFile(params: Readonly<{
  sessionRoot: string;
  sessionId: string;
  createdAt: string;
  firstUserText: string;
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
      message: { role: 'user', content: [{ type: 'text', text: params.firstUserText }] },
    }),
  ].join(''), 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('Pi pure External Sessions contribution leaf', () => {
  it('lists only the explicitly configured source when ambient Pi storage points elsewhere', async () => {
    const configured = await createAgentDir();
    const ambient = await createAgentDir();
    await createSessionFile({
      sessionRoot: configured.sessionRoot,
      sessionId: 'configured-pi',
      createdAt: '2026-08-16T10:00:00.000Z',
      title: 'Configured Pi',
    });
    await createSessionFile({
      sessionRoot: ambient.sessionRoot,
      sessionId: 'ambient-pi',
      createdAt: '2026-08-16T11:00:00.000Z',
      title: 'Ambient Pi',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: ambient.agentDir },
    });

    const listed = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir', agentDir: configured.agentDir },
      maxItems: 10,
    });

    expect(listed).toMatchObject({
      ok: true,
      value: { candidates: [expect.objectContaining({ remoteSessionId: 'configured-pi' })] },
    });
    expect(JSON.stringify(listed)).not.toContain('ambient-pi');
  });

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
    expect(first.value).toMatchObject({
      preparation: { kind: 'building_candidate_index', scanned: 1 },
    });
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
      expect(page.value).toMatchObject({
        preparation: { kind: 'building_candidate_index', scanned: expect.any(Number) },
      });
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

  it('hands a newer candidate discovered in a later filesystem chunk to canonical index preparation', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const createdAt = '2026-07-20T10:00:00.000Z';
    const firstPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-traversal-first',
      createdAt,
      title: 'First traversal candidate',
    });
    const laterPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-traversal-later',
      createdAt,
      title: 'Later traversal candidate',
    });
    const directory = await opendir(sessionRoot);
    const traversal = [] as string[];
    for await (const entry of directory) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) traversal.push(entry.name);
    }
    const newestPath = traversal.at(-1) === basename(firstPath)
      ? firstPath
      : laterPath;
    const newestId = newestPath === firstPath ? 'pi-traversal-first' : 'pi-traversal-later';
    const newestTimestamp = '2026-07-22T10:00:00.000Z';
    await writeFile(
      newestPath,
      (await readFile(newestPath, 'utf8')).replaceAll(createdAt, newestTimestamp),
      'utf8',
    );

    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
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
        preparation: { kind: 'building_candidate_index', scanned: 1 },
      },
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected later traversal cursor');
    expect(first.value.candidates[0]?.remoteSessionId).not.toBe(newestId);

    const second = await contribution.listCandidates({
      ...invocation(),
      source,
      cursor: first.value.nextCursor,
      maxItems: 1,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({
          remoteSessionId: newestId,
          updatedAtMs: Date.parse(newestTimestamp),
        })],
        preparation: { kind: 'building_candidate_index', scanned: 2 },
      },
    });
  });

  it('keeps full searched traversal bounded instead of materializing a leaf-local corpus', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const createdAt = '2026-07-20T10:00:00.000Z';
    const firstPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-search-traversal-first',
      createdAt,
      title: 'Ordered search first traversal candidate',
    });
    const laterPath = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-search-traversal-later',
      createdAt,
      title: 'Ordered search later traversal candidate',
    });
    const directory = await opendir(sessionRoot);
    const traversal = [] as string[];
    for await (const entry of directory) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) traversal.push(entry.name);
    }
    const newestPath = traversal.at(-1) === basename(firstPath)
      ? firstPath
      : laterPath;
    const newestTimestamp = '2026-07-22T10:00:00.000Z';
    await writeFile(
      newestPath,
      (await readFile(newestPath, 'utf8')).replaceAll(createdAt, newestTimestamp),
      'utf8',
    );

    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const fast = await contribution.listCandidates({
      ...invocation(),
      source,
      searchTerm: 'ordered search',
      searchMode: 'fast',
      maxItems: 1,
    });
    expect(fast).toMatchObject({
      ok: true,
      value: { searchIncomplete: true },
    });
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      searchTerm: 'ordered search',
      searchMode: 'full',
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.any(Object)],
        nextCursor: expect.any(String),
        searchIncomplete: true,
      },
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected full-search continuation');
    if (first.ok) expect(first.value).not.toHaveProperty('preparation');
  });

  it('invalidates a full-search cursor when its existing workspace changes', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-full-current-first',
      createdAt: '2026-07-20T10:00:00.000Z',
      title: 'Current full search first',
    });
    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-full-current-newest',
      createdAt: '2026-07-22T10:00:00.000Z',
      title: 'Current full search newest',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      searchTerm: 'current full search',
      searchMode: 'full',
      maxItems: 1,
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected full-search continuation');

    await createSessionFile({
      sessionRoot,
      sessionId: 'pi-full-current-between',
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'Current full search between pages',
    });

    await expect(contribution.listCandidates({
      ...invocation(),
      source,
      cursor: first.value.nextCursor,
      searchTerm: 'current full search',
      searchMode: 'full',
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });
  });

  it('projects a first-user-message title onto candidates a Pi session never titled', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    await createUntitledSessionFile({
      sessionRoot,
      sessionId: 'pi-untitled',
      createdAt: '2026-07-20T10:00:00.000Z',
      firstUserText: '  Audit   the\n\nlink flow\t ',
    });
    await createUntitledSessionFile({
      sessionRoot,
      sessionId: 'pi-untitled-long',
      createdAt: '2026-07-20T11:00:00.000Z',
      firstUserText: `${'word '.repeat(60)}tail`,
    });
    // Happier prepends its own base system prompt to the first Pi user turn;
    // surfacing that preamble as the title is worse than showing no title at all.
    // Which block opens the preamble depends on the session's prompt settings, so
    // every opening block the canonical producer can emit must be rejected.
    await createUntitledSessionFile({
      sessionRoot,
      sessionId: 'pi-untitled-title-preamble',
      createdAt: '2026-07-20T12:00:00.000Z',
      firstUserText: `${HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1}\n\nreal prompt`,
    });
    await createUntitledSessionFile({
      sessionRoot,
      sessionId: 'pi-untitled-options-preamble',
      createdAt: '2026-07-20T13:00:00.000Z',
      firstUserText: `${HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1}\n\nreal prompt`,
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    const page = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      maxItems: 10,
    });
    if (!page.ok) throw new Error('Pi candidate page unexpectedly failed');
    const byId = new Map(page.value.candidates.map((candidate) => [candidate.remoteSessionId, candidate]));

    expect(byId.get('pi-untitled')?.title).toBe('Audit the link flow');
    const longTitle = byId.get('pi-untitled-long')?.title ?? '';
    expect(longTitle).toHaveLength(120);
    expect(longTitle.endsWith('...')).toBe(true);
    expect(byId.get('pi-untitled-title-preamble')).not.toHaveProperty('title');
    expect(byId.get('pi-untitled-options-preamble')).not.toHaveProperty('title');
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
    expect(first.value).toMatchObject({
      preparation: { kind: 'building_candidate_index', scanned: expect.any(Number) },
    });

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

  it('bounds native directory traversal to one candidate preparation chunk', async () => {
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
    if (page.ok) {
      expect(page.value).toMatchObject({
        preparation: { kind: 'building_candidate_index', scanned: expect.any(Number) },
      });
    }
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

  it('advances candidate preparation progress when a bounded chunk consumes only a workspace root', async () => {
    const { agentDir } = await createAgentDir();
    await mkdir(join(agentDir, 'sessions', '--empty-workspace--'));
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
        candidates: [],
        nextCursor: expect.any(String),
        preparation: { kind: 'building_candidate_index', scanned: expect.any(Number) },
      },
    });
    if (!first.ok || !first.value.nextCursor) return;
    expect(first.value.preparation?.scanned).toBeGreaterThan(0);
    expect(JSON.parse(Buffer.from(first.value.nextCursor, 'base64url').toString('utf8'))).toMatchObject({
      kind: 'piCandidateIndexScan',
      scanned: expect.any(Number),
    });
  });

  it('resolves an unqualified duplicate session id through shared candidate precedence', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const remoteSessionId = 'pi-unqualified-duplicate';
    const olderPath = await createSessionFile({
      sessionRoot,
      sessionId: remoteSessionId,
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'Older Pi duplicate',
    });
    const newerRoot = join(agentDir, 'sessions', '--workspace-newer--');
    await mkdir(newerRoot, { recursive: true });
    const newerPath = await createSessionFile({
      sessionRoot: newerRoot,
      sessionId: remoteSessionId,
      createdAt: '2026-07-21T11:00:00.000Z',
      title: 'Newer Pi duplicate',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'piAgentDir' },
      remoteSessionId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'piAgentDir',
          sessionFile: await realpath(newerPath),
        },
      },
    });
    expect(await realpath(olderPath)).not.toBe(await realpath(newerPath));
  });

  it('uses one candidate-inspection ceiling when a final oversized row changes duplicate precedence', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const remoteSessionId = 'pi-large-tail-duplicate';
    const olderHeaderNewerTailPath = await createSessionFile({
      sessionRoot,
      sessionId: remoteSessionId,
      createdAt: '2026-07-21T10:00:00.000Z',
      title: 'Older header',
    });
    await appendFile(olderHeaderNewerTailPath, line({
      type: 'message',
      id: 'large-final-row',
      timestamp: '2026-07-21T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: 'x'.repeat(300 * 1024),
      },
    }), 'utf8');
    const secondRoot = join(agentDir, 'sessions', '--workspace-second--');
    await mkdir(secondRoot, { recursive: true });
    await createSessionFile({
      sessionRoot: secondRoot,
      sessionId: remoteSessionId,
      createdAt: '2026-07-21T11:00:00.000Z',
      title: 'Newer header',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const canonicalWinnerPath = await realpath(olderHeaderNewerTailPath);

    const listed = await contribution.listCandidates({
      ...invocation(1024 * 1024),
      source: { kind: 'piAgentDir' },
      maxItems: 10,
    });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    expect(listed.value.candidates.find((candidate) => (
      candidate.linkData?.sessionFile === canonicalWinnerPath
    ))).toMatchObject({
      updatedAtMs: Date.parse('2026-07-21T12:00:00.000Z'),
    });

    await expect(contribution.resolveLinkIdentity({
      ...invocation(256 * 1024),
      source: { kind: 'piAgentDir' },
      remoteSessionId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'piAgentDir',
          sessionFile: canonicalWinnerPath,
        },
      },
    });
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

    // The host projects `linkData` minus `source` straight into TOP-LEVEL session
    // owner metadata, whose strict allow-list rejects any unknown key. A Pi link
    // identity that leaks `sessionFile` there fails every link with an untyped
    // `internal_error`; the canonical carrier is `source.sessionFile`.
    const { source: _projectedSource, ...vendorMetadata } = linked.value.linkData;
    expect(createSessionOwnerMetadataV1({
      metadata: {
        tag: 'pi-resume',
        path: '/workspace',
        host: 'host',
        machineId: 'machine',
        flavor: 'pi',
        ...vendorMetadata,
      },
    })).toMatchObject({ ok: true });

    await expect(contribution.resolveLinkedIdentity({
      ...invocation(),
      source: linked.value.source,
      remoteSessionId: 'pi-resume',
      linkData: linked.value.linkData,
    })).resolves.toEqual(linked);

    // The observation leaf reads the linked session file back out of this exact
    // identity; a hand-built fixture there would hide a producer/consumer split.
    expect(createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    }).describeResource(linked.value)).toMatchObject({
      resourceKey: expect.any(String),
    });
    expect(resolvePiSessionIdFromResumeReference(canonicalSessionFile)).toBe('pi-resume');
    expect(buildPiRpcArgs({ resumeSessionId: canonicalSessionFile }).slice(-2)).toEqual([
      '--session',
      canonicalSessionFile,
    ]);
  });

  it('keeps a legacy Pi session root when its canonicalized source is replayed through linking and observation', async () => {
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

    const source = await contribution.resolveSource({
      ...invocation(),
      source: { kind: 'piAgentDir' },
    });
    expect(source).toMatchObject({
      ok: true,
      value: { source: { kind: 'piAgentDir', agentDir: expect.any(String) } },
    });
    if (!source.ok) return;

    const listed = await contribution.listCandidates({
      ...invocation(),
      source: source.value.source,
      maxItems: 1,
    });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({
          remoteSessionId: 'pi-legacy-root',
          linkData: { sessionFile: await realpath(sessionFile) },
        })],
      },
    });
    if (!listed.ok) return;
    const candidate = listed.value.candidates[0];
    if (!candidate) throw new Error('expected legacy-root candidate');

    const linked = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: source.value.source,
      remoteSessionId: candidate.remoteSessionId,
      linkData: candidate.linkData,
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'piAgentDir',
          agentDir: source.value.source.agentDir,
          sessionFile: await realpath(sessionFile),
        },
      },
    });
    if (!linked.ok) return;
    expect(createPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_SESSION_DIR: join(root, 'legacy-sessions') },
    }).describeResource(linked.value)).toMatchObject({
      resourceKey: expect.any(String),
    });
  });

  it('fails a page rather than projecting an unknown Pi entry as fictional prose', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-20T10-00-00-000Z_pi-unknown-entry.jsonl');
    await writeFile(sessionFile, [
      line({ type: 'session', version: 3, id: 'pi-unknown-entry', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/workspace' }),
      line({
        type: 'future_entry',
        id: 'unknown-entry',
        parentId: null,
        timestamp: '2026-07-20T10:00:01.000Z',
        // A future entry could happen to carry a message-shaped field. Its
        // entry type still has no approved transcript semantics.
        message: { role: 'user', content: 'must not reinterpret this future record' },
      }),
    ].join(''), 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'piAgentDir', agentDir, sessionFile },
      remoteSessionId: 'pi-unknown-entry',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
    });
  });

  it('fails a page rather than silently skipping a malformed known Pi metadata entry', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-20T10-05-00-000Z_pi-malformed-known.jsonl');
    await writeFile(sessionFile, [
      line({ type: 'session', version: 3, id: 'pi-malformed-known', timestamp: '2026-07-20T10:05:00.000Z', cwd: '/workspace' }),
      line({
        type: 'model_change',
        id: 'malformed-model-change',
        parentId: null,
        timestamp: '2026-07-20T10:05:01.000Z',
        // Pi's native shape requires both provider and modelId.
        modelId: 'missing-provider',
      }),
    ].join(''), 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'piAgentDir', agentDir, sessionFile },
      remoteSessionId: 'pi-malformed-known',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
    });
  });

  it('fails a malformed Pi branch summary rather than converting it to agent prose', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-20T10-10-00-000Z_pi-malformed-summary.jsonl');
    await writeFile(sessionFile, [
      line({ type: 'session', version: 3, id: 'pi-malformed-summary', timestamp: '2026-07-20T10:10:00.000Z', cwd: '/workspace' }),
      line({
        type: 'branch_summary',
        id: 'malformed-branch-summary',
        parentId: null,
        timestamp: '2026-07-20T10:10:01.000Z',
        summary: 'missing its native fromId',
      }),
    ].join(''), 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'piAgentDir', agentDir, sessionFile },
      remoteSessionId: 'pi-malformed-summary',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
    });
  });

  it('fails a page rather than letting a structurally malformed Pi record disappear', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-20T10-15-00-000Z_pi-malformed-record.jsonl');
    await writeFile(sessionFile, [
      line({ type: 'session', version: 3, id: 'pi-malformed-record', timestamp: '2026-07-20T10:15:00.000Z', cwd: '/workspace' }),
      // The native tree parser cannot form an entry without id/parentId. It
      // must not silently drop this while the external cursor advances.
      line({
        type: 'future_entry',
        timestamp: '2026-07-20T10:15:01.000Z',
        payload: { unsupported: true },
      }),
    ].join(''), 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'piAgentDir', agentDir, sessionFile },
      remoteSessionId: 'pi-malformed-record',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
    });
  });

  it('projects every Pi transcript row into the canonical transcript raw envelope', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = join(sessionRoot, '2026-07-22T09-00-00-000Z_pi-envelope.jsonl');
    await writeFile(sessionFile, [
      line({
        type: 'session',
        version: 3,
        id: 'pi-envelope',
        timestamp: '2026-07-22T09:00:00.000Z',
        cwd: '/workspace',
      }),
      line({
        type: 'message',
        id: 'user-string',
        parentId: null,
        timestamp: '2026-07-22T09:00:01.000Z',
        message: { role: 'user', content: 'plain string prompt' },
      }),
      line({
        type: 'message',
        id: 'user-blocks',
        parentId: 'user-string',
        timestamp: '2026-07-22T09:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first part' }, { type: 'text', text: ' and second' }],
        },
      }),
      line({
        type: 'message',
        id: 'assistant-mixed',
        parentId: 'user-blocks',
        timestamp: '2026-07-22T09:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'weighing options', thinkingSignature: 'sig' },
            { type: 'text', text: 'here is the plan', textSignature: 'sig' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/workspace/a.ts' } },
            { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'ls' } },
          ],
          stopReason: 'toolUse',
        },
      }),
      line({
        type: 'message',
        id: 'tool-result',
        parentId: 'assistant-mixed',
        timestamp: '2026-07-22T09:00:04.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
          isError: false,
        },
      }),
      line({
        type: 'compaction',
        id: 'compaction',
        parentId: 'tool-result',
        timestamp: '2026-07-22T09:00:05.000Z',
        summary: 'compacted the earlier turns',
        firstKeptEntryId: 'user-blocks',
        tokensBefore: 42000,
      }),
      line({
        type: 'model_change',
        id: 'model-change',
        parentId: 'compaction',
        timestamp: '2026-07-22T09:00:06.000Z',
        modelId: 'sonnet',
        provider: 'anthropic',
      }),
    ].join(''), 'utf8');

    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const page = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'piAgentDir' as const, agentDir, sessionFile },
      remoteSessionId: 'pi-envelope',
      direction: 'older',
      maxItems: 50,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    const failures = page.value.items.flatMap((item) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse(item.raw);
      return parsed.success ? [] : [{ id: item.id, raw: item.raw, issues: parsed.error.issues }];
    });
    expect(failures).toEqual([]);

    const raws = page.value.items.map((item) => item.raw);
    expect(raws).toEqual(expect.arrayContaining([
      { role: 'user', content: { type: 'text', text: 'plain string prompt' } },
      { role: 'user', content: { type: 'text', text: 'first part and second' } },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: { type: 'thinking', text: 'weighing options' },
        },
      },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: { type: 'message', message: 'here is the plan' },
        },
      },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { path: '/workspace/a.ts' },
            id: 'pi:pi-envelope:assistant-mixed:toolCall:2',
          },
        },
      },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: {
            type: 'tool-result',
            callId: 'call-1',
            output: [{ type: 'text', text: 'file body' }],
            id: 'pi:pi-envelope:tool-result',
            isError: false,
          },
        },
      },
    ]));

    expect(raws).toEqual(expect.arrayContaining([
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: {
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: 'pi:pi-envelope:compaction',
            trigger: 'unknown',
            source: 'runtime',
            tokenCountBefore: 42000,
          },
        },
      },
    ]));
    expect(page.value.items.map((item) => item.id)).toEqual([
      'pi:pi-envelope:user-string',
      'pi:pi-envelope:user-blocks',
      'pi:pi-envelope:assistant-mixed:thinking:0',
      'pi:pi-envelope:assistant-mixed:text:1',
      'pi:pi-envelope:assistant-mixed:toolCall:2',
      'pi:pi-envelope:assistant-mixed:toolCall:3',
      'pi:pi-envelope:tool-result',
      'pi:pi-envelope:compaction',
    ]);
    expect(page.value.items.map((item) => item.messageRole)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
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
    expect(advanced.value.items[0]).toMatchObject({
      id: 'pi:pi-live:pi-live-assistant:text:0',
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: { type: 'message', message: 'new answer' },
        },
      },
    });
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
            id: 'pi:pi-bounded-read-after:pi-bounded-read-after-first:text:0',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'pi',
                data: { type: 'message', message: 'first bounded answer' },
              },
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
            id: 'pi:pi-bounded-read-after:pi-bounded-read-after-second:text:0',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'pi',
                data: { type: 'message', message: 'second bounded answer' },
              },
            },
          },
        ],
        nextCursor: expect.any(String),
      },
    });
  });

  it('uses an intra-record cursor when one Pi message projects to more rows than the item limit', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const splitSessionFile = join(sessionRoot, '2026-07-21T12-20-00-000Z_pi-split-page.jsonl');
    const mixedAssistantEntry = {
      type: 'message',
      id: 'pi-split-assistant',
      parentId: null,
      timestamp: '2026-07-21T12:20:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning first' },
          { type: 'text', text: 'then answer' },
          { type: 'toolCall', id: 'pi-split-call-one', name: 'read', arguments: { path: '/workspace/a.ts' } },
          { type: 'toolCall', id: 'pi-split-call-two', name: 'bash', arguments: { command: 'pwd' } },
        ],
      },
    };
    const trailingUserEntry = {
      type: 'message',
      id: 'pi-split-follow-up',
      parentId: 'pi-split-assistant',
      timestamp: '2026-07-21T12:20:02.000Z',
      message: { role: 'user', content: 'follow-up after the split record' },
    };
    await writeFile(splitSessionFile, [
      line({ type: 'session', version: 3, id: 'pi-split-page', timestamp: '2026-07-21T12:20:00.000Z', cwd: '/workspace' }),
      line(mixedAssistantEntry),
      line(trailingUserEntry),
    ].join(''), 'utf8');
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const splitSource = { kind: 'piAgentDir' as const, agentDir, sessionFile: splitSessionFile };

    const olderPages: string[][] = [];
    let olderCursor: string | undefined;
    do {
      const page = await contribution.pageTranscript({
        ...invocation(),
        source: splitSource,
        remoteSessionId: 'pi-split-page',
        direction: 'older',
        ...(olderCursor ? { cursor: olderCursor } : {}),
        maxItems: 1,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.items).toHaveLength(1);
      olderPages.unshift(page.value.items.map((item) => item.id));
      olderCursor = page.value.nextCursor ?? undefined;
    } while (olderCursor);
    expect(olderPages.flat()).toEqual([
      'pi:pi-split-page:pi-split-assistant:thinking:0',
      'pi:pi-split-page:pi-split-assistant:text:1',
      'pi:pi-split-page:pi-split-assistant:toolCall:2',
      'pi:pi-split-page:pi-split-assistant:toolCall:3',
      'pi:pi-split-page:pi-split-follow-up',
    ]);

    const appendedSessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-split-read-after',
      createdAt: '2026-07-21T12:21:00.000Z',
      title: 'Split read-after Pi session',
    });
    const appendedSource = {
      kind: 'piAgentDir' as const,
      agentDir,
      sessionFile: appendedSessionFile,
    };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: appendedSource,
      remoteSessionId: 'pi-split-read-after',
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;
    await appendFile(appendedSessionFile, line({
      ...mixedAssistantEntry,
      id: 'pi-split-read-after-assistant',
      parentId: 'pi-split-read-after-title',
      timestamp: '2026-07-21T12:21:01.000Z',
    }) + line({
      ...trailingUserEntry,
      id: 'pi-split-read-after-follow-up',
      parentId: 'pi-split-read-after-assistant',
      timestamp: '2026-07-21T12:21:02.000Z',
    }));

    const appendedIds: string[] = [];
    let afterCursor = initial.value.tailCursor;
    for (let pageCount = 0; pageCount < 8; pageCount += 1) {
      const page = await contribution.readAfterTranscript({
        ...invocation(),
        source: appendedSource,
        remoteSessionId: 'pi-split-read-after',
        cursor: afterCursor,
        maxItems: 1,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      if (page.value.outcome === 'already_current') break;
      expect(page.value.outcome).toBe('advanced');
      if (page.value.outcome !== 'advanced') return;
      expect(page.value.items).toHaveLength(1);
      appendedIds.push(...page.value.items.map((item) => item.id));
      afterCursor = page.value.nextCursor;
    }
    expect(appendedIds).toEqual([
      'pi:pi-split-read-after:pi-split-read-after-assistant:thinking:0',
      'pi:pi-split-read-after:pi-split-read-after-assistant:text:1',
      'pi:pi-split-read-after:pi-split-read-after-assistant:toolCall:2',
      'pi:pi-split-read-after:pi-split-read-after-assistant:toolCall:3',
      'pi:pi-split-read-after:pi-split-read-after-follow-up',
    ]);
  });

  it('fails readAfter before advancing over unsupported Pi content', async () => {
    const { agentDir, sessionRoot } = await createAgentDir();
    const sessionFile = await createSessionFile({
      sessionRoot,
      sessionId: 'pi-unsupported-read-after',
      createdAt: '2026-07-21T12:25:00.000Z',
      title: 'Unsupported read-after Pi session',
    });
    const contribution = createPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'piAgentDir' as const, agentDir, sessionFile };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-unsupported-read-after',
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;
    await appendFile(sessionFile, line({
      type: 'message',
      id: 'pi-unsupported-read-after-entry',
      parentId: 'pi-unsupported-read-after-title',
      timestamp: '2026-07-21T12:25:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'image', source: { type: 'base64', data: 'not-supported-here' } }],
      },
    }));

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'pi-unsupported-read-after',
      cursor: initial.value.tailCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
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
