import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCodexNativeSessionLogPath } from './nativeSessionLog.js';

const VENDOR_RESUME_ID = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';

let root = '';
let codexHome = '';
let rolloutPath = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-native-log-'));
  codexHome = join(root, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '08', '17');
  await mkdir(dayDir, { recursive: true });
  rolloutPath = join(dayDir, `rollout-2026-08-17T10-00-00-${VENDOR_RESUME_ID}.jsonl`);
  await writeFile(rolloutPath, '{}\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Codex persists no transcript path in Session metadata, so the log it keeps is
 * only reachable by DERIVING it from the vendor resume id the host already
 * holds. That derivation is the Agent's own knowledge — a rollout file name, a
 * date-partitioned sessions root, a `CODEX_HOME` override — and belongs here
 * rather than in a host branch.
 */
describe('resolveCodexNativeSessionLogPath', () => {
  it('finds the rollout file the vendor resume id names under the configured Codex home', async () => {
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(rolloutPath);
  });

  it('finds an archived rollout with the same exact vendor-resume suffix', async () => {
    await rm(rolloutPath);
    const archivedDayDir = join(codexHome, 'archived_sessions', '2026', '08', '17');
    const archivedRolloutPath = join(
      archivedDayDir,
      `rollout-2026-08-17T10-00-00-${VENDOR_RESUME_ID}.jsonl`,
    );
    await mkdir(archivedDayDir, { recursive: true });
    await writeFile(archivedRolloutPath, '{}\n');

    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(archivedRolloutPath);
  });

  it('answers nothing for an id no rollout file on this machine carries', async () => {
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: '019e7cfd-0000-0000-0000-000000000000',
      env: { CODEX_HOME: codexHome },
    })).resolves.toBeNull();
  });
});
