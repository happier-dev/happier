import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  discoverNewAntigravityConversationId,
  readAntigravityConversationAffinity,
  resolveAntigravityBrainDir,
  snapshotAntigravityConversations,
  writeAntigravityConversationAffinity,
} from './conversationStore.js';

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

  it('persists and reads safe session affinity metadata', () => {
    const metadata = writeAntigravityConversationAffinity({}, 'conv-123');
    expect(readAntigravityConversationAffinity(metadata)).toBe('conv-123');
    expect(JSON.stringify(metadata)).not.toMatch(/oauth|token|secret|credential/i);
  });
});
