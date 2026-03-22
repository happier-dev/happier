import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
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
        v: 1,
        ts: 1700000000000,
        direction: 'outbound',
        sessionId: 'sess_123',
        protocol: 'acp',
        provider: 'codex',
        kind: 'tool-call',
        payload: { name: 'read', input: { filePath: '/etc/hosts' } },
      });

      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        v: 1,
        sessionId: 'sess_123',
        protocol: 'acp',
        provider: 'codex',
        kind: 'tool-call',
      });
    });
  });

  it('does not treat non-Error payloads with a name field as Error-like', () => {
    withTempDirSync('happy-tool-trace-name-field-', (dir) => {
      const filePath = join(dir, 'trace.jsonl');
      const writer = new ToolTraceWriter({ filePath });

      writer.record({
        v: 1,
        ts: 1700000000000,
        direction: 'outbound',
        sessionId: 'sess_123',
        protocol: 'acp',
        provider: 'opencode',
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
          v: 1,
          ts: 1700000000000,
          direction: 'outbound',
          sessionId: 'sess_123',
          protocol: 'acp',
          provider: 'codex',
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
  it('writes multiple events to a single file when only DIR is set', () => {
    vi.useFakeTimers();
    withToolTraceDir('happy-tool-trace-dir-', (dir) => {
      vi.setSystemTime(new Date('2026-01-25T10:00:00.000Z'));
      recordToolTraceEvent({
        direction: 'outbound',
        sessionId: 'sess_1',
        protocol: 'acp',
        provider: 'codex',
        kind: 'tool-call',
        payload: { type: 'tool-call', name: 'read', input: { filePath: '/etc/hosts' } },
      });
      vi.setSystemTime(new Date('2026-01-25T10:00:01.000Z'));
      recordToolTraceEvent({
        direction: 'outbound',
        sessionId: 'sess_1',
        protocol: 'acp',
        provider: 'codex',
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
  it('is exported', async () => {
    const mod = await import('./toolTrace');
    expect(typeof mod.initToolTraceIfEnabled).toBe('function');
  });

  it('creates an empty file when tracing enabled and STACK_TOOL_TRACE_FILE is set', async () => {
    await withToolTraceFile('happy-tool-trace-init-', (filePath) => {
      expect(existsSync(filePath)).toBe(false);
      initToolTraceIfEnabled();
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe('');
    });
  });
});
