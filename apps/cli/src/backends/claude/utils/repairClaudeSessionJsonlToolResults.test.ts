import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { repairClaudeSessionJsonlToolResults } from './repairClaudeSessionJsonlToolResults';

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await writeFile(path, payload, 'utf8');
}

describe('repairClaudeSessionJsonlToolResults', () => {
  it('appends missing tool_result blocks for interrupted tool_use entries', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-jsonl-'));
    const transcriptPath = join(baseDir, 'sess_1.jsonl');

    await writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        uuid: 'asst_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'sleep 1000' },
            },
          ],
        },
      },
    ]);

    const result = await repairClaudeSessionJsonlToolResults({
      transcriptPath,
      cwd: baseDir,
      sessionId: 'sess_1',
    });

    expect(result.appendedToolUseIds).toEqual(['toolu_1']);
    const contents = await readFile(transcriptPath, 'utf8');
    expect(contents).toMatch(/\"type\":\"tool_result\"/);
    expect(contents).toMatch(/\"tool_use_id\":\"toolu_1\"/);
  });

  it('does not append when tool_result already exists', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-jsonl-present-'));
    const transcriptPath = join(baseDir, 'sess_1.jsonl');

    await writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        uuid: 'asst_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'sleep 1000' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'usr_1',
        isSidechain: false,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      },
    ]);

    const result = await repairClaudeSessionJsonlToolResults({
      transcriptPath,
      cwd: baseDir,
      sessionId: 'sess_1',
    });

    expect(result.appendedToolUseIds).toEqual([]);
  });

  it('respects onlyToolUseIds filter', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-jsonl-filter-'));
    const transcriptPath = join(baseDir, 'sess_1.jsonl');

    await writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        uuid: 'asst_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1000' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'sleep 1000' } },
          ],
        },
      },
    ]);

    const result = await repairClaudeSessionJsonlToolResults({
      transcriptPath,
      cwd: baseDir,
      sessionId: 'sess_1',
      onlyToolUseIds: ['toolu_2'],
    });

    expect(result.appendedToolUseIds).toEqual(['toolu_2']);
    const contents = await readFile(transcriptPath, 'utf8');
    expect(contents).toMatch(/\"tool_use_id\":\"toolu_2\"/);
    expect(contents).not.toMatch(/\"tool_use_id\":\"toolu_1\"/);
  });
});

