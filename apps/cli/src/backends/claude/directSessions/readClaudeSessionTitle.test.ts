import { appendFile, mkdir, mkdtemp, rename, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').open>());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => openMock(...args) };
});

import { readClaudeSessionTitle } from './readClaudeSessionTitle';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('readClaudeSessionTitle', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    openMock.mockReset();
    openMock.mockImplementation(actual.open);
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
    const bytesRead = async () => {
      let total = 0;
      for (const handle of handles) {
        for (const result of vi.mocked(handle.read).mock.results) {
          if (result.type === 'return') total += (await result.value).bytesRead;
        }
      }
      return total;
    };

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
});
