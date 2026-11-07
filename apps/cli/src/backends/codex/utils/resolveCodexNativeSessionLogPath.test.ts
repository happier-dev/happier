import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCodexNativeSessionLogPath } from './resolveCodexNativeSessionLogPath';

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

describe('resolveCodexNativeSessionLogPath', () => {
  it('keeps searching the same sessions tree after a newer compressed match', async () => {
    const newerDay = join(codexHome, 'sessions', '2026', '08', '18');
    await mkdir(newerDay, { recursive: true });
    await writeFile(join(newerDay, `rollout-2026-08-18T10-00-00-${VENDOR_RESUME_ID}.jsonl.zst`),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(rolloutPath);
  });

  it('exposes a raw log only after Codex materializes its compressed rollout', async () => {
    await rm(rolloutPath);
    await writeFile(`${rolloutPath}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    const input = { vendorResumeId: VENDOR_RESUME_ID, env: { CODEX_HOME: codexHome } };
    await expect(resolveCodexNativeSessionLogPath(input)).resolves.toBeNull();
    await writeFile(rolloutPath, '{}\n');
    await expect(resolveCodexNativeSessionLogPath(input)).resolves.toBe(rolloutPath);
  });

  it('finds the active rollout with the exact vendor-resume suffix', async () => {
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(rolloutPath);
  });

  it('finds the archived rollout with the same exact vendor-resume suffix', async () => {
    await rm(rolloutPath);
    await writeFile(`${rolloutPath}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
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
});
