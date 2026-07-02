import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findCodexRolloutFileById,
  findCodexRolloutFileByIdSync,
  isMatchingCodexRolloutFileName,
} from './sessionFileSearch.js';

describe('Codex rollout session file search', () => {
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
