import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAfterCodexTranscript } from './readAfterCodexTranscript';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('readAfterCodexTranscript', () => {
  it('returns appended messages when following from a tail cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.truncated).toBe(false);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'new' }] },
      }),
      'utf8',
    );

    const next = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(next.items.map((item) => (item.raw as any)?.content?.data?.message ?? (item.raw as any)?.content?.text)).toContain(
      'new',
    );
    expect(next.truncated).toBe(false);
    expect(next.nextCursor).toBeTruthy();
  });

  it('keeps the tail cursor at end-of-file when no new lines were appended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-stable-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '22222222-2222-2222-2222-222222222222';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/two' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    const idle = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(idle.items).toHaveLength(0);
    expect(idle.truncated).toBe(false);
    expect(idle.nextCursor).toBe(init.nextCursor);
  });

  it('keeps polling app-server-linked sessions when rollout files are missing, then forces a refresh when one appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(codexHome, { recursive: true });

    const sessionId = 'remote_app_server';
    const fakeAppServer = join(root, 'fake-codex-app-server.mjs');
    await writeFile(
      fakeAppServer,
      [
        '#!/usr/bin/env node',
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/list") {',
        `    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ id: ${JSON.stringify(sessionId)}, name: "App server tail preview", updatedAt: 1736000200, cwd: "/repo/from-app-server" }], nextCursor: null } }) + "\\n");`,
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );

    const env = { CODEX_HOME: codexHome, HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer } as NodeJS.ProcessEnv;

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.truncated).toBe(false);
    expect(init.nextCursor).toBeTruthy();

    const idle = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(idle.items).toHaveLength(0);
    expect(idle.truncated).toBe(false);
    expect(idle.nextCursor).toBe(init.nextCursor);

    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/from-rollout' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello from rollout' }] },
        }),
      'utf8',
    );

    const afterRolloutAppears = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterRolloutAppears.items).toHaveLength(0);
    expect(afterRolloutAppears.truncated).toBe(true);
    expect(afterRolloutAppears.nextCursor).toBeTruthy();
  });
});
