import { access, mkdir, mkdtemp, readFile, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';
import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerScript,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import { pageCodexTranscript } from './pageCodexTranscript';
import { DirectSessionsProviderUnavailableError } from '@/backends/directSessions/providerOps';
import { loadDirectSessionTranscriptItems } from '@/api/directSessions/import/loadDirectSessionTranscriptItems';
import { listCodexDirectSessionCandidatesViaRollouts } from './listCodexDirectSessionCandidatesViaRollouts';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

function eventMsgLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'event_msg', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('pageCodexTranscript', () => {
  it('preserves rollout reasoning summaries as thinking instead of ordinary assistant text', async () => withTempDir('happier-codex-reasoning-', async root => {
    const codexHome = join(root, 'home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = 'reasoning-session';
    await writeFile(join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      responseItemLine({ timestamp: '2026-01-02T00:00:01.000Z', payload: {
        type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the boundary' }], encrypted_content: 'opaque-private-reasoning',
      } }) + responseItemLine({ timestamp: '2026-01-02T00:00:02.000Z', payload: {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }],
      } }));
    const page = await pageCodexTranscript({ source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome }, activeServerDir: join(root, 'server'), remoteSessionId: sessionId,
      direction: 'older', maxItems: 10, maxBytes: 64 * 1024,
    });
    expect(page.items.map(item => item.raw)).toMatchObject([
      { role: 'agent', content: { type: 'codex', data: { type: 'thinking', text: 'Check the boundary' } } },
      { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'answer' } } },
    ]);
    expect(JSON.stringify(page.items)).not.toContain('opaque-private-reasoning');
  }));

  it('fails an import explicitly when a nine-MiB native record exceeds the existing read allowance', async () => withTempDir('happier-codex-direct-oversized-', async (root) => {
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await writeFile(join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      sessionMetaLine({ id: sessionId }) + responseItemLine({ timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'function_call_output', call_id: 'large-result', output: 'x'.repeat(9 * 1024 * 1024) } }));
    const candidates = await listCodexDirectSessionCandidatesViaRollouts({ source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome }, activeServerDir: join(root, 'server'), limit: 10 });
    expect(candidates.candidates.map(candidate => candidate.remoteSessionId)).toContain(sessionId);
    await expect(loadDirectSessionTranscriptItems({ maxPages: 2, readPage: cursor => pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome },
      activeServerDir: join(root, 'server'), remoteSessionId: sessionId, direction: 'older',
      maxBytes: 64 * 1024, maxItems: 30, cursor,
    }) })).rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE' });
  }));

  it('pages newest-first (direction=older) from a rollout jsonl transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-'));
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
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:03.000Z',
          payload: { type: 'function_call', call_id: 'call1', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:04.000Z',
          payload: { type: 'function_call_output', call_id: 'call1', output: JSON.stringify({ ok: true }) },
        }),
      'utf8',
    );
    await utimes(filePath, new Date('2026-01-02T00:00:04.000Z'), new Date('2026-01-02T00:00:04.000Z'));

    const rawPage = await readJsonlFileBackwardPage({
      filePath,
      endOffsetBytes: null,
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });
    expect(rawPage.items.map((item) => (item.value as any)?.payload?.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);

    const first = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    const firstTypes = first.items.map((item) => {
      const raw: any = item.raw;
      if (raw?.role !== 'agent') return raw?.content?.type;
      return raw?.content?.data?.type;
    });
    expect(firstTypes).toEqual(['tool-call', 'tool-call-result']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.tailCursor).toBeTruthy();

    const second = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items.map((m) => m.raw.role)).toEqual(['user', 'agent']);
    const secondTypes = second.items.map((item) => {
      const raw: any = item.raw;
      if (raw?.role !== 'agent') return raw?.content?.type;
      return raw?.content?.data?.type;
    });
    expect(secondTypes).toEqual(['text', 'message']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('maps Codex rollout compaction markers into direct transcript events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-compaction-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + eventMsgLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'context_compacted', turn_id: 'turn_compact' },
        }),
      'utf8',
    );
    await utimes(filePath, new Date('2026-01-02T00:00:01.000Z'), new Date('2026-01-02T00:00:01.000Z'));

    const page = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.raw).toEqual({
      role: 'agent',
      content: {
        type: 'event',
        id: expect.any(String),
        data: expect.objectContaining({
          type: 'context-compaction',
          phase: 'completed',
          lifecycleId: 'codex:context-compaction:turn_compact',
          provider: 'codex',
          source: 'provider-event',
          providerEventId: 'turn_compact',
        }),
      },
    });
  });

  it('rejects metadata-only history when rollout files and the native history API are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-app-server-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });

    const sessionId = 'remote_preview';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      initializeName: 'fake',
      nonArchivedThreads: [{
        id: sessionId,
        name: 'App server preview',
        updatedAt: 1736000100,
        cwd: '/repo/from-app-server',
      }],
    });

    await expect(pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome }),
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    })).rejects.toBeInstanceOf(DirectSessionsProviderUnavailableError);

  });

  it('does not start the Codex app-server metadata fallback when rollout files exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-no-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'page-existing-rollout-session';
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
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/no-app-server' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from rollout' }] },
        }),
      'utf8',
    );

    const result = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: createCodexAppServerProcessEnv(fakeAppServer, {
        CODEX_HOME: codexHome,
        APP_SERVER_MARKER: markerPath,
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(result.items).toHaveLength(1);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it('advances the backward cursor across non-renderable rollout lines at the tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-non-renderable-tail-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'page-non-renderable-tail-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'visible older item' }] },
      })
      + sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:02.000Z', cwd: '/repo/non-renderable-tail' })
      + sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:03.000Z', cwd: '/repo/non-renderable-tail' })
      + sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:04.000Z', cwd: '/repo/non-renderable-tail' }),
      'utf8',
    );

    const first = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(first.items).toHaveLength(0);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items).toHaveLength(1);
    expect(JSON.stringify(second.items[0] ?? null)).toContain('visible older item');
    expect(second.hasMore).toBe(false);
  });

  it('classifies an invalid backward cursor as a source discontinuity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-invalid-cursor-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = 'page-invalid-cursor-session';
    await writeFile(
      join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      responseItemLine({
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
      }),
      'utf8',
    );

    const page = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      cursor: 'invalid-cursor',
      maxBytes: 1024,
      maxItems: 10,
    });

    expect(page.truncated).toBe(true);
    expect(page.truncationReason).toBe('source_discontinuity');
  });

  it('maps Codex collaboration rollout events into generic SubAgent tool rows for direct transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-subagent-page-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '33333333-3333-3333-3333-333333333333';
    const childThreadId = '44444444-4444-4444-4444-444444444444';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent' })
        + responseItemLine({
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

    const result = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call',
            callId: childThreadId,
            name: 'SubAgent',
            input: expect.objectContaining({
              threadId: childThreadId,
              prompt: 'inspect the repo',
              nickname: 'Lovelace',
              role: 'explorer',
            }),
          }),
        }),
      }),
    );
    expect(result.items[1]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call-result',
            callId: childThreadId,
            output: expect.objectContaining({
              threadId: childThreadId,
              status: 'completed',
            }),
          }),
        }),
      }),
    );
  });

  it('includes child rollout transcript messages as sidechain items in direct transcript paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-child-page-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '77777777-7777-7777-7777-777777777777';
    const childThreadId = '88888888-8888-8888-8888-888888888888';
    const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);

    await writeFile(
      parentFilePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent' })
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
        })}\n`,
      'utf8',
    );
    await writeFile(
      childFilePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'child reasoning' }] },
      }) + responseItemLine({
        timestamp: '2026-01-02T00:00:02.500Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'child summary' }] },
      }) + responseItemLine({
        timestamp: '2026-01-02T00:00:03.000Z',
        payload: { type: 'function_call', call_id: 'child-call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) },
      }),
      'utf8',
    );

    const result = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({ data: expect.objectContaining({
              type: 'thinking', text: 'child reasoning', sidechainId: childThreadId,
            }) }),
          }),
        }),
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
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'tool-call',
                callId: 'child-call-1',
                sidechainId: childThreadId,
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it('does not materialize provider-owned image generation files while browsing direct transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-page-media-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    const providerImagePath = join(root, 'provider-owned.png');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(providerImagePath, Buffer.from('provider image bytes'), 'utf8');

    const sessionId = '77777777-7777-7777-7777-777777777777';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: root })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: {
            type: 'image_generation_call',
            id: 'img_1',
            status: 'completed',
            saved_path: providerImagePath,
          },
        }),
      'utf8',
    );
    await utimes(filePath, new Date('2026-01-02T00:00:01.000Z'), new Date('2026-01-02T00:00:01.000Z'));

    const page = await pageCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(JSON.stringify(page.items)).not.toContain('session_media.v1');
    await expect(stat(join(root, '.happier', 'uploads', 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(providerImagePath, 'utf8')).resolves.toBe('provider image bytes');
  });
});
