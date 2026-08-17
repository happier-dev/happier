import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  discoverNewAntigravityConversationId,
  pageAntigravityConversationCandidates,
  readAntigravityConversationAffinity,
  resolveAntigravityBrainDir,
  resolveAntigravityConversationCandidate,
  snapshotAntigravityConversations,
  writeAntigravityConversationAffinity,
} from './conversationStore.js';
import { ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES } from './transcript/jsonl.js';

async function createConversation(
  brainDir: string,
  conversationId: string,
  lines: readonly string[],
): Promise<string> {
  const logsDir = join(brainDir, conversationId, '.system_generated', 'logs');
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = join(logsDir, 'transcript_full.jsonl');
  await writeFile(transcriptPath, `${lines.join('\n')}\n`);
  return transcriptPath;
}

describe('Antigravity cliPrint conversation store', () => {
  it('resolves the brain directory from HOME before GEMINI_CLI_HOME', () => {
    expect(resolveAntigravityBrainDir({
      GEMINI_CLI_HOME: '/scoped/gemini-home',
      HOME: '/user/home',
    })).toBe(join('/user/home', '.gemini', 'antigravity-cli', 'brain'));
  });

  it('discovers exactly one new transcript_full conversation directory', async () => {
    const brainDir = await mkdir(join(tmpdir(), `antigravity-brain-${Date.now()}-`), { recursive: true });
    await mkdir(join(brainDir, 'old-conv', '.system_generated', 'logs'), { recursive: true });
    await writeFile(join(brainDir, 'old-conv', '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n');
    const before = await snapshotAntigravityConversations(brainDir);

    await mkdir(join(brainDir, 'new-conv', '.system_generated', 'logs'), { recursive: true });
    await writeFile(join(brainDir, 'new-conv', '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n');
    const after = await snapshotAntigravityConversations(brainDir);

    expect(discoverNewAntigravityConversationId(before, after)).toEqual({
      status: 'found',
      conversationId: 'new-conv',
    });
  });

  it('returns deterministic diagnostics for no or multiple new conversations', async () => {
    const before = new Set(['old']);
    expect(discoverNewAntigravityConversationId(before, new Set(['old']))).toEqual({
      status: 'not_found',
    });
    expect(discoverNewAntigravityConversationId(before, new Set(['old', 'a', 'b']))).toEqual({
      status: 'ambiguous',
      candidates: ['a', 'b'],
    });
  });

  it('derives a candidate title from the first USER_INPUT record', async () => {
    const brainDir = join(tmpdir(), `antigravity-title-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createConversation(brainDir, 'conv-title', [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nReview   the\ncandidate   titles\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', text: 'later' }),
    ]);

    const candidate = await resolveAntigravityConversationCandidate({
      brainDir,
      conversationId: 'conv-title',
    });
    expect(candidate?.title).toBe('Review the candidate titles');
  });

  it.each([
    {
      name: 'unterminated request',
      content: '<USER_REQUEST>\nReview the titles\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md',
    },
    {
      name: 'metadata before the request',
      content: '<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\nReview\n',
    },
    {
      name: 'repeated request tags',
      content: '<USER_REQUEST>\nReview\n<USER_REQUEST>\nagain\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>',
    },
    {
      name: 'truncated mid-metadata',
      content: '<USER_REQUEST>\nReview\n<ADDITIONAL_METADATA>\nopen file: /repo/sec',
    },
  ])('omits the title instead of leaking workspace metadata on a $name', async ({ content }) => {
    const brainDir = join(tmpdir(), `antigravity-title-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createConversation(brainDir, 'conv-malformed', [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content }),
    ]);

    const candidate = await resolveAntigravityConversationCandidate({
      brainDir,
      conversationId: 'conv-malformed',
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.title).toBeUndefined();
  });

  it('omits the title when the first record has no usable user text', async () => {
    const brainDir = join(tmpdir(), `antigravity-title-none-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createConversation(brainDir, 'conv-no-title', [
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', text: 'assistant first' }),
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'later user text' }),
    ]);

    const candidate = await resolveAntigravityConversationCandidate({
      brainDir,
      conversationId: 'conv-no-title',
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.title).toBeUndefined();
  });

  it('reads at most one bounded head chunk per returned candidate', async () => {
    const brainDir = join(tmpdir(), `antigravity-title-bounded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const filler = JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', text: 'x'.repeat(4096) });
    const transcriptPaths: string[] = [];
    for (const conversationId of ['conv-a', 'conv-b', 'conv-c']) {
      transcriptPaths.push(await createConversation(brainDir, conversationId, [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nbounded\n</USER_REQUEST>' }),
        ...Array.from({ length: 128 }, () => filler),
      ]));
    }
    const fileSize = (await stat(transcriptPaths[0] ?? '')).size;
    expect(fileSize).toBeGreaterThan(ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES * 4);

    const reads: Readonly<{ position: number; length: number }>[] = [];
    const page = await pageAntigravityConversationCandidates({
      brainDir,
      maxItems: 1,
      fileSystem: {
        async stat(filePath) {
          const stats = await stat(filePath);
          return { size: stats.size, mtimeMs: stats.mtimeMs };
        },
        async read(filePath, position, length) {
          reads.push({ position, length });
          const handle = await open(filePath, 'r');
          try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            return buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        },
      },
    });

    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]?.title).toBe('bounded');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.position).toBe(0);
    expect(reads[0]?.length).toBeLessThanOrEqual(ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES);
  });

  it('persists and reads safe session affinity metadata', () => {
    const metadata = writeAntigravityConversationAffinity({}, 'conv-123');
    expect(readAntigravityConversationAffinity(metadata)).toBe('conv-123');
    expect(JSON.stringify(metadata)).not.toMatch(/oauth|token|secret|credential/i);
  });
});
