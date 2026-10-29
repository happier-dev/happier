import { appendFile, mkdir, mkdtemp, rename, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').open>());
const readFileMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').readFile>());
const writeFileMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').writeFile>());
const renameMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').rename>());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => openMock(...args),
    readFile: (...args: Parameters<typeof actual.readFile>) => readFileMock(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => writeFileMock(...args),
    rename: (...args: Parameters<typeof actual.rename>) => renameMock(...args),
  };
});

import { readClaudeSessionTitle } from './readClaudeSessionTitle';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function instrumentTranscriptReads(filePath: string): Promise<() => Promise<number>> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handles: FileHandle[] = [];
  openMock.mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (String(args[0]) === filePath) {
      // Instrument the OS boundary while retaining real reads and both JSONL readers.
      vi.spyOn(handle, 'read');
      handles.push(handle);
    }
    return handle;
  });
  return async () => {
    let total = 0;
    for (const handle of handles) {
      for (const result of vi.mocked(handle.read).mock.results) {
        if (result.type === 'return') total += (await result.value).bytesRead;
      }
    }
    return total;
  };
}

async function createTitleCacheFixture(options: Readonly<{ happierHome?: string; lifecycleScope?: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-cache-failure-'));
  vi.stubEnv('HAPPIER_HOME_DIR', options.happierHome ?? join(root, 'happier'));
  if (options.lifecycleScope) vi.stubEnv('HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID', options.lifecycleScope);
  vi.resetModules();
  const [reader, { configuration }, { logger }] = await Promise.all([
    import('./readClaudeSessionTitle'),
    import('@/configuration'),
    import('@/utils/logger'),
  ]);
  const filePath = join(root, 'session-one.jsonl');
  await writeFile(filePath, jsonlLine({ type: 'custom-title', customTitle: 'Cached title' }), 'utf8');
  return {
    ...reader,
    filePath,
    cachePath: join(dirname(configuration.daemonStateFile), 'claude-direct-session-titles.json'),
    // Observe the file logging boundary without replacing its implementation.
    warning: vi.spyOn(logger, 'warnFile'),
  };
}

describe('readClaudeSessionTitle', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    openMock.mockReset();
    openMock.mockImplementation(actual.open);
    readFileMock.mockReset();
    readFileMock.mockImplementation(actual.readFile);
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(actual.writeFile);
    renameMock.mockReset();
    renameMock.mockImplementation(actual.rename);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prefers the latest custom title over newer AI snapshots across tail pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-precedence-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, [
      jsonlLine({ type: 'custom-title', customTitle: 'Old rename' }),
      jsonlLine({ type: 'custom-title', customTitle: 'Manual title' }),
      ...Array.from({ length: 520 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(4_096) })),
      jsonlLine({ type: 'ai-title', aiTitle: 'Older AI title' }),
      jsonlLine({ type: 'ai-title', aiTitle: 'Newest AI title' }),
    ].join(''), 'utf8');

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Manual title');
  });

  it('uses the latest AI title after a custom title is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-cleared-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, [
      jsonlLine({ type: 'custom-title', customTitle: 'Old rename' }),
      jsonlLine({ type: 'ai-title', aiTitle: 'Latest AI title' }),
      jsonlLine({ type: 'custom-title', customTitle: '   ' }),
    ].join(''), 'utf8');

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Latest AI title');
  });

  it.each([
    ['ai-title', 'aiTitle', 'AI-generated Claude title'],
    ['custom-title', 'customTitle', 'Renamed Claude session'],
  ] as const)('prefers a late %s record over the first user message', async (type, titleKey, expectedTitle) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-provider-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'user',
          uuid: 'first-user',
          message: { content: 'Initial user prompt' },
        }),
        ...Array.from({ length: 520 }, (_, index) => jsonlLine({
          type: 'progress',
          uuid: `progress-${index}`,
        })),
        jsonlLine({
          type,
          [titleKey]: expectedTitle,
          sessionId: 'session-one',
        }),
        ...Array.from({ length: 80 }, (_, index) => jsonlLine({
          type: 'progress',
          uuid: `tail-progress-${index}`,
        })),
      ].join(''),
      'utf8',
    );

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe(expectedTitle);
  });

  it('uses the newest Claude title record when a session is renamed more than once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-newest-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    await writeFile(
      filePath,
      [
        jsonlLine({ type: 'custom-title', customTitle: 'First rename', sessionId: 'session-one' }),
        jsonlLine({ type: 'custom-title', customTitle: 'Newest rename', sessionId: 'session-one' }),
      ].join(''),
      'utf8',
    );

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Newest rename');
  });

  it('scans past non-title-bearing leading records until it finds meaningful user text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    const meaningfulTask = 'Validate infinite scrolling for direct Claude transcripts without dropping tool lines';

    const lines = [
      ...Array.from({ length: 80 }, (_, index) =>
        jsonlLine({
          type: 'user',
          uuid: `image-${index}`,
          cwd: '/repo/two',
          message: {
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'AAAA',
                },
              },
            ],
          },
        }),
      ),
      jsonlLine({
        type: 'user',
        uuid: 'actual-user-text',
        cwd: '/repo/two',
        message: { content: meaningfulTask },
      }),
    ];

    await writeFile(filePath, lines.join(''), 'utf8');

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe(meaningfulTask);
  });

  it('falls back to queued prompt content when the transcript never materializes a user message record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-queue-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    const queuedPrompt = 'hello from queued direct Claude session';

    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'session-one',
          content: queuedPrompt,
        }),
        jsonlLine({
          type: 'queue-operation',
          operation: 'dequeue',
          sessionId: 'session-one',
        }),
      ].join(''),
      'utf8',
    );

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe(queuedPrompt);
  });

  it('avoids reading the full transcript again for unchanged files and appended records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-incremental-'));
    const filePath = join(root, 'session-one.jsonl');
    const transcript = [
      jsonlLine({ type: 'user', message: { content: 'Initial user prompt' } }),
      jsonlLine({ type: 'ai-title', aiTitle: 'AI title' }),
      ...Array.from({ length: 520 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(4_096) })),
    ].join('');
    await writeFile(filePath, transcript, 'utf8');
    const transcriptBytes = Buffer.byteLength(transcript);
    const bytesRead = await instrumentTranscriptReads(filePath);

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
    const coldBytes = await bytesRead();
    expect(coldBytes).toBeGreaterThanOrEqual(transcriptBytes);

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
    const unchangedBytes = await bytesRead();
    expect(unchangedBytes - coldBytes).toBeLessThan(transcriptBytes / 10);

    await appendFile(filePath, jsonlLine({ type: 'progress', data: 'Appended progress' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
    const appendedBytes = (await bytesRead()) - unchangedBytes;
    expect(appendedBytes).toBeGreaterThan(0);
    expect(appendedBytes).toBeLessThan(transcriptBytes / 10);
  });

  it('keeps title precedence while a transcript keeps growing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-growing-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, [
      jsonlLine({ type: 'user', message: { content: 'Initial user prompt' } }),
      jsonlLine({ type: 'ai-title', aiTitle: 'First AI title' }),
    ].join(''), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('First AI title');

    await appendFile(filePath, jsonlLine({ type: 'custom-title', customTitle: 'Manual title' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Manual title');

    await appendFile(filePath, jsonlLine({ type: 'ai-title', aiTitle: 'Newer AI title' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Manual title');

    await appendFile(filePath, jsonlLine({ type: 'custom-title', customTitle: '   ' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Newer AI title');
  });

  it('sees a title record that was still being written during the previous read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-partial-'));
    const filePath = join(root, 'session-one.jsonl');
    const pendingRecord = jsonlLine({ type: 'custom-title', customTitle: 'Renamed while reading' });
    await writeFile(filePath, [
      jsonlLine({ type: 'ai-title', aiTitle: 'AI title' }),
      pendingRecord.slice(0, 20),
    ].join(''), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');

    await appendFile(filePath, pendingRecord.slice(20), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Renamed while reading');
  });

  it('sees a rename appended after a record too large to read incrementally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-oversized-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, jsonlLine({ type: 'ai-title', aiTitle: 'AI title' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');

    await appendFile(filePath, [
      jsonlLine({ type: 'progress', data: 'x'.repeat(9 * 1024 * 1024) }),
      jsonlLine({ type: 'custom-title', customTitle: 'Renamed after a huge record' }),
    ].join(''), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Renamed after a huge record');
  });

  it('parses only title-bearing records while scanning a transcript tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-prefilter-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, [
      jsonlLine({ type: 'user', message: { content: 'Initial user prompt' } }),
      jsonlLine({ type: 'ai-title', aiTitle: 'AI title' }),
      jsonlLine({ type: 'user', message: { content: 'What does an "ai-title" record look like?' } }),
      ...Array.from({ length: 520 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(4_096) })),
    ].join(''), 'utf8');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
      expect(parse.mock.calls.length).toBeLessThan(10);
    } finally {
      parse.mockRestore();
    }
  });

  it('reuses titles resolved by a previous daemon process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-persisted-'));
    const filePath = join(root, 'session-one.jsonl');
    const transcript = [
      jsonlLine({ type: 'user', message: { content: 'Initial user prompt' } }),
      jsonlLine({ type: 'ai-title', aiTitle: 'AI title' }),
      ...Array.from({ length: 520 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(4_096) })),
    ].join('');
    await writeFile(filePath, transcript, 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
    const { flushClaudeTitleCache } = await import('./readClaudeSessionTitle');
    await flushClaudeTitleCache();

    vi.resetModules();
    const restarted = await import('./readClaudeSessionTitle');
    const bytesRead = await instrumentTranscriptReads(filePath);
    await expect(restarted.readClaudeSessionTitle(filePath)).resolves.toBe('AI title');
    await appendFile(filePath, jsonlLine({ type: 'custom-title', customTitle: 'Renamed after restart' }), 'utf8');
    await expect(restarted.readClaudeSessionTitle(filePath)).resolves.toBe('Renamed after restart');
    expect(await bytesRead()).toBeLessThan(Buffer.byteLength(transcript) / 10);
  });

  it('rereads a transcript that was rewritten or replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-rewrite-'));
    const filePath = join(root, 'session-one.jsonl');
    await writeFile(filePath, jsonlLine({ type: 'custom-title', customTitle: 'Original title' }), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Original title');

    await truncate(filePath, 0);
    await appendFile(filePath, [
      jsonlLine({ type: 'ai-title', aiTitle: 'Rewritten AI title' }),
      jsonlLine({ type: 'progress', data: 'x'.repeat(256) }),
    ].join(''), 'utf8');
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Rewritten AI title');

    const replacement = join(root, 'replacement.jsonl');
    await writeFile(replacement, jsonlLine({ type: 'custom-title', customTitle: 'Replaced title' }), 'utf8');
    await rename(replacement, filePath);
    await expect(readClaudeSessionTitle(filePath)).resolves.toBe('Replaced title');
  });

  it('reports an unexpected cache read failure and rebuilds the cache from the transcript', async () => {
    const fixture = await createTitleCacheFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const failure = Object.assign(new Error('Cache read denied'), { code: 'EACCES' });
    readFileMock.mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.cachePath) throw failure;
      return actual.readFile(...args);
    });

    await expect(fixture.readClaudeSessionTitle(fixture.filePath)).resolves.toBe('Cached title');
    expect(fixture.warning).toHaveBeenCalledWith(expect.stringContaining('cache'), { code: 'EACCES' });

    readFileMock.mockImplementation(actual.readFile);
    await fixture.flushClaudeTitleCache();
    expect(JSON.parse(await actual.readFile(fixture.cachePath, 'utf8'))).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([[fixture.filePath, expect.objectContaining({ customTitle: 'Cached title' })]]),
    }));
  });

  it('preserves each daemon lifecycle scope cache across interleaved flushes and restart', async () => {
    const happierHome = await mkdtemp(join(tmpdir(), 'happier-claude-shared-home-'));
    const scopeA = await createTitleCacheFixture({ happierHome, lifecycleScope: 'relay-a' });
    const transcript = jsonlLine({ type: 'custom-title', customTitle: 'Scope A title' })
      + Array.from({ length: 520 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(4096) })).join('');
    await writeFile(scopeA.filePath, transcript, 'utf8');
    await expect(scopeA.readClaudeSessionTitle(scopeA.filePath)).resolves.toBe('Scope A title');
    expect(scopeA.warning).not.toHaveBeenCalled();

    // Both daemon maps load before either publishes, then each writes its own map.
    const scopeB = await createTitleCacheFixture({ happierHome, lifecycleScope: 'relay-b' });
    await expect(scopeB.readClaudeSessionTitle(scopeB.filePath)).resolves.toBe('Cached title');
    expect(scopeB.warning).not.toHaveBeenCalled();
    await scopeA.flushClaudeTitleCache();
    await scopeB.flushClaudeTitleCache();

    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    for (const scope of [scopeA, scopeB]) {
      expect(JSON.parse(await actual.readFile(scope.cachePath, 'utf8'))).toMatchObject({
        entries: [[scope.filePath, expect.any(Object)]],
      });
    }

    const restarted = await createTitleCacheFixture({ happierHome, lifecycleScope: 'relay-a' });
    const bytesRead = await instrumentTranscriptReads(scopeA.filePath);
    await expect(restarted.readClaudeSessionTitle(scopeA.filePath)).resolves.toBe('Scope A title');
    expect(await bytesRead()).toBeLessThan(Buffer.byteLength(transcript) / 10);
  });

  it('rebuilds a missing cache without warning', async () => {
    const fixture = await createTitleCacheFixture();
    await expect(fixture.readClaudeSessionTitle(fixture.filePath)).resolves.toBe('Cached title');
    expect(fixture.warning).not.toHaveBeenCalled();
    await fixture.flushClaudeTitleCache();
  });

  it('reports malformed cache data without logging cached title content', async () => {
    const fixture = await createTitleCacheFixture();
    await mkdir(dirname(fixture.cachePath), { recursive: true });
    await writeFile(fixture.cachePath, '{"private-title":"sensitive cached text",invalid}', 'utf8');

    await expect(fixture.readClaudeSessionTitle(fixture.filePath)).resolves.toBe('Cached title');
    expect(fixture.warning).toHaveBeenCalledWith(expect.stringContaining('cache'), { code: null });
    expect(JSON.stringify(fixture.warning.mock.calls)).not.toContain('sensitive cached text');
    await fixture.flushClaudeTitleCache();
  });

  it.each(['write', 'rename'] as const)('reports a failed cache %s and retries publication without another transcript change', async (operation) => {
    const fixture = await createTitleCacheFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await expect(fixture.readClaudeSessionTitle(fixture.filePath)).resolves.toBe('Cached title');
    const failure = Object.assign(new Error(`Cache ${operation} failed`), { code: 'EIO' });
    if (operation === 'write') {
      writeFileMock.mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(`${fixture.cachePath}.`)) throw failure;
        return actual.writeFile(...args);
      });
    } else {
      renameMock.mockImplementation(async (...args) => {
        if (String(args[1]) === fixture.cachePath) throw failure;
        return actual.rename(...args);
      });
    }

    await expect(fixture.flushClaudeTitleCache()).resolves.toBeUndefined();
    expect.soft(fixture.warning).toHaveBeenCalledWith(expect.stringContaining('cache'), { code: 'EIO' });
    expect.soft((await actual.readdir(dirname(fixture.cachePath))).filter((name) => name.startsWith(`${basename(fixture.cachePath)}.`)))
      .toEqual([]);

    writeFileMock.mockImplementation(actual.writeFile);
    renameMock.mockImplementation(actual.rename);
    await fixture.flushClaudeTitleCache();
    expect(JSON.parse(await actual.readFile(fixture.cachePath, 'utf8'))).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([[fixture.filePath, expect.objectContaining({ customTitle: 'Cached title' })]]),
    }));
  });
});
