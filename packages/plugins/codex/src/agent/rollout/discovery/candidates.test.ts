import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

/**
 * The only mocked boundary is the filesystem itself, and every call still runs
 * the real `node:fs/promises` implementation underneath. The wrapper exists to
 * count the complete work one candidate chunk performs, which is the contract
 * under test: a chunk may not stat or open the whole rollout corpus.
 */
const fsCalls = vi.hoisted(() => ({ paths: [] as string[], recording: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const record = <TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => TResult,
  ) => (...args: TArgs): TResult => {
      if (fsCalls.recording) fsCalls.paths.push(`${name}:${String(args[0])}`);
      return fn(...args);
    };
  return {
    ...actual,
    default: actual,
    stat: record('stat', actual.stat),
    readdir: record('readdir', actual.readdir),
    open: record('open', actual.open),
    readFile: record('readFile', actual.readFile),
  };
});

const { appendFile, mkdir, mkdtemp, stat, writeFile, utimes } = await import('node:fs/promises');

const {
  compareCodexRolloutCandidateEntries,
  filterCodexRolloutCandidatesBySearchTerm,
  resolveCodexRolloutSearchCandidateLimit,
  scanCodexRolloutCandidateChunk,
  selectCodexRolloutCandidateEntries,
} = await import('./candidates.js');

function recordFsCalls(): () => string[] {
  fsCalls.paths.length = 0;
  fsCalls.recording = true;
  return () => {
    fsCalls.recording = false;
    return [...fsCalls.paths];
  };
}

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

describe('Codex rollout candidate discovery', () => {
  it('groups rollout files by provider session id and chooses earliest/latest by rollout filename chronology', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidates-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const groupedSessionId = '11111111-1111-1111-1111-111111111111';
    const archivedSessionId = '22222222-2222-2222-2222-222222222222';
    const flatSessionMetaId = 'flat-rollout-session-id';
    const earliest = join(sessionsDir, `rollout-2026-01-01T00-00-00-${groupedSessionId}.jsonl`);
    const latest = join(sessionsDir, `rollout-2026-01-02T00-00-00-${groupedSessionId}.jsonl`);
    const archived = join(archivedDir, `rollout-2026-01-03T00-00-00-${archivedSessionId}.jsonl`);
    const flat = join(sessionsDir, 'rollout-2026-01-04T00-00-00-manual-export.jsonl');

    await writeFile(earliest, sessionMetaLine({ id: groupedSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/old' }), 'utf8');
    await writeFile(latest, sessionMetaLine({ id: groupedSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/new' }), 'utf8');
    await writeFile(archived, sessionMetaLine({ id: archivedSessionId, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/archive' }), 'utf8');
    await writeFile(flat, sessionMetaLine({ id: flatSessionMetaId, timestamp: '2026-01-04T00:00:00.000Z', cwd: '/repo/flat' }), 'utf8');

    await utimes(earliest, new Date('2026-01-05T00:00:00.000Z'), new Date('2026-01-05T00:00:00.000Z'));
    await utimes(latest, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(archived, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(flat, new Date('2026-01-04T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    const selection = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
    });

    expect(selection.kind).toBe('direct');
    if (selection.kind !== 'direct') throw new Error('expected direct rollout selection');
    expect(selection.totalCount).toBe(3);
    expect(selection.entries.map((entry) => entry.remoteSessionId)).toEqual([
      groupedSessionId,
      'manual-export',
      archivedSessionId,
    ]);
    expect(selection.entries[0]?.group.latestFilePath).toBe(latest);
    expect(selection.entries[0]?.group.earliestFilePath).toBe(earliest);
    expect(selection.entries[0]?.group.updatedAtMs).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
    expect(selection.entries[0]?.group.archived).toBe(false);
    expect(selection.entries.find((entry) => entry.remoteSessionId === archivedSessionId)?.group.archived).toBe(true);
  });

  it('applies provider filename-search policy before falling back to candidate metadata search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-search-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const rollout = join(sessionsDir, `rollout-2026-02-01T00-00-00-${sessionId}.jsonl`);
    await writeFile(rollout, sessionMetaLine({ id: sessionId, timestamp: '2026-02-01T00:00:00.000Z', cwd: '/repo/search' }), 'utf8');

    const exact = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: sessionId,
      searchMode: 'fast',
    });
    expect(exact).toEqual(expect.objectContaining({
      kind: 'direct',
      buildMode: 'knownRolloutFiles',
      totalCount: 1,
    }));

    const filenamePrefix = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: '2026-02',
      searchMode: 'fast',
    });
    expect(filenamePrefix).toEqual(expect.objectContaining({
      kind: 'direct',
      buildMode: 'sessionStore',
      searchIncomplete: true,
    }));

    const metadataSearch = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: 'repo search',
      searchMode: 'full',
    });
    expect(metadataSearch.kind).toBe('candidateSearch');
  });

  async function writeReverseChronologyCorpus(root: string): Promise<Readonly<{
    codexHome: string;
    byLastActivity: readonly string[];
  }>> {
    const codexHome = join(root, 'codex-home');
    const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
    await mkdir(dayDir, { recursive: true });
    // Rollout filenames carry the CREATION timestamp; mtime is last activity.
    // A resumed session keeps its old filename while its mtime moves forward,
    // so this corpus makes filename order the exact reverse of activity order.
    const rows = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', fileTime: '10-00-00', mtime: '2026-07-23T11:00:00.000Z' },
      { id: 'bbbbbbbb-0000-0000-0000-000000000002', fileTime: '09-00-00', mtime: '2026-07-23T12:00:00.000Z' },
      { id: 'cccccccc-0000-0000-0000-000000000003', fileTime: '08-00-00', mtime: '2026-07-23T13:00:00.000Z' },
      { id: 'dddddddd-0000-0000-0000-000000000004', fileTime: '07-00-00', mtime: '2026-07-23T14:00:00.000Z' },
    ] as const;
    for (const row of rows) {
      const filePath = join(dayDir, `rollout-2026-07-23T${row.fileTime}-${row.id}.jsonl`);
      await writeFile(
        filePath,
        sessionMetaLine({
          id: row.id,
          timestamp: `2026-07-23T${row.fileTime.replaceAll('-', ':')}.000Z`,
          cwd: '/repo/reverse-chronology',
        }),
        'utf8',
      );
      await utimes(filePath, new Date(row.mtime), new Date(row.mtime));
    }
    return {
      codexHome,
      byLastActivity: [...rows]
        .sort((left, right) => Date.parse(right.mtime) - Date.parse(left.mtime))
        .map((row) => row.id),
    };
  }

  async function writeWideCorpus(root: string, days: number, perDay: number): Promise<Readonly<{
    codexHome: string;
    totalFiles: number;
  }>> {
    const codexHome = join(root, 'codex-home');
    for (let day = 1; day <= days; day += 1) {
      const dayLabel = String(day).padStart(2, '0');
      const dayDir = join(codexHome, 'sessions', '2026', '05', dayLabel);
      await mkdir(dayDir, { recursive: true });
      for (let index = 0; index < perDay; index += 1) {
        const id = `${dayLabel}${String(index).padStart(6, '0')}-0000-0000-0000-000000000000`;
        await writeFile(
          join(dayDir, `rollout-2026-05-${dayLabel}T00-00-${String(index % 60).padStart(2, '0')}-${id}.jsonl`),
          sessionMetaLine({ id, timestamp: `2026-05-${dayLabel}T00:00:00.000Z`, cwd: '/repo/wide' }),
          'utf8',
        );
      }
    }
    await mkdir(join(codexHome, 'archived_sessions'), { recursive: true });
    return { codexHome, totalFiles: days * perDay };
  }

  it('bounds the complete work of one candidate chunk instead of scanning the whole corpus', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-bounded-'));
    const { codexHome, totalFiles } = await writeWideCorpus(root, 12, 40);
    const limit = 25;

    const stopRecording = recordFsCalls();
    const chunk = await scanCodexRolloutCandidateChunk({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit,
    });
    const calls = stopRecording();

    expect(chunk.entries).toHaveLength(limit);
    expect(chunk.nextBoundary).not.toBeNull();
    // Complete work, not just file-content opens: every touch of a rollout file
    // counts, whether it is statted for last activity or opened for its head.
    // The bound is the set of DISTINCT rollout files the chunk touches, because
    // a returned row is legitimately statted for activity and then head-read for
    // its title; what may never happen is touching a file the chunk does not
    // return.
    const rolloutTouches = calls.filter((call) => call.endsWith('.jsonl'));
    const rolloutFilesTouched = new Set(
      rolloutTouches.map((call) => call.slice(call.indexOf(':') + 1)),
    );
    expect(rolloutFilesTouched.size).toBeLessThanOrEqual(limit);
    expect(rolloutFilesTouched.size).toBeLessThan(totalFiles);
    expect(rolloutTouches.length).toBeLessThanOrEqual(limit * 4);
    // Directory work stays proportional to the day containers, not to the files
    // inside them, and the chunk only reads containers up to its own boundary.
    expect(calls.filter((call) => call.startsWith('readdir:')).length).toBeLessThanOrEqual(20);
  });

  it('continues the bounded scan without duplicating or skipping candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-scan-pages-'));
    const { codexHome, byLastActivity } = await writeReverseChronologyCorpus(root);

    const request = {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 2,
    } as const;

    const first = await scanCodexRolloutCandidateChunk(request);
    expect(first.entries).toHaveLength(2);
    expect(first.scanned).toBe(2);
    if (!first.nextBoundary) throw new Error('expected a candidate scan boundary');

    const second = await scanCodexRolloutCandidateChunk({ ...request, after: first.nextBoundary });
    expect(second.nextBoundary).toBeNull();
    // The host proves a build advanced from strictly increasing scan progress.
    expect(second.scanned).toBeGreaterThan(first.scanned);
    expect(second.scanned).toBe(4);

    const observed = [...first.entries, ...second.entries];
    expect(observed).toHaveLength(4);
    expect(new Set(observed.map((entry) => entry.remoteSessionId)).size).toBe(4);
    // The chunks are exact: sorted by the single candidate ordering rule the host
    // index applies, they reproduce the whole corpus in last-activity order.
    expect(
      [...observed].sort(compareCodexRolloutCandidateEntries).map((entry) => entry.remoteSessionId),
    ).toEqual(byLastActivity);
  });

  it('keeps a mid-scan resume from restarting the candidate build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-append-'));
    const { codexHome } = await writeReverseChronologyCorpus(root);
    const dayDir = join(codexHome, 'sessions', '2026', '07', '23');

    const request = {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 2,
    } as const;

    const first = await scanCodexRolloutCandidateChunk(request);
    if (!first.nextBoundary) throw new Error('expected a candidate scan boundary');

    // A session the first chunk has not reached yet is resumed mid-browse: its
    // rollout gains a line, so its last activity moves ahead of everything scanned.
    const appendedSessionId = 'dddddddd-0000-0000-0000-000000000004';
    const appendedPath = join(dayDir, `rollout-2026-07-23T07-00-00-${appendedSessionId}.jsonl`);
    const dayDirBefore = await stat(dayDir);
    await appendFile(
      appendedPath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'resumed' } })}\n`,
      'utf8',
    );
    await utimes(appendedPath, new Date('2026-07-23T15:00:00.000Z'), new Date('2026-07-23T15:00:00.000Z'));
    expect((await stat(dayDir)).mtimeMs).toBe(dayDirBefore.mtimeMs);

    const second = await scanCodexRolloutCandidateChunk({ ...request, after: first.nextBoundary });

    // A traversal cursor is not keyed on the mutated value, so the resume neither
    // loses the session nor invalidates the build: a per-file mtime fence would
    // restart the whole multi-chunk index on any live Codex turn.
    expect(second.sourceChanged).toBeUndefined();
    expect(
      [...first.entries, ...second.entries].map((entry) => entry.remoteSessionId),
    ).toContain(appendedSessionId);
    expect(
      [...first.entries, ...second.entries].find((entry) => entry.remoteSessionId === appendedSessionId)
        ?.group.updatedAtMs,
    ).toBe(Date.parse('2026-07-23T15:00:00.000Z'));
  });

  it('fences the scan cursor when the container it resumes from changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-fence-'));
    const { codexHome } = await writeReverseChronologyCorpus(root);
    const dayDir = join(codexHome, 'sessions', '2026', '07', '23');

    const request = {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 2,
    } as const;

    const first = await scanCodexRolloutCandidateChunk(request);
    if (!first.nextBoundary) throw new Error('expected a candidate scan boundary');

    const addedId = 'eeeeeeee-0000-0000-0000-000000000005';
    await writeFile(
      join(dayDir, `rollout-2026-07-23T06-00-00-${addedId}.jsonl`),
      sessionMetaLine({ id: addedId, timestamp: '2026-07-23T06:00:00.000Z', cwd: '/repo/added' }),
      'utf8',
    );

    const second = await scanCodexRolloutCandidateChunk({ ...request, after: first.nextBoundary });
    expect(second.sourceChanged).toBe(true);
    expect(second.entries).toEqual([]);
  });

  it('survives a new rollout in a day directory the cursor does not resume from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-active-install-'));
    const codexHome = join(root, 'codex-home');
    // Three day containers. Traversal is newest-container-first, so a cursor that
    // stops inside 07/23 has already passed 07/24 and has not yet reached 07/22.
    const days = ['22', '23', '24'] as const;
    for (const day of days) {
      const dayDir = join(codexHome, 'sessions', '2026', '07', day);
      await mkdir(dayDir, { recursive: true });
      for (let index = 0; index < 2; index += 1) {
        const id = `${day}${String(index)}00000-0000-0000-0000-000000000000`;
        await writeFile(
          join(dayDir, `rollout-2026-07-${day}T0${index}-00-00-${id}.jsonl`),
          sessionMetaLine({ id, timestamp: `2026-07-${day}T0${index}:00:00.000Z`, cwd: '/repo/active' }),
          'utf8',
        );
      }
    }

    const request = {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 3,
    } as const;

    const first = await scanCodexRolloutCandidateChunk(request);
    const boundary = first.nextBoundary;
    if (!boundary) throw new Error('expected a candidate scan boundary');
    expect(boundary.containerKey).toContain('2026/07/23');

    // Codex keeps running while the multi-chunk build is in flight: a brand-new
    // session lands in a day directory this cursor is not resuming from. That
    // container defines no part of the resume point, so it may not discard the
    // build — otherwise an actively used install never converges.
    for (const day of ['22', '24'] as const) {
      const id = `${day}9999999-0000-0000-0000-000000000000`;
      await writeFile(
        join(codexHome, 'sessions', '2026', '07', day, `rollout-2026-07-${day}T09-00-00-${id}.jsonl`),
        sessionMetaLine({ id, timestamp: `2026-07-${day}T09:00:00.000Z`, cwd: '/repo/live' }),
        'utf8',
      );
    }

    const second = await scanCodexRolloutCandidateChunk({ ...request, after: boundary });
    expect(second.sourceChanged).toBeUndefined();
    expect(second.scanned).toBeGreaterThan(first.scanned);
    // The not-yet-reached container's new row is simply picked up by the scan.
    expect(second.entries.map((entry) => entry.remoteSessionId))
      .toContain('229999999-0000-0000-0000-000000000000');

    // The genuine fence is intact: a mutation INSIDE the resume container still
    // invalidates typed, because the cursor's own anchor may have moved.
    const insideId = '239999999-0000-0000-0000-000000000000';
    await writeFile(
      join(codexHome, 'sessions', '2026', '07', '23', `rollout-2026-07-23T09-00-00-${insideId}.jsonl`),
      sessionMetaLine({ id: insideId, timestamp: '2026-07-23T09:00:00.000Z', cwd: '/repo/live' }),
      'utf8',
    );
    const fenced = await scanCodexRolloutCandidateChunk({ ...request, after: boundary });
    expect(fenced.sourceChanged).toBe(true);
    expect(fenced.entries).toEqual([]);
  });

  it('carries the first user message of each returned row as its candidate title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-title-'));
    const codexHome = join(root, 'codex-home');
    const dayDir = join(codexHome, 'sessions', '2026', '07', '25');
    await mkdir(dayDir, { recursive: true });
    const titledId = 'aaaaaaaa-0000-0000-0000-00000000000a';
    await writeFile(
      join(dayDir, `rollout-2026-07-25T10-00-00-${titledId}.jsonl`),
      [
        sessionMetaLine({ id: titledId, timestamp: '2026-07-25T10:00:00.000Z', cwd: '/repo/titled' }),
        // Real rollouts lead with harness boilerplate; the title is the first
        // genuine user message, which is immutable once the session exists.
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>cwd=/repo/titled</environment_context>' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the login redirect loop' }],
          },
        })}\n`,
      ].join(''),
      'utf8',
    );
    const untitledId = 'bbbbbbbb-0000-0000-0000-00000000000b';
    await writeFile(
      join(dayDir, `rollout-2026-07-25T09-00-00-${untitledId}.jsonl`),
      sessionMetaLine({ id: untitledId, timestamp: '2026-07-25T09:00:00.000Z', cwd: '/repo/untitled' }),
      'utf8',
    );

    const chunk = await scanCodexRolloutCandidateChunk({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
    });

    expect(
      chunk.entries.find((entry) => entry.remoteSessionId === titledId)?.title,
    ).toBe('Fix the login redirect loop');
    // A row with no usable title stays identifier-only rather than inventing one.
    expect(
      chunk.entries.find((entry) => entry.remoteSessionId === untitledId)?.title,
    ).toBeUndefined();
  });

  it('orders scanned candidates by UTF-16 code unit rather than ICU collation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-collation-'));
    const codexHome = join(root, 'codex-home');
    const dayDir = join(codexHome, 'sessions', '2026', '07', '24');
    await mkdir(dayDir, { recursive: true });

    // Codex provider ids are not guaranteed UUIDs: both filename parsing and
    // `session_meta.id` accept arbitrary ids. ICU collation orders these two ids the
    // opposite way from UTF-16 code units, which is the order the host candidate
    // index sorts and validates with.
    const ids = ['codex-session-2', 'codex_session-1'] as const;
    expect(ids[0].localeCompare(ids[1])).toBeGreaterThan(0);
    const byCodeUnit = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(byCodeUnit[0]).toBe(ids[0]);

    for (const id of ids) {
      const filePath = join(dayDir, `rollout-2026-07-24T10-00-00-${id}.jsonl`);
      await writeFile(
        filePath,
        sessionMetaLine({ id, timestamp: '2026-07-24T10:00:00.000Z', cwd: '/repo/collation' }),
        'utf8',
      );
      // Identical last activity, so the provider-id tie-break alone decides order.
      await utimes(filePath, new Date('2026-07-24T12:00:00.000Z'), new Date('2026-07-24T12:00:00.000Z'));
    }

    const chunk = await scanCodexRolloutCandidateChunk({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
    });
    expect(chunk.entries.map((entry) => entry.remoteSessionId)).toEqual([...byCodeUnit]);
  });

  it('filters searchable candidates and clamps provider search limits from env', () => {
    const candidates = filterCodexRolloutCandidatesBySearchTerm({
      searchTerm: 'frontend',
      candidates: [
        { remoteSessionId: 'session-a', title: 'Backend work', details: { cwd: '/workspace/backend' } },
        { remoteSessionId: 'session-b', title: 'Frontend shell', details: { cwd: '/workspace/app' } },
      ],
    });

    expect(candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['session-b']);
    expect(resolveCodexRolloutSearchCandidateLimit({
      env: { HAPPIER_CODEX_EXTERNAL_SESSIONS_FAST_SEARCH_CANDIDATE_LIMIT: '0' },
      searchMode: 'fast',
    })).toBe(200);
    expect(resolveCodexRolloutSearchCandidateLimit({
      env: { HAPPIER_CODEX_EXTERNAL_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT: '999999' },
      searchMode: 'full',
    })).toBe(25_000);
  });
});
