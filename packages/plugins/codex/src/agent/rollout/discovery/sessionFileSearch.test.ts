import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findCodexRolloutFileById,
  findCodexRolloutFileByIdSync,
  isMatchingCodexRolloutFileName,
} from './sessionFileSearch.js';

describe('Codex rollout session file search', () => {
  it('finds compressed-only rollouts and prefers an existing plain sibling in both catalog paths', async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'codex-compressed-discovery-'));
    const vendorResumeId = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
    const plain = join(sessionsRoot, `rollout-2026-11-06T00-00-00-${vendorResumeId}.jsonl`);
    const input = { sessionsRoot, vendorResumeId };
    try {
      // Name-only discovery leaves decoding and validation to Codex.
      await writeFile(`${plain}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
      expect(await findCodexRolloutFileById(input)).toBe(`${plain}.zst`);
      expect(findCodexRolloutFileByIdSync(input)).toBe(`${plain}.zst`);
      await writeFile(plain, '{}\n');
      expect(await findCodexRolloutFileById(input)).toBe(plain);
      expect(findCodexRolloutFileByIdSync(input)).toBe(plain);
      expect(isMatchingCodexRolloutFileName(`${plain}.zst.tmp`, vendorResumeId)).toBe(false);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('finds nested rollout files by provider session id without following symlinked directories', async () => {
    const root = join(tmpdir(), `happier-codex-session-file-search-${process.pid}-${Date.now()}`);
    const sessionsRoot = join(root, 'sessions');
    const linkedRoot = join(root, 'linked');
    const vendorResumeId = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
    const rolloutPath = join(
      sessionsRoot,
      '2026',
      '06',
      '01',
      `rollout-2026-06-01T10-00-00-${vendorResumeId}.jsonl`,
    );
    const linkedRolloutPath = join(
      linkedRoot,
      `rollout-2026-06-01T10-00-00-${vendorResumeId}.jsonl`,
    );

    try {
      await mkdir(join(sessionsRoot, '2026', '06', '01'), { recursive: true });
      await mkdir(linkedRoot, { recursive: true });
      await writeFile(rolloutPath, '{}\n');
      await writeFile(linkedRolloutPath, '{}\n');
      await symlink(linkedRoot, join(sessionsRoot, 'linked'));

      expect(isMatchingCodexRolloutFileName(`rollout-2026-06-01T10-00-00-${vendorResumeId}.jsonl`, vendorResumeId)).toBe(true);
      expect(await findCodexRolloutFileById({ sessionsRoot, vendorResumeId })).toBe(rolloutPath);
      expect(findCodexRolloutFileByIdSync({ sessionsRoot, vendorResumeId })).toBe(rolloutPath);
      await rm(rolloutPath);
      expect(await findCodexRolloutFileById({ sessionsRoot, vendorResumeId })).toBeNull();
      expect(findCodexRolloutFileByIdSync({ sessionsRoot, vendorResumeId })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches a continuation rollout by its thread id', () => {
    const threadId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const turnId = 'bbbbbbbb-2222-2222-2222-222222222222';
    expect(isMatchingCodexRolloutFileName(
      `rollout-2026-06-01T10-00-00-${threadId}_${turnId}.jsonl`,
      threadId,
    )).toBe(true);
  });

  it('matches UUID rollout identities case-insensitively while preserving opaque IDs exactly', () => {
    const threadId = 'cccccccc-3333-3333-3333-333333333333';
    expect(isMatchingCodexRolloutFileName(
      `rollout-2026-06-01T10-00-00-${threadId}.jsonl`,
      threadId.toUpperCase(),
    )).toBe(true);
    expect(isMatchingCodexRolloutFileName(
      'rollout-2026-06-01T10-00-00-opaque-id.jsonl',
      'OPAQUE-ID',
    )).toBe(false);
  });
});
