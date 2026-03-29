import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCodexSessionTitleFromRollout } from './readCodexSessionTitleFromRollout';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('readCodexSessionTitleFromRollout', () => {
  it('skips title boilerplate and scans later pages for the first meaningful user task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-title-'));
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-03-06T00-00-00-${sessionId}.jsonl`);
    const boilerplate = [
      '# Session title',
      "At the start of the session (before you respond to the first user message), you MUST call the change_title tool once to set a short, descriptive session title based on the user's message.",
    ].join('\n');
    const meaningfulTask = 'Investigate direct transcript paging parity in the direct session browser';

    const lines = [
      sessionMetaLine({ id: sessionId, timestamp: '2026-03-06T00:00:00.000Z', cwd: '/repo/one' }),
      ...Array.from({ length: 80 }, (_, index) =>
        responseItemLine({
          timestamp: `2026-03-06T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: boilerplate }],
          },
        }),
      ),
      responseItemLine({
        timestamp: '2026-03-06T00:02:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: meaningfulTask }],
        },
      }),
    ];

    await writeFile(filePath, lines.join(''), 'utf8');

    await expect(readCodexSessionTitleFromRollout(filePath)).resolves.toBe(meaningfulTask);
  });
});
