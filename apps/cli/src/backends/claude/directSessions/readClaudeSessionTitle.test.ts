import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readClaudeSessionTitle } from './readClaudeSessionTitle';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('readClaudeSessionTitle', () => {
  it('scans past non-title-bearing leading records until it finds meaningful user text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    const meaningfulTask = 'Validate infinite scrolling for direct Claude transcripts without dropping tool lines';

    const lines = [
      ...Array.from({ length: 80 }, (_, index) =>
        jsonlLine({
          type: 'user',
          uuid: `image-${index}`,
          cwd: '/repo/two',
          message: {
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'AAAA',
                },
              },
            ],
          },
        }),
      ),
      jsonlLine({
        type: 'user',
        uuid: 'actual-user-text',
        cwd: '/repo/two',
        message: { content: meaningfulTask },
      }),
    ];

    await writeFile(filePath, lines.join(''), 'utf8');

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe(meaningfulTask);
  });

  it('falls back to queued prompt content when the transcript never materializes a user message record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-queue-'));
    const projectDir = join(root, 'projects', 'proj-one');
    await mkdir(projectDir, { recursive: true });

    const filePath = join(projectDir, 'session-one.jsonl');
    const queuedPrompt = 'hello from queued direct Claude session';

    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'session-one',
          content: queuedPrompt,
        }),
        jsonlLine({
          type: 'queue-operation',
          operation: 'dequeue',
          sessionId: 'session-one',
        }),
      ].join(''),
      'utf8',
    );

    await expect(readClaudeSessionTitle(filePath)).resolves.toBe(queuedPrompt);
  });
});
