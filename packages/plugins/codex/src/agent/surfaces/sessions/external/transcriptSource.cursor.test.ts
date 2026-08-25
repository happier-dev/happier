import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeCodexExternalBackwardCursor,
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
} from './transcriptSource.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rollout(params: Readonly<{
  remoteSessionId: string;
  rootSessionId?: string;
  timestamp: string;
  messages: readonly string[];
}>): string {
  return [
    jsonl({
      type: 'session_meta',
      timestamp: params.timestamp,
      payload: {
        id: params.remoteSessionId,
        ...(params.rootSessionId ? { session_id: params.rootSessionId } : {}),
        timestamp: params.timestamp,
        cwd: '/repo/codex-transcript-cursor',
      },
    }),
    ...params.messages.map((message, index) => jsonl({
      type: 'response_item',
      timestamp: new Date(Date.parse(params.timestamp) + (index + 1) * 1_000).toISOString(),
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: message }],
      },
    })),
  ].join('');
}

function largeAppendOrientedRollout(params: Readonly<{
  remoteSessionId: string;
  timestamp: string;
}>): string {
  return rollout({
    ...params,
    messages: [
      `sampled-prefix-A${'p'.repeat(5 * 1024)}`,
      `unsampled-interior-${'i'.repeat(12 * 1024)}`,
      `${'b'.repeat(5 * 1024)}prior-watermark-boundary-X`,
      'newest cursor boundary',
    ],
  });
}

async function createFixture(): Promise<Readonly<{
  root: string;
  codexHome: string;
  dayDir: string;
  remoteSessionId: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-transcript-cursor-'));
  const codexHome = join(root, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
  await mkdir(dayDir, { recursive: true });
  return {
    root,
    codexHome,
    dayDir,
    remoteSessionId: '11111111-1111-1111-1111-111111111111',
  };
}

function sourceParams(fixture: Readonly<{
  root: string;
  codexHome: string;
  remoteSessionId: string;
}>) {
  return {
    source: { kind: 'codexHome', home: 'user' } as const,
    activeServerDir: join(fixture.root, 'active-server'),
    env: { CODEX_HOME: fixture.codexHome } as NodeJS.ProcessEnv,
    remoteSessionId: fixture.remoteSessionId,
  };
}

/**
 * A canonical page legitimately mixes assistant message rows with the parent
 * `SubAgent` tool-call row that anchors a child thread, so membership checks
 * read the message text as an option instead of demanding one from every row.
 */
function readTranscriptItemMessage(item: Readonly<{ raw: unknown }>): string | null {
  const raw = item.raw as Readonly<{
    content?: Readonly<{ data?: Readonly<{ message?: unknown }> }>;
  }>;
  const message = raw.content?.data?.message;
  return typeof message === 'string' ? message : null;
}

function transcriptItemText(item: Readonly<{ raw: unknown }>): string {
  const message = readTranscriptItemMessage(item);
  if (message === null) throw new Error('Expected a Codex agent message item');
  return message;
}

function decodeCursorRecord(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function encodeCursorRecord(cursor: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSingleStreamCursor(cursor: string): Record<string, unknown> {
  const record = decodeCursorRecord(cursor);
  const streams = Array.isArray(record.streams) ? record.streams : [];
  if (
    streams.length !== 1
    || !streams[0]
    || typeof streams[0] !== 'object'
    || Array.isArray(streams[0])
  ) {
    throw new Error('Expected one Codex rollout cursor stream');
  }
  return streams[0] as Record<string, unknown>;
}

describe('Codex external transcript cursor generations', () => {
  it('rejects empty anchored backward vectors', () => {
    expect(decodeCodexExternalBackwardCursor(encodeCursorRecord({
      v: 5,
      kind: 'codexBackwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [],
    }))).toBeNull();
  });

  it('rejects writer-impossible backward watermark offsets', () => {
    expect(decodeCodexExternalBackwardCursor(encodeCursorRecord({
      v: 5,
      kind: 'codexBackwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [{
        fileRelPath: 'sessions/2026/07/23/rollout-session.jsonl',
        physicalGeneration: '1:2:3',
        endOffsetBytes: 42,
        fingerprintOffsetBytes: 84,
        contentFingerprint: 'a'.repeat(64),
      }],
    }))).toBeNull();
  });

  it('reports an unavailable source when neither rollout streams nor app-server metadata exist', async () => {
    const fixture = await createFixture();
    try {
      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: 'tail',
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toEqual({
        items: [],
        nextCursor: null,
        tailCursor: null,
        truncated: false,
        readAfterOutcome: 'source_unavailable',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable source when a released app-server cursor loses its metadata', async () => {
    const fixture = await createFixture();
    try {
      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: 'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toEqual({
        items: [],
        nextCursor: null,
        tailCursor: null,
        truncated: false,
        readAfterOutcome: 'source_unavailable',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports already current when the same rollout source still exists without newer items', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['current source fixture'],
        }),
        'utf8',
      );
      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: 'tail',
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        readAfterOutcome: 'already_current',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when a previously missing archived-sessions root appears', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['current source fixture'],
        }),
        'utf8',
      );
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: null,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a Codex tail cursor');
      const initialCursor = decodeCursorRecord(initial.tailCursor);
      expect(initialCursor.sourceGeneration).toContain('missing');

      await mkdir(join(fixture.codexHome, 'archived_sessions'));

      const after = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      expect(after).toMatchObject({
        items: [],
        tailCursor: expect.any(String),
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });
      const replacementCursor = decodeCursorRecord(after.tailCursor ?? '');
      expect(replacementCursor.sourceGeneration).not.toEqual(initialCursor.sourceGeneration);
      expect(replacementCursor.streams).toEqual(initialCursor.streams);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows canonical non-transcript metadata to advance with visible items', async () => {
    const fixture = await createFixture();
    try {
      const rolloutPath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(
        rolloutPath,
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['initial item'],
        }),
        'utf8',
      );
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: null,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a Codex tail cursor');

      await appendFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:01.000Z',
          payload: {
            id: fixture.remoteSessionId,
            timestamp: '2026-07-23T08:00:01.000Z',
            cwd: '/repo/codex-transcript-cursor',
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:00:02.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'visible after metadata record' }],
          },
        }),
      ].join(''), 'utf8');

      const result = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      expect(result).toMatchObject({
        items: [expect.objectContaining({
          raw: expect.any(Object),
        })],
        diagnostics: [
          {
            code: 'non_transcript_record_skipped',
            count: 1,
            positions: [expect.any(Number)],
          },
        ],
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails before yielding a successor cursor for unsupported current rollout records', async () => {
    const fixture = await createFixture();
    try {
      const rolloutPath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(
        rolloutPath,
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T08:00:00.000Z',
            payload: {
              id: fixture.remoteSessionId,
              timestamp: '2026-07-23T08:00:00.000Z',
              cwd: '/repo/codex-transcript-cursor',
            },
          }),
          jsonl({
            type: 'unsupported_record',
            timestamp: '2026-07-23T08:00:01.000Z',
            payload: { ignored: true },
          }),
        ].join(''),
        'utf8',
      );

      await expect(pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).rejects.toThrow(/unsupported rollout record/u);

      await writeFile(
        rolloutPath,
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['initial item'],
        }),
        'utf8',
      );
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a Codex tail cursor');

      await appendFile(rolloutPath, [
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:00:02.000Z',
          payload: { type: 'unrecognized_current_shape' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:00:03.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'must not bypass unsupported record' }],
          },
        }),
      ].join(''));

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).rejects.toThrow(/unsupported rollout record/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports malformed rollout UTF-8 by byte offset without admitting replacement text', async () => {
    const fixture = await createFixture();
    try {
      const rolloutPath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(
        rolloutPath,
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['initial item'],
        }),
      );
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: null,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a Codex tail cursor');

      const before = (await readFile(rolloutPath)).byteLength;
      const prefix = Buffer.from(
        '{"type":"response_item","timestamp":"2026-07-23T08:00:02.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"',
        'utf8',
      );
      await appendFile(
        rolloutPath,
        Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n', 'utf8')]),
      );

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        nextCursor: expect.any(String),
        diagnostics: [{
          code: 'malformed_source_utf8',
          count: 1,
          positions: [before + prefix.byteLength],
        }],
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('explicitly resets provenance-pinned released and unrecognized forward cursors, then writes anchored v7', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['predecessor cursor fixture'],
        }),
        'utf8',
      );
      const provenancePinnedCursors = [
        // cli-v0.2.1 (b1d15a8a9c241737d1ca9b167459901e6259173a) and
        // cli-v0.2.2-preview.1775586717.26498
        // (4913c1e533c872a0712ba1c25b3104fd470aacc2), exact v1-v3
        // vectors from codexDirectForwardCursor.ts.
        'eyJ2IjoxLCJraW5kIjoiY29kZXhGb3J3YXJkIiwiZmlsZVJlbFBhdGgiOiJzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQtMjAyNi0wMi0xOFQwOC0yOC0wNS01NTU1NTU1NS01NTU1LTU1NTUtNTU1NS01NTU1NTU1NTU1NTUuanNvbmwiLCJvZmZzZXRCeXRlcyI6MTIzfQ',
        'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
        'eyJ2IjozLCJraW5kIjoiY29kZXhGb3J3YXJkTWVyZ2VkIiwibGFzdENyZWF0ZWRBdE1zIjoxNzcxNDAzMjg1MDAwLCJsYXN0SWQiOiJjb2RleDpzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQtMjAyNi0wMi0xOFQwOC0yOC0wNS01NTU1NTU1NS01NTU1LTU1NTUtNTU1NS01NTU1NTU1NTU1NTUuanNvbmw6MDAwMDAwMDAwMDAwOjAwMCJ9',
        // Prospective predecessor HEAD
        // 6e6ecb42e7f9ab8607b5710547563bbc9c232728, exact committed
        // codexDirectForwardCursor.ts v5 durable-vector shape.
        'eyJ2Ijo1LCJraW5kIjoiY29kZXhGb3J3YXJkU3RyZWFtVmVjdG9yIiwic3RyZWFtcyI6W3siZmlsZVJlbFBhdGgiOiJzZXNzaW9ucy8yMDI2LzA3LzIzL3JvbGxvdXQtc2Vzc2lvbi5qc29ubCIsIm5leHRPZmZzZXRCeXRlcyI6MTIzLCJzdWJJbmRleCI6MCwiZmluZ2VycHJpbnRPZmZzZXRCeXRlcyI6MTIzLCJmaWxlSWRlbnRpdHkiOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiY29udGVudEZpbmdlcnByaW50IjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9XX0',
      ] as const;

      for (const cursor of provenancePinnedCursors) {
        const result = await readAfterCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          cursor,
          maxBytes: 64 * 1024,
          maxItems: 20,
        });

        expect(result).toMatchObject({
          items: [],
          nextCursor: expect.any(String),
          tailCursor: expect.any(String),
          truncated: true,
          readAfterOutcome: 'gap_or_cursor_expired',
        });
        expect(decodeCursorRecord(result.tailCursor ?? '').v).toBe(7);
      }

      const currentPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!currentPage.tailCursor) throw new Error('Expected a current Codex tail cursor');
      // An unrecognized cursor version must never have its offsets reused,
      // even when every other field matches the current anchored vector.
      const priorUnanchoredCursor = encodeCursorRecord({
        ...decodeCursorRecord(currentPage.tailCursor),
        v: 6,
      });
      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: priorUnanchoredCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        nextCursor: expect.any(String),
        tailCursor: expect.any(String),
        truncated: true,
        readAfterOutcome: 'gap_or_cursor_expired',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('explicitly resets provenance-pinned released and unrecognized backward cursors, then writes anchored v5', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          messages: ['first page', 'second page'],
        }),
        'utf8',
      );
      const provenancePinnedCursors = [
        // cli-v0.2.1 (b1d15a8a9c241737d1ca9b167459901e6259173a) and
        // cli-v0.2.2-preview.1775586717.26498
        // (4913c1e533c872a0712ba1c25b3104fd470aacc2), exact v2
        // pageCodexTranscript.ts backward-cursor shape.
        'eyJ2IjoyLCJraW5kIjoiY29kZXhCYWNrd2FyZE1lcmdlZCIsImVuZEluZGV4IjoxN30',
        // Prospective predecessor HEAD
        // 6e6ecb42e7f9ab8607b5710547563bbc9c232728, exact committed
        // codexDirectTranscriptBackwardCursor.ts v3 vector shape.
        'eyJ2IjozLCJraW5kIjoiY29kZXhCYWNrd2FyZFN0cmVhbVZlY3RvciIsInN0cmVhbXMiOlt7ImZpbGVSZWxQYXRoIjoic2Vzc2lvbnMvMjAyNi8wNy8yMy9yb2xsb3V0LXNlc3Npb24uanNvbmwiLCJlbmRPZmZzZXRCeXRlcyI6MzIxfV19',
      ] as const;

      for (const cursor of provenancePinnedCursors) {
        const result = await pageCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          direction: 'older',
          cursor,
          maxBytes: 64 * 1024,
          maxItems: 1,
        });

        expect(result).toMatchObject({
          items: [],
          nextCursor: null,
          tailCursor: expect.any(String),
          hasMore: false,
          truncated: true,
        });
        expect(decodeCursorRecord(result.tailCursor ?? '').v).toBe(7);
      }

      const currentPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 1,
      });
      expect(currentPage.nextCursor).not.toBeNull();
      expect(decodeCursorRecord(currentPage.nextCursor ?? '').v).toBe(5);

      const priorUnanchoredCursor = encodeCursorRecord({
        ...decodeCursorRecord(currentPage.nextCursor ?? ''),
        v: 4,
      });
      await expect(pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: priorUnanchoredCursor,
        maxBytes: 64 * 1024,
        maxItems: 1,
      })).resolves.toMatchObject({
        items: [],
        nextCursor: null,
        tailCursor: expect.any(String),
        hasMore: false,
        truncated: true,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a v7 cursor with one current rollout stream omitted before a canonical reread', async () => {
    const fixture = await createFixture();
    try {
      for (const [time, message] of [
        ['08-00-00', 'first stream history'],
        ['09-00-00', 'second stream history'],
      ] as const) {
        await writeFile(
          join(
            fixture.dayDir,
            `rollout-2026-07-23T${time}-${fixture.remoteSessionId}.jsonl`,
          ),
          rollout({
            remoteSessionId: fixture.remoteSessionId,
            timestamp: `2026-07-23T${time.replaceAll('-', ':')}.000Z`,
            messages: [message],
          }),
          'utf8',
        );
      }
      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!firstPage.tailCursor) throw new Error('Expected a multi-stream tail cursor');

      const cursorRecord = decodeCursorRecord(firstPage.tailCursor);
      const streams = Array.isArray(cursorRecord.streams) ? cursorRecord.streams : [];
      expect(streams).toHaveLength(2);
      const forgedCursor = encodeCursorRecord({
        ...cursorRecord,
        streams: streams.slice(0, 1),
      });

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: forgedCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'gap_or_cursor_expired',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps exact path continuity when cursor stream membership is reordered', async () => {
    const fixture = await createFixture();
    try {
      const files = [
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        join(
          fixture.dayDir,
          `rollout-2026-07-23T09-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
      ];
      for (const [index, file] of files.entries()) {
        await writeFile(file, rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: `2026-07-23T${index === 0 ? '08' : '09'}:00:00.000Z`,
          messages: [`initial stream ${index + 1}`],
        }), 'utf8');
      }
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a multi-stream tail cursor');
      const cursorRecord = decodeCursorRecord(initial.tailCursor);
      const streams = Array.isArray(cursorRecord.streams) ? cursorRecord.streams : [];
      expect(streams).toHaveLength(2);
      const reorderedCursor = encodeCursorRecord({
        ...cursorRecord,
        streams: [...streams].reverse(),
      });

      await appendFile(files[0]!, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T10:00:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first path append' }],
        },
      }));
      await appendFile(files[1]!, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'second path append' }],
        },
      }));

      const after = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: reorderedCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      expect(after.readAfterOutcome).toBeUndefined();
      expect(after.items.map((item) => (
        item.raw.content.type === 'codex'
          && item.raw.content.data.type === 'message'
          ? item.raw.content.data.message
          : null
      ))).toEqual(['first path append', 'second path append']);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('recovers exact membership growth but keeps prior-stream replacement terminal', async () => {
    const fixture = await createFixture();
    try {
      const firstFile = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(firstFile, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['first stream message'],
      }), 'utf8');
      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!firstPage.tailCursor) throw new Error('Expected a tail cursor');

      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T09-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T09:00:00.000Z',
          messages: ['new additive stream message'],
        }),
        'utf8',
      );

      const after = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: firstPage.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });

      expect(after).toMatchObject({
        items: [],
        truncated: true,
        tailCursor: expect.any(String),
        readAfterOutcome: 'gap_or_cursor_expired',
      });
      expect(after.nextCursor).not.toBe(firstPage.tailCursor);

      await writeFile(firstFile, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['destructively replaced first stream'],
      }), 'utf8');
      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: firstPage.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('treats a root-family child with a root-named rollout file as additive membership exactly once', async () => {
    const fixture = await createFixture();
    const childThreadId = '22222222-2222-2222-2222-222222222222';
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T08:00:00.000Z',
            payload: {
              id: fixture.remoteSessionId,
              timestamp: '2026-07-23T08:00:00.000Z',
              cwd: '/repo/codex-transcript-cursor',
            },
          }),
          jsonl({
            type: 'event_msg',
            timestamp: '2026-07-23T08:00:01.000Z',
            payload: {
              type: 'collab_agent_spawn_end',
              new_thread_id: childThreadId,
              new_agent_nickname: 'Child',
              new_agent_role: 'explorer',
              prompt: 'inspect the repo',
            },
          }),
        ].join(''),
        'utf8',
      );
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected an initial tail cursor');

      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T09-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        rollout({
          remoteSessionId: childThreadId,
          rootSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T09:00:00.000Z',
          messages: ['mislabeled child output'],
        }),
        'utf8',
      );

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      })).resolves.toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'gap_or_cursor_expired',
      });

      const canonicalPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      expect(canonicalPage.items.filter((item) => readTranscriptItemMessage(item) === 'mislabeled child output'))
        .toHaveLength(1);
      expect(canonicalPage.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sidechainId: childThreadId }),
      ]));
      // The parent `SubAgent` tool call keyed on the child thread id is what makes the
      // child rows render under their spawn, so it is asserted rather than tolerated.
      expect(canonicalPage.items.map((item) => (item.raw as Readonly<{
        content?: Readonly<{ data?: Readonly<{ type?: unknown; name?: unknown; callId?: unknown }> }>;
      }>).content?.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', name: 'SubAgent', callId: childThreadId }),
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reads an official child rollout once with its sidechain identity', async () => {
    const fixture = await createFixture();
    const childThreadId = '22222222-2222-2222-2222-222222222222';
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T08:00:00.000Z',
            payload: {
              id: fixture.remoteSessionId,
              timestamp: '2026-07-23T08:00:00.000Z',
              cwd: '/repo/codex-transcript-cursor',
            },
          }),
          jsonl({
            type: 'event_msg',
            timestamp: '2026-07-23T08:00:01.000Z',
            payload: {
              type: 'collab_agent_spawn_end',
              new_thread_id: childThreadId,
              new_agent_nickname: 'Child',
              new_agent_role: 'explorer',
              prompt: 'inspect the repo',
            },
          }),
        ].join(''),
        'utf8',
      );
      await writeFile(
        join(fixture.dayDir, 'rollout-child-thread.jsonl'),
        rollout({
          remoteSessionId: childThreadId,
          rootSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:02.000Z',
          messages: ['child output'],
        }),
        'utf8',
      );

      const page = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      const childItems = page.items.filter((item) => (
        item.raw.content.type === 'codex'
        && item.raw.content.data.type === 'message'
        && item.raw.content.data.message === 'child output'
      ));

      expect(childItems).toHaveLength(1);
      expect(childItems[0]).toMatchObject({ sidechainId: childThreadId });
      expect(childItems[0]?.raw.content).toMatchObject({
        data: { sidechainId: childThreadId },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('includes a sidechain whose spawn falls after the former bounded content scan', async () => {
    const fixture = await createFixture();
    const childThreadId = '33333333-3333-3333-3333-333333333333';
    try {
      const rootRolloutPath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      const metadataBeforeSpawn = Array.from({ length: 513 }, () => jsonl({
        type: 'session_meta',
        timestamp: '2026-07-23T08:00:00.000Z',
        payload: {
          id: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:00.000Z',
          cwd: '/repo/codex-transcript-cursor',
          padding: 'x'.repeat(3 * 1024),
        },
      }));
      await writeFile(
        rootRolloutPath,
        [
          ...metadataBeforeSpawn,
          jsonl({
            type: 'event_msg',
            timestamp: '2026-07-23T08:00:01.000Z',
            payload: {
              type: 'collab_agent_spawn_end',
              new_thread_id: childThreadId,
              new_agent_nickname: 'Late child',
              new_agent_role: 'explorer',
              prompt: 'inspect the repo',
            },
          }),
        ].join(''),
        'utf8',
      );
      const childRolloutPath = join(fixture.dayDir, 'rollout-late-child.jsonl');
      await writeFile(
        childRolloutPath,
        rollout({
          remoteSessionId: childThreadId,
          rootSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:02.000Z',
          messages: ['late sidechain output'],
        }),
        'utf8',
      );

      const page = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 4 * 1024 * 1024,
        maxItems: 20,
      });

      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sidechainId: childThreadId,
          raw: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({ message: 'late sidechain output' }),
            }),
          }),
        }),
      ]));
      if (!page.tailCursor) throw new Error('Expected a root-family tail cursor');
      const cursor = decodeCursorRecord(page.tailCursor);
      expect(cursor.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fileRelPath: expect.stringContaining('rollout-late-child.jsonl'),
        }),
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports recoverable membership growth for a delayed child and discovers it through a canonical reread', async () => {
    const fixture = await createFixture();
    const childThreadId = '22222222-2222-2222-2222-222222222222';
    try {
      await writeFile(
        join(
          fixture.dayDir,
          `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
        ),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T08:00:00.000Z',
            payload: {
              id: fixture.remoteSessionId,
              timestamp: '2026-07-23T08:00:00.000Z',
              cwd: '/repo/codex-transcript-cursor',
            },
          }),
          jsonl({
            type: 'event_msg',
            timestamp: '2026-07-23T08:00:01.000Z',
            payload: {
              type: 'collab_agent_spawn_end',
              new_thread_id: childThreadId,
              new_agent_nickname: 'Child',
              new_agent_role: 'explorer',
              prompt: 'inspect the repo',
            },
          }),
        ].join(''),
        'utf8',
      );
      const initialPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initialPage.tailCursor) throw new Error('Expected a released tail cursor');

      await writeFile(
        join(fixture.dayDir, 'rollout-child-thread.jsonl'),
        rollout({
          remoteSessionId: childThreadId,
          rootSessionId: fixture.remoteSessionId,
          timestamp: '2026-07-23T08:00:02.000Z',
          messages: ['delayed child output'],
        }),
        'utf8',
      );

      const reset = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initialPage.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });

      expect(reset).toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'gap_or_cursor_expired',
      });

      const canonicalPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      // The canonical projection emits the pair: the parent `SubAgent` tool call whose
      // tool id is the child thread, then the child row carrying that same id as its
      // `sidechainId`. Both rows are the contract, in that order.
      expect(canonicalPage.items).toMatchObject([
        {
          sidechainId: null,
          raw: {
            content: {
              data: {
                type: 'tool-call',
                name: 'SubAgent',
                callId: childThreadId,
              },
            },
          },
        },
        {
          sidechainId: childThreadId,
          raw: {
            content: {
              data: {
                type: 'message',
                message: 'delayed child output',
                sidechainId: childThreadId,
              },
            },
          },
        },
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('stops paging once an exhausted scan returned every projected row behind a non-transcript prefix', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      const nonTranscriptPrefix = [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: {
            id: fixture.remoteSessionId,
            timestamp: '2026-07-23T08:00:00.000Z',
            cwd: '/repo/codex-transcript-cursor',
          },
        }),
        jsonl({
          type: 'turn_context',
          timestamp: '2026-07-23T08:00:01.000Z',
          payload: { cwd: '/repo/codex-transcript-cursor', notes: 'c'.repeat(8 * 1024) },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:00:02.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: `<environment_context>${'e'.repeat(8 * 1024)}</environment_context>`,
            }],
          },
        }),
      ].join('');
      const visibleTexts = ['visible 1', 'visible 2', 'visible 3', 'visible 4', 'visible 5', 'visible 6'];
      const projectableTail = visibleTexts.map((text, index) => jsonl({
        type: 'response_item',
        timestamp: new Date(Date.parse('2026-07-23T08:00:03.000Z') + (index * 1_000)).toISOString(),
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      })).join('');
      await writeFile(filePath, `${nonTranscriptPrefix}${projectableTail}`, 'utf8');
      expect(Buffer.byteLength(nonTranscriptPrefix, 'utf8')).toBeGreaterThan(16 * 1024);

      const exhausted = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 512 * 1024,
        maxItems: 200,
      });

      expect(exhausted.items.map((item) => transcriptItemText(item))).toEqual(visibleTexts);
      expect(exhausted).toMatchObject({
        hasMore: false,
        nextCursor: null,
        truncated: false,
        tailCursor: expect.any(String),
      });

      // An equally exhausted scan that had to drop an older projected row still has more to page.
      const budgeted = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 512 * 1024,
        maxItems: 5,
      });
      expect(budgeted.items.map((item) => transcriptItemText(item))).toEqual(visibleTexts.slice(1));
      expect(budgeted).toMatchObject({
        hasMore: true,
        nextCursor: expect.any(String),
        truncated: false,
      });

      const continued = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: budgeted.nextCursor ?? '',
        maxBytes: 512 * 1024,
        maxItems: 5,
      });
      expect(continued.items.map((item) => transcriptItemText(item))).toEqual([visibleTexts[0]]);
      expect(continued).toMatchObject({ hasMore: false, nextCursor: null });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('returns a typed truncated reset when an older-page stream is physically replaced', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(filePath, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['oldest', 'middle', 'newest'],
      }), 'utf8');
      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 1,
      });
      if (!firstPage.nextCursor) throw new Error('Expected an older-page cursor');

      const replacement = `${filePath}.replacement`;
      await writeFile(replacement, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['replacement content'],
      }), 'utf8');
      await rm(filePath);
      await rename(replacement, filePath);

      const continued = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        cursor: firstPage.nextCursor,
        maxBytes: 64 * 1024,
        maxItems: 1,
      });

      expect(continued).toMatchObject({
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
        tailCursor: expect.any(String),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an in-place truncation in both cursor directions', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      const original = largeAppendOrientedRollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
      });
      await writeFile(filePath, original, 'utf8');

      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 128 * 1024,
        maxItems: 1,
      });
      if (!firstPage.tailCursor || !firstPage.nextCursor) {
        throw new Error('Expected both transcript cursor directions');
      }

      const before = await stat(filePath);
      await truncate(filePath, Math.trunc(before.size / 2));
      const afterTruncate = await stat(filePath);
      expect([afterTruncate.dev, afterTruncate.ino]).toEqual([before.dev, before.ino]);
      expect(afterTruncate.size).toBeLessThan(before.size);

      const [after, older] = await Promise.all([
        readAfterCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          cursor: firstPage.tailCursor,
          maxBytes: 128 * 1024,
          maxItems: 1,
        }),
        pageCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          direction: 'older',
          cursor: firstPage.nextCursor,
          maxBytes: 128 * 1024,
          maxItems: 1,
        }),
      ]);

      expect.soft(after).toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });
      expect(older).toMatchObject({
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'sampled prefix',
      'prefix',
      (contents: string) => contents.replace('sampled-prefix-A', 'sampled-prefix-B'),
    ],
    [
      'prior-watermark boundary',
      'boundary',
      (contents: string) => contents.replace(
        'prior-watermark-boundary-X',
        'prior-watermark-boundary-Y',
      ),
    ],
  ] as const)('rejects a same-size %s rewrite in both cursor directions', async (
    _label,
    region,
    mutate,
  ) => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      const original = largeAppendOrientedRollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
      });
      const rewritten = mutate(original);
      expect(Buffer.byteLength(original, 'utf8')).toBeGreaterThan(16 * 1024);
      expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
        Buffer.byteLength(original, 'utf8'),
      );
      expect(rewritten).not.toBe(original);
      await writeFile(filePath, original, 'utf8');

      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 128 * 1024,
        maxItems: 1,
      });
      if (!firstPage.tailCursor || !firstPage.nextCursor) {
        throw new Error('Expected both transcript cursor directions');
      }
      const originalBytes = Buffer.from(original, 'utf8');
      const rewrittenBytes = Buffer.from(rewritten, 'utf8');
      const changedByteOffset = originalBytes.findIndex(
        (byte, index) => byte !== rewrittenBytes[index],
      );
      expect(changedByteOffset).toBeGreaterThanOrEqual(0);
      const cursorWatermarks = [
        decodeSingleStreamCursor(firstPage.tailCursor).fingerprintOffsetBytes,
        decodeSingleStreamCursor(firstPage.nextCursor).fingerprintOffsetBytes,
      ];
      expect(cursorWatermarks).toEqual([
        expect.any(Number),
        expect.any(Number),
      ]);
      for (const watermark of cursorWatermarks) {
        if (typeof watermark !== 'number') {
          throw new Error('Expected a numeric cursor fingerprint watermark');
        }
        if (region === 'prefix') {
          expect(changedByteOffset).toBeLessThan(4 * 1024);
        } else {
          expect(changedByteOffset).toBeGreaterThanOrEqual(watermark - 4 * 1024);
          expect(changedByteOffset).toBeLessThan(watermark);
        }
      }

      const before = await stat(filePath);
      await writeFile(filePath, rewritten, 'utf8');
      const afterRewrite = await stat(filePath);
      expect([afterRewrite.dev, afterRewrite.ino]).toEqual([before.dev, before.ino]);

      const [after, older] = await Promise.all([
        readAfterCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          cursor: firstPage.tailCursor,
          maxBytes: 128 * 1024,
          maxItems: 1,
        }),
        pageCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          direction: 'older',
          cursor: firstPage.nextCursor,
          maxBytes: 128 * 1024,
          maxItems: 1,
        }),
      ]);

      expect.soft(after).toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });
      expect(older).toMatchObject({
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('continues after a large append-only rollout with an unsampled interior', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      const original = largeAppendOrientedRollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
      });
      expect(Buffer.byteLength(original, 'utf8')).toBeGreaterThan(16 * 1024);
      await writeFile(filePath, original, 'utf8');

      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 128 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected a large-rollout tail cursor');
      expect(
        decodeSingleStreamCursor(initial.tailCursor).fingerprintOffsetBytes,
      ).toBeGreaterThan(16 * 1024);

      await appendFile(filePath, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T08:00:05.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'append-only continuation' }],
        },
      }));

      const continued = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 20,
      });

      expect(continued).toMatchObject({
        items: [{
          sidechainId: null,
          raw: {
            content: {
              data: {
                message: 'append-only continuation',
              },
            },
          },
        }],
        nextCursor: expect.any(String),
        tailCursor: expect.any(String),
        truncated: false,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a forged same-line continuation that skips past the actual projected record count', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(filePath, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['before tail'],
      }), 'utf8');
      const initial = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      if (!initial.tailCursor) throw new Error('Expected an initial tail cursor');

      const lineStartOffsetBytes = (await stat(filePath)).size;
      await appendFile(filePath, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T08:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'one projected record' }],
        },
      }));
      const advanced = await readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 1,
      });
      expect(advanced.items).toHaveLength(1);
      if (!advanced.nextCursor) throw new Error('Expected an advanced cursor');

      const advancedRecord = decodeCursorRecord(advanced.nextCursor);
      const streams = Array.isArray(advancedRecord.streams)
        ? advancedRecord.streams
        : [];
      const forgedCursor = encodeCursorRecord({
        ...advancedRecord,
        streams: streams.map((entry) => (
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? {
                ...(entry as Record<string, unknown>),
                nextOffsetBytes: lineStartOffsetBytes,
                subIndex: 1,
              }
            : entry
        )),
      });

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: forgedCursor,
        maxBytes: 64 * 1024,
        maxItems: 1,
      })).resolves.toMatchObject({
        items: [],
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });

      await expect(readAfterCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        cursor: advanced.nextCursor,
        maxBytes: 64 * 1024,
        maxItems: 1,
      })).resolves.toMatchObject({
        items: [],
        truncated: false,
        readAfterOutcome: 'already_current',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('treats complete rollout-stream loss as source replacement', async () => {
    const fixture = await createFixture();
    try {
      const filePath = join(
        fixture.dayDir,
        `rollout-2026-07-23T08-00-00-${fixture.remoteSessionId}.jsonl`,
      );
      await writeFile(filePath, rollout({
        remoteSessionId: fixture.remoteSessionId,
        timestamp: '2026-07-23T08:00:00.000Z',
        messages: ['first', 'second'],
      }), 'utf8');
      const firstPage = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 1,
      });
      if (!firstPage.tailCursor || !firstPage.nextCursor) {
        throw new Error('Expected both transcript cursor directions');
      }
      await rm(filePath);

      const [after, older] = await Promise.all([
        readAfterCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          cursor: firstPage.tailCursor,
          maxBytes: 64 * 1024,
          maxItems: 1,
        }),
        pageCodexExternalSessionTranscript({
          ...sourceParams(fixture),
          direction: 'older',
          cursor: firstPage.nextCursor,
          maxBytes: 64 * 1024,
          maxItems: 1,
        }),
      ]);

      expect(after).toEqual({
        items: [],
        nextCursor: null,
        tailCursor: null,
        truncated: true,
        readAfterOutcome: 'source_replaced',
      });
      expect(older).toEqual({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: true,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('applies one UTF-8 maxBytes budget across the complete rollout stream set', async () => {
    const fixture = await createFixture();
    try {
      for (const [time, message] of [
        ['08-00-00', '🙂'.repeat(120)],
        ['09-00-00', '🚀'.repeat(120)],
      ] as const) {
        await writeFile(
          join(fixture.dayDir, `rollout-2026-07-23T${time}-${fixture.remoteSessionId}.jsonl`),
          rollout({
            remoteSessionId: fixture.remoteSessionId,
            timestamp: `2026-07-23T${time.replaceAll('-', ':')}.000Z`,
            messages: [message],
          }),
          'utf8',
        );
      }
      const complete = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 20,
      });
      expect(complete.items).toHaveLength(2);
      const aggregateBudget = complete.items.reduce(
        (sum, item) => sum + JSON.stringify(item).length,
        0,
      );

      const bounded = await pageCodexExternalSessionTranscript({
        ...sourceParams(fixture),
        direction: 'older',
        maxBytes: aggregateBudget,
        maxItems: 20,
      });

      expect(bounded.items).toHaveLength(1);
      expect(
        bounded.items.reduce(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'),
          0,
        ),
      ).toBeLessThanOrEqual(aggregateBudget);
      expect(bounded).toMatchObject({
        hasMore: true,
        nextCursor: expect.any(String),
        truncated: false,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
