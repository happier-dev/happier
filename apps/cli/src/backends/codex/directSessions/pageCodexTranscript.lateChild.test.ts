import { createHook } from 'node:async_hooks';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageCodexTranscript } from './pageCodexTranscript';

function responseItemLine(text: string, timestamp: string): string {
  return `${JSON.stringify({
    type: 'response_item', timestamp,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;
}

function sessionMetaLine(id: string, index: number): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      cwd: `/repo/${index}-${'x'.repeat(2_000)}`,
    },
  })}\n`;
}

function spawnLine(parent: string, child: string, timestamp: string): string {
  return `${JSON.stringify({
    type: 'event_msg', timestamp,
    payload: {
      type: 'collab_agent_spawn_end', sender_thread_id: parent,
      new_thread_id: child, prompt: `spawn ${child}`,
    },
  })}\n`;
}

async function createLateChildFixture(params: Readonly<{
  sessionId: string;
  childThreadId: string;
  childText: string;
  childTimestamp: string;
}>): Promise<Readonly<{ root: string; codexHome: string; parentFileName: string; childFileName: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-late-child-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const parentFileName = `rollout-2026-01-02T00-00-00-${params.sessionId}.jsonl`;
  const childFileName = `rollout-2026-01-02T00-00-01-${params.childThreadId}.jsonl`;
  const filler = Array.from({ length: 700 }, (_, index) => sessionMetaLine(params.sessionId, index)).join('');
  await writeFile(
    join(sessionsDir, parentFileName),
    filler + spawnLine(params.sessionId, params.childThreadId, '2026-01-03T00:00:01.000Z'),
    'utf8',
  );
  await writeFile(
    join(sessionsDir, childFileName),
    responseItemLine(params.childText, params.childTimestamp),
    'utf8',
  );
  return { root, codexHome, parentFileName, childFileName };
}

async function page(params: Readonly<{
  root: string;
  codexHome: string;
  sessionId: string;
  cursor?: string;
  maxItems?: number;
}>) {
  return pageCodexTranscript({
    source: { kind: 'codexHome', home: 'user' },
    env: { CODEX_HOME: params.codexHome } as NodeJS.ProcessEnv,
    activeServerDir: join(params.root, 'servers', 'cloud'),
    remoteSessionId: params.sessionId,
    direction: 'older', cursor: params.cursor,
    maxBytes: 1024 * 1024, maxItems: params.maxItems ?? 30,
  });
}

function decodeOpaqueCursor(cursor: string): Readonly<{
  v: number;
  kind: string;
  streams: ReadonlyArray<Record<string, unknown>>;
}> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Readonly<{
    v: number;
    kind: string;
    streams: ReadonlyArray<Record<string, unknown>>;
  }>;
}

function encodeOpaqueCursor(cursor: Readonly<{
  v: number;
  kind: string;
  streams: ReadonlyArray<Record<string, unknown>>;
}>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const countFsPromiseResources = async <T>(work: () => Promise<T>): Promise<Readonly<{
  result: T;
  count: number;
}>> => {
  let count = 0;
  const hook = createHook({
    init: (_asyncId, type) => {
      if (type === 'FSREQPROMISE') count += 1;
    },
  });
  hook.enable();
  try {
    return { result: await work(), count };
  } finally {
    hook.disable();
  }
};

describe('pageCodexTranscript late child rollout discovery', () => {
  it('includes a child whose spawn event is beyond the bounded discovery window', async () => {
    const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const fixture = await createLateChildFixture({
      sessionId,
      childThreadId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      childText: 'late child summary',
      childTimestamp: '2026-01-03T00:00:02.000Z',
    });

    expect(JSON.stringify((await page({ ...fixture, sessionId })).items)).toContain('late child summary');
  });

  it('keeps a late child available across older pages', async () => {
    const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const fixture = await createLateChildFixture({
      sessionId,
      childThreadId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      childText: 'late child older',
      childTimestamp: '2025-12-31T23:59:58.000Z',
    });

    const first = await page({ ...fixture, sessionId, maxItems: 1 });
    expect(JSON.stringify(first.items)).toContain('spawn eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    const second = await page({ ...fixture, sessionId, cursor: first.nextCursor ?? undefined, maxItems: 1 });
    expect(JSON.stringify(second.items)).toContain('late child older');
  });

  it('ignores a forged child identity from an opaque cursor', async () => {
    const sessionId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const unrelatedThreadId = '12121212-1212-1212-1212-121212121212';
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-forged-child-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const parentFileName = `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`;
    const unrelatedFileName = `rollout-2026-01-02T00-00-01-${unrelatedThreadId}.jsonl`;
    await writeFile(join(sessionsDir, parentFileName), sessionMetaLine(sessionId, 0), 'utf8');
    const unrelatedPath = join(sessionsDir, unrelatedFileName);
    await writeFile(unrelatedPath, responseItemLine('must stay unrelated', '2026-01-02T00:00:02.000Z'), 'utf8');
    const forgedCursor = Buffer.from(JSON.stringify({
      v: 4, kind: 'codexBackwardStreamVector',
      streams: [{
        fileRelPath: `sessions/${unrelatedFileName}`,
        endOffsetBytes: (await stat(unrelatedPath)).size,
        threadId: unrelatedThreadId,
        sidechainId: unrelatedThreadId,
        discoveredFrom: { fileRelPath: `sessions/${parentFileName}`, lineStartOffsetBytes: 0 },
      }],
    }), 'utf8').toString('base64url');

    expect(JSON.stringify((await page({ root, codexHome, sessionId, cursor: forgedCursor })).items))
      .not.toContain('must stay unrelated');
  });

  it('derives a restored child sidechain from its validated thread identity', async () => {
    const sessionId = '14141414-1414-1414-1414-141414141414';
    const childThreadId = '15151515-1515-1515-1515-151515151515';
    const fixture = await createLateChildFixture({
      sessionId,
      childThreadId,
      childText: 'validated child identity',
      childTimestamp: '2025-12-31T23:59:58.000Z',
    });
    const first = await page({ ...fixture, sessionId, maxItems: 1 });
    if (!first.nextCursor) throw new Error('Expected another page');
    const decoded = decodeOpaqueCursor(first.nextCursor);
    const forgedCursor = encodeOpaqueCursor({
      ...decoded,
      streams: decoded.streams.map((stream) => (
        stream.threadId === childThreadId
          ? { ...stream, sidechainId: 'forged-sidechain' }
          : stream
      )),
    });

    const restored = await page({ ...fixture, sessionId, cursor: forgedCursor, maxItems: 1 });
    const childItem = restored.items.find((item) => JSON.stringify(item).includes('validated child identity'));
    expect(childItem).toMatchObject({
      raw: { content: { data: { sidechainId: childThreadId } } },
    });
  });

  it('rejects an opaque cursor that repeats the same rollout stream', async () => {
    const sessionId = '16161616-1616-1616-1616-161616161616';
    const childThreadId = '17171717-1717-1717-1717-171717171717';
    const fixture = await createLateChildFixture({
      sessionId,
      childThreadId,
      childText: 'unique child history',
      childTimestamp: '2025-12-31T23:59:58.000Z',
    });
    const first = await page({ ...fixture, sessionId, maxItems: 1 });
    if (!first.nextCursor) throw new Error('Expected another page');
    const decoded = decodeOpaqueCursor(first.nextCursor);
    const childStream = decoded.streams.find((stream) => stream.threadId === childThreadId);
    if (!childStream) throw new Error('Expected child stream in cursor');
    const duplicateCursor = encodeOpaqueCursor({
      ...decoded,
      streams: [...decoded.streams, childStream],
    });

    const restored = await page({ ...fixture, sessionId, cursor: duplicateCursor, maxItems: 10 });
    expect(restored.truncated).toBe(true);
    expect(restored.items.filter((item) => JSON.stringify(item).includes('unique child history'))).toHaveLength(1);
  });

  it('does not repeat filesystem discovery for forged paths sharing one validated child', async () => {
    const sessionId = '18181818-1818-1818-1818-181818181818';
    const childThreadId = '19191919-1919-1919-1919-191919191919';
    const fixture = await createLateChildFixture({
      sessionId,
      childThreadId,
      childText: 'bounded child restoration',
      childTimestamp: '2025-12-31T23:59:58.000Z',
    });
    const first = await page({ ...fixture, sessionId, maxItems: 1 });
    if (!first.nextCursor) throw new Error('Expected another page');
    const decoded = decodeOpaqueCursor(first.nextCursor);
    const childStream = decoded.streams.find((stream) => stream.threadId === childThreadId);
    if (!childStream) throw new Error('Expected child stream in cursor');
    const forgedCursor = encodeOpaqueCursor({
      ...decoded,
      streams: [
        ...decoded.streams,
        ...Array.from({ length: 10 }, (_, index) => ({
          ...childStream,
          fileRelPath: `sessions/forged-child-${index}.jsonl`,
        })),
      ],
    });

    const baseline = await countFsPromiseResources(
      async () => await page({ ...fixture, sessionId, cursor: first.nextCursor ?? undefined, maxItems: 10 }),
    );
    const forged = await countFsPromiseResources(
      async () => await page({ ...fixture, sessionId, cursor: forgedCursor, maxItems: 10 }),
    );

    expect(JSON.stringify(forged.result.items)).toContain('bounded child restoration');
    expect(forged.count).toBeLessThanOrEqual(baseline.count + 2);
  });

  it('restores nested children independent of cursor entry ordering', async () => {
    const rootThreadId = '31313131-3131-3131-3131-313131313131';
    const childThreadId = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
    const grandchildThreadId = '11111111-2222-3333-4444-555555555555';
    const fixture = await createLateChildFixture({
      sessionId: rootThreadId,
      childThreadId,
      childText: '',
      childTimestamp: '2026-01-01T00:00:00.000Z',
    });
    const sessionsDir = join(fixture.codexHome, 'sessions');
    const childFiller = Array.from({ length: 700 }, (_, index) => sessionMetaLine(childThreadId, index)).join('');
    await writeFile(
      join(sessionsDir, fixture.childFileName),
      childFiller + spawnLine(childThreadId, grandchildThreadId, '2026-01-03T00:00:02.000Z'),
      'utf8',
    );
    await writeFile(
      join(sessionsDir, `rollout-2026-01-02T00-00-02-${grandchildThreadId}.jsonl`),
      responseItemLine('nested grandchild history', '2025-12-31T00:00:00.000Z'),
      'utf8',
    );

    const first = await page({ ...fixture, sessionId: rootThreadId, maxItems: 1 });
    const second = await page({ ...fixture, sessionId: rootThreadId, cursor: first.nextCursor ?? undefined, maxItems: 1 });
    const third = await page({ ...fixture, sessionId: rootThreadId, cursor: second.nextCursor ?? undefined, maxItems: 1 });
    expect([first, second, third].map((result) => JSON.stringify(result.items)).join('\n'))
      .toContain('nested grandchild history');
  });
});
