import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { mkdir } from 'node:fs/promises';
import { withTempDir, withTempDirSync } from '@/testkit/fs/tempDir';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';

import { __resetToolTraceForTests, initToolTraceIfEnabled, recordToolTraceEvent, ToolTraceWriter } from './toolTrace';

function withToolTraceDir(prefix: string, fn: (dir: string) => void): void {
  const envScope = createEnvKeyScope([
    'HAPPIER_STACK_TOOL_TRACE',
    'HAPPIER_STACK_TOOL_TRACE_DIR',
    'HAPPIER_STACK_TOOL_TRACE_FILE',
  ]);

  try {
    withTempDirSync(prefix, (dir) => {
      envScope.patch({
        HAPPIER_STACK_TOOL_TRACE: '1',
        HAPPIER_STACK_TOOL_TRACE_DIR: dir,
        HAPPIER_STACK_TOOL_TRACE_FILE: undefined,
      });
      __resetToolTraceForTests();
      fn(dir);
    });
  } finally {
    envScope.restore();
    __resetToolTraceForTests();
  }
}

afterEach(() => {
  vi.useRealTimers();
  __resetToolTraceForTests();
});

describe('ToolTraceWriter', () => {
  it('writes JSONL events', () => {
    withTempDirSync('happy-tool-trace-', (dir) => {
      const filePath = join(dir, 'trace.jsonl');
      const writer = new ToolTraceWriter({ filePath });

      writer.record({
        v: 2,
        ts: 1700000000000,
        direction: 'outbound',
        sessionId: 'sess_123',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-call',
        payload: { name: 'read', input: { filePath: '/etc/hosts' } },
      });

      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        v: 2,
        sessionId: 'sess_123',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-call',
      });
    });
  });

  it('does not treat non-Error payloads with a name field as Error-like', () => {
    withTempDirSync('happy-tool-trace-name-field-', (dir) => {
      const filePath = join(dir, 'trace.jsonl');
      const writer = new ToolTraceWriter({ filePath });

      writer.record({
        v: 2,
        ts: 1700000000000,
        direction: 'outbound',
        sessionId: 'sess_123',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
        kind: 'tool-call',
        payload: {
          type: 'tool-call',
          callId: 'call_123',
          name: 'Bash',
          input: { command: 'echo TRACE_OK' },
        },
      });

      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0] as string) as { payload?: any };
      expect(parsed.payload).toMatchObject({
        type: 'tool-call',
        callId: 'call_123',
        name: 'Bash',
      });
    });
  });

  it('does not throw when payload contains circular references', () => {
    withTempDirSync('happy-tool-trace-circular-', (dir) => {
      const filePath = join(dir, 'trace.jsonl');
      const writer = new ToolTraceWriter({ filePath });

      const circular: Record<string, unknown> = { ok: true };
      circular.self = circular;

      expect(() => {
        writer.record({
          v: 2,
          ts: 1700000000000,
          direction: 'outbound',
          sessionId: 'sess_123',
          source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          kind: 'tool-call',
          payload: circular,
        });
      }).not.toThrow();

      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as { payload?: unknown };
      expect(typeof parsed.payload).toBe('object');
    });
  });
});

describe('recordToolTraceEvent', () => {
  it('records qualified native provenance without a vendor protocol', async () => {
    await withToolTraceFile('happy-tool-trace-native-', (filePath) => {
      const source = { protocol: 'native' as const, agent: { pluginId: 'acme.muse', localId: 'muse' } };
      recordToolTraceEvent({
        direction: 'outbound', sessionId: 'native-session', source,
        kind: 'tool-call', payload: { name: 'Read', input: { path: '/source' } },
      });
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ v: 2, source });
    });
  });

  it('writes multiple events to a single file when only DIR is set', () => {
    vi.useFakeTimers();
    withToolTraceDir('happy-tool-trace-dir-', (dir) => {
      vi.setSystemTime(new Date('2026-01-25T10:00:00.000Z'));
      recordToolTraceEvent({
        direction: 'outbound',
        sessionId: 'sess_1',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-call',
        payload: { type: 'tool-call', name: 'read', input: { filePath: '/etc/hosts' } },
      });
      vi.setSystemTime(new Date('2026-01-25T10:00:01.000Z'));
      recordToolTraceEvent({
        direction: 'outbound',
        sessionId: 'sess_1',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-result',
        payload: { type: 'tool-result', callId: 'c1', output: { ok: true } },
      });

      const files = readdirSync(dir).filter((fileName) => fileName.endsWith('.jsonl'));
      expect(files).toHaveLength(1);

      const raw = readFileSync(join(dir, files[0] as string), 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(2);
    });
  });
});

describe('initToolTraceIfEnabled', () => {
  it('creates an empty file when tracing enabled and STACK_TOOL_TRACE_FILE is set', async () => {
    await withToolTraceFile('happy-tool-trace-init-', (filePath) => {
      expect(existsSync(filePath)).toBe(false);
      initToolTraceIfEnabled();
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe('');
    });
  });
});

it.each(['file', 'directory'] as const)('routes each hosted Session tool trace to its own relative %s', async destination => {
  await withTempDir('tool-trace-sessions-', async root => {
    const scope = createEnvKeyScope(['HAPPIER_STACK_TOOL_TRACE', 'HAPPIER_STACK_TOOL_TRACE_FILE']);
    scope.patch({ HAPPIER_STACK_TOOL_TRACE: '1', HAPPIER_STACK_TOOL_TRACE_FILE: join(root, 'host.jsonl') });
    try {
      await Promise.all(['first', 'second', 'disabled'].map(async sessionId => {
        const cwd = join(root, sessionId);
        await mkdir(cwd);
        await runAddedHostedSession({ environment: { ...process.env,
          HAPPIER_STACK_TOOL_TRACE: sessionId === 'disabled' ? '0' : '1',
          HAPPIER_STACK_TOOL_TRACE_FILE: destination === 'file' ? 'trace.jsonl' : undefined,
          HAPPIER_STACK_TOOL_TRACE_DIR: destination === 'directory' ? 'traces' : undefined,
        }, workingDirectory: cwd, end() {} }, async () => {
          await Promise.resolve();
          recordToolTraceEvent({ direction: 'outbound', sessionId,
            source: { protocol: 'native', agent: { pluginId: 'fixture', localId: 'fixture' } },
            kind: 'tool-call', payload: { sessionId } });
        });
        if (sessionId === 'disabled') {
          expect(readdirSync(cwd)).toEqual([]);
        } else {
          const file = destination === 'file' ? join(cwd, 'trace.jsonl')
            : join(cwd, 'traces', readdirSync(join(cwd, 'traces'))[0]!);
          expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ sessionId, payload: { sessionId } });
        }
      }));
      expect(existsSync(join(root, 'host.jsonl'))).toBe(false);
    } finally { scope.restore(); }
  });
});
