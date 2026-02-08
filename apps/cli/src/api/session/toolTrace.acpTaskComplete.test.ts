import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { recordAcpToolTraceEventIfNeeded } from './toolTrace';

describe('recordAcpToolTraceEventIfNeeded', () => {
  it('records ACP task_complete events when tool tracing is enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-acp-trace-'));
    try {
      const filePath = join(dir, 'trace.jsonl');

      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;
      delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
      __resetToolTraceForTests();

      recordAcpToolTraceEventIfNeeded({
        sessionId: 'sess_123',
        provider: 'opencode',
        body: { type: 'task_complete', id: 'tc_1' },
      });

      const lines = readFileSync(filePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(1);

      const evt = JSON.parse(lines[0] as string) as any;
      expect(evt).toMatchObject({
        v: 1,
        direction: 'outbound',
        sessionId: 'sess_123',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'task_complete',
        payload: { type: 'task_complete' },
      });
    } finally {
      delete process.env.HAPPIER_STACK_TOOL_TRACE;
      delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
      __resetToolTraceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
