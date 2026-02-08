import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetToolTraceForTests, initToolTraceIfEnabled, recordToolTraceEvent, ToolTraceWriter } from './toolTrace';

const TRACE_ENV_KEYS = [
  'HAPPIER_STACK_TOOL_TRACE',
  'HAPPIER_STACK_TOOL_TRACE_DIR',
  'HAPPIER_STACK_TOOL_TRACE_FILE',
] as const;

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetTraceEnv(): void {
  for (const key of TRACE_ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  vi.useRealTimers();
  resetTraceEnv();
  __resetToolTraceForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ToolTraceWriter', () => {
  it('writes JSONL events', () => {
    const dir = createTempDir('happy-tool-trace-');
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

describe('recordToolTraceEvent', () => {
  it('writes multiple events to a single file when only DIR is set', () => {
    vi.useFakeTimers();
    const dir = createTempDir('happy-tool-trace-dir-');
    process.env.HAPPIER_STACK_TOOL_TRACE = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_DIR = dir;
    __resetToolTraceForTests();

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

describe('initToolTraceIfEnabled', () => {
  it('is exported', async () => {
    const mod = await import('./toolTrace');
    expect(typeof mod.initToolTraceIfEnabled).toBe('function');
  });

  it('creates an empty file when tracing enabled and STACK_TOOL_TRACE_FILE is set', () => {
    const dir = createTempDir('happy-tool-trace-init-');
    const filePath = join(dir, 'trace.jsonl');

    process.env.HAPPIER_STACK_TOOL_TRACE = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;
    __resetToolTraceForTests();

    expect(existsSync(filePath)).toBe(false);
    initToolTraceIfEnabled();
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('');
  });
});
