import { access, mkdir, mkdtemp, writeFile, appendFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';
import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerScript,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import type { CodexRolloutSessionStoreReadAfterResult } from './codexRolloutSessionStoreTypes';
import { withCodexRolloutSessionStore } from './codexRolloutSessionStoreRegistry';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

async function readAfterCodexTranscript(params: Readonly<{
  source: { kind: 'codexHome'; home: 'user' };
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<CodexRolloutSessionStoreReadAfterResult> {
  return withCodexRolloutSessionStore(
    {
      activeServerDir: params.activeServerDir,
      env: params.env,
      key: {
        providerId: 'codex',
        source: params.source,
        remoteSessionId: params.remoteSessionId,
      },
    },
    async (store): Promise<CodexRolloutSessionStoreReadAfterResult> =>
      (store as FileBackedTranscriptSessionStore<
        ExternalSessionTranscriptRawMessageV1,
        unknown,
        string | null
      >).readAfter({
        cursor: params.cursor,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
      }),
  );
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

  it('advances the follow cursor across non-renderable rollout lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-non-renderable-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'non-renderable-progress-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/non-renderable' }),
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

    await appendFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:01.000Z', cwd: '/repo/non-renderable' }),
      'utf8',
    );

    const firstPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(firstPoll.items).toHaveLength(0);
    expect(firstPoll.truncated).toBe(false);
    expect(firstPoll.nextCursor).toBeTruthy();
    expect(firstPoll.nextCursor).not.toBe(init.nextCursor);

    const secondPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstPoll.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(secondPoll.items).toHaveLength(0);
    expect(secondPoll.truncated).toBe(false);
    expect(secondPoll.nextCursor).toBe(firstPoll.nextCursor);
  });

  it('continues from the last delivered unread line when maxItems truncates a readAfter batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-batch-progress-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'batch-progress-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/batch-progress' }),
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

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'first unread item' }] },
      })
      + responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'second unread item' }] },
      }),
      'utf8',
    );

    const firstBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(firstBatch.items).toHaveLength(1);
    expect(JSON.stringify(firstBatch.items[0] ?? null)).toContain('first unread item');
    expect(firstBatch.truncated).toBe(true);
    expect(firstBatch.nextCursor).toBeTruthy();

    const secondBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstBatch.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(secondBatch.truncated).toBe(false);
    expect(secondBatch.items).toHaveLength(1);
    expect(JSON.stringify(secondBatch.items[0] ?? null)).toContain('second unread item');
    expect(secondBatch.nextCursor).toBeTruthy();
  });

  it('advances the follow cursor across subagent lifecycle facts without synthetic transcript rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-subagent-facts-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'subagent-facts-progress-session';
    const childThreadId = '56565656-5656-5656-5656-565656565656';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent-facts-progress' }),
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

    await appendFile(
      filePath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_waiting_end',
          sender_thread_id: sessionId,
          agent_statuses: [{
            thread_id: childThreadId,
            agent_nickname: 'Lovelace',
            agent_role: 'explorer',
            status: { completed: 'done' },
          }],
        },
      })}\n`,
      'utf8',
    );

    const firstPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(firstPoll.items).toHaveLength(0);
    expect(firstPoll.truncated).toBe(false);
    expect(firstPoll.nextCursor).toBeTruthy();
    expect(firstPoll.nextCursor).not.toBe(init.nextCursor);

    const secondPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstPoll.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(secondPoll.items).toHaveLength(0);
    expect(secondPoll.truncated).toBe(false);
    expect(secondPoll.nextCursor).toBe(firstPoll.nextCursor);
  });

  it('returns an empty follow result after the rollout file disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-cache-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'tail-cache-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/cache-tail' })
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

    await unlink(filePath);

    const afterMissing = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterMissing.items).toHaveLength(0);
    expect(afterMissing.truncated).toBe(false);
    expect(afterMissing.nextCursor).toBeNull();
  });

  it('keeps polling app-server-linked sessions when rollout files are missing, then forces a refresh when one appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(codexHome, { recursive: true });

    const sessionId = 'remote_app_server';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      initializeName: 'fake',
      nonArchivedThreads: [{
        id: sessionId,
        name: 'App server tail preview',
        updatedAt: 1736000200,
        cwd: '/repo/from-app-server',
      }],
    });

    const env = createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome });

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

  it('does not start the Codex app-server metadata fallback when tailing rollout-backed history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-no-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'tail-existing-rollout-session';
    const markerPath = join(root, 'app-server-started');
    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      setupLines: [
        'import("node:fs/promises").then(({ writeFile }) => writeFile(process.env.APP_SERVER_MARKER, "started"));',
      ],
      bodyLines: ['for await (const _line of rl) {}'],
    });

    await writeFile(
      join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: createCodexAppServerProcessEnv(fakeAppServer, {
        CODEX_HOME: codexHome,
        APP_SERVER_MARKER: markerPath,
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();
    await expect(access(markerPath)).rejects.toThrow();
  });

  it('does not append synthetic SubAgent root rows when collaboration events are written after tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-subagent-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '55555555-5555-5555-5555-555555555555';
    const childThreadId = '66666666-6666-6666-6666-666666666666';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent-tail' }),
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

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:00.250Z',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ role: 'explorer', prompt: 'inspect the repo' }),
          call_id: 'call_spawn_1',
        },
      })
      + responseItemLine({
        timestamp: '2026-01-02T00:00:00.500Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_spawn_1',
          output: JSON.stringify({ agent_id: childThreadId, nickname: 'Lovelace' }),
        },
      })
      + `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_agent_spawn_end',
          sender_thread_id: sessionId,
          new_thread_id: childThreadId,
          new_agent_nickname: 'Lovelace',
          new_agent_role: 'explorer',
          prompt: 'inspect the repo',
        },
      })}\n`
      + `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: {
          type: 'collab_waiting_end',
          sender_thread_id: sessionId,
          agent_statuses: [{
            thread_id: childThreadId,
            agent_nickname: 'Lovelace',
            agent_role: 'explorer',
            status: { completed: 'done' },
          }],
        },
      })}\n`
      + responseItemLine({
        timestamp: '2026-01-02T00:00:02.500Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `<subagent_notification>\n{"agent_id":"${childThreadId}","status":{"completed":"done"}}\n</subagent_notification>`,
          }],
        },
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

    expect(next.items).toHaveLength(0);
    expect(next.truncated).toBe(false);
    expect(next.nextCursor).toBeTruthy();
    expect(next.nextCursor).not.toBe(init.nextCursor);
  });

  it('returns appended child rollout sidechain messages when a spawned subagent writes to its rollout file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-child-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '99999999-9999-9999-9999-999999999999';
    const childThreadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);

    await writeFile(
      parentFilePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent-tail' }),
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

    await appendFile(
      parentFilePath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_agent_spawn_end',
          sender_thread_id: sessionId,
          new_thread_id: childThreadId,
          new_agent_nickname: 'Lovelace',
          new_agent_role: 'explorer',
          prompt: 'inspect the repo',
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      childFilePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'child summary' }] },
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

    expect(next.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'message',
                message: 'child summary',
                sidechainId: childThreadId,
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it('returns newly discovered child rollout items even when they sort before the previously seen merged tail item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-child-out-of-order-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '12121212-1212-1212-1212-121212121212';
    const childThreadId = '34343434-3434-3434-3434-343434343434';
    const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);

    await writeFile(
      parentFilePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/out-of-order-child' })
      + responseItemLine({
        timestamp: '2026-01-02T00:00:03.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'parent tail anchor' }] },
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

    await appendFile(
      parentFilePath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:04.000Z',
        payload: {
          type: 'collab_agent_spawn_end',
          sender_thread_id: sessionId,
          new_thread_id: childThreadId,
          new_agent_nickname: 'Lovelace',
          new_agent_role: 'explorer',
          prompt: 'inspect the repo',
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      childFilePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'late-discovered child summary' }] },
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

    expect(next.truncated).toBe(false);
    expect(next.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'message',
                message: 'late-discovered child summary',
                sidechainId: childThreadId,
              }),
            }),
          }),
        }),
      ]),
    );
  });
});
