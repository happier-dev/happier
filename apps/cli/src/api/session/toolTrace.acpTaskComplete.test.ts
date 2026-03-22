import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';
import { recordAcpToolTraceEventIfNeeded } from './toolTrace';

describe('recordAcpToolTraceEventIfNeeded', () => {
  it('records ACP task_complete events when tool tracing is enabled', async () => {
    await withToolTraceFile('happy-acp-trace-', async (filePath) => {
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
    });
  });
});
