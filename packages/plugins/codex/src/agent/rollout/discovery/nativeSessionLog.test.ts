import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCodexNativeSessionLogPath,
  resolveCodexNativeTranscriptPathCandidate,
} from './nativeSessionLog.js';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../protocol/runtimeDescriptorV1.js';

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
  it('keeps searching the same sessions tree after a newer compressed match', async () => {
    const newerDay = join(codexHome, 'sessions', '2026', '08', '18');
    await mkdir(newerDay, { recursive: true });
    await writeFile(join(newerDay, `rollout-2026-08-18T10-00-00-${VENDOR_RESUME_ID}.jsonl.zst`),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID, env: { CODEX_HOME: codexHome },
    })).resolves.toBe(rolloutPath);
    await expect(resolveCodexNativeTranscriptPathCandidate({
      identity: { v: 1, vendorResumeId: VENDOR_RESUME_ID },
      runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer', providerSessionId: VENDOR_RESUME_ID, homePath: codexHome,
      }),
    })).resolves.toEqual({ path: rolloutPath, containmentRoot: codexHome });
  });

  it('exposes raw transcript paths only after Codex materializes a compressed rollout', async () => {
    await rm(rolloutPath);
    await writeFile(`${rolloutPath}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    const input = { vendorResumeId: VENDOR_RESUME_ID, env: { CODEX_HOME: codexHome } };
    const candidateInput = {
      identity: { v: 1 as const, vendorResumeId: VENDOR_RESUME_ID },
      runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer', providerSessionId: VENDOR_RESUME_ID, homePath: codexHome,
      }),
    };
    await expect(resolveCodexNativeSessionLogPath(input)).resolves.toBeNull();
    await expect(resolveCodexNativeTranscriptPathCandidate(candidateInput)).resolves.toBeNull();
    await writeFile(rolloutPath, '{}\n');
    await expect(resolveCodexNativeSessionLogPath(input)).resolves.toBe(rolloutPath);
    await expect(resolveCodexNativeTranscriptPathCandidate(candidateInput)).resolves.toEqual({ path: rolloutPath, containmentRoot: codexHome });
  });

  it('derives a native transcript candidate only from the canonical descriptor home path', async () => {
    const environmentCodexHome = join(root, 'environment-codex-home');
    const environmentRolloutDir = join(environmentCodexHome, 'sessions', '2026', '08', '17');
    const environmentRolloutPath = join(
      environmentRolloutDir,
      `rollout-2026-08-17T10-00-00-${VENDOR_RESUME_ID}.jsonl`,
    );
    await mkdir(environmentRolloutDir, { recursive: true });
    await writeFile(environmentRolloutPath, '{}\n');
    vi.stubEnv('CODEX_HOME', environmentCodexHome);

    try {
      await expect(resolveCodexNativeTranscriptPathCandidate({
        identity: { v: 1, vendorResumeId: VENDOR_RESUME_ID },
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
          backendMode: 'appServer',
          providerSessionId: VENDOR_RESUME_ID,
          homePath: codexHome,
        }),
      })).resolves.toEqual({
        path: rolloutPath,
        containmentRoot: codexHome,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not fall back to the process environment when the descriptor omits its home path', async () => {
    vi.stubEnv('CODEX_HOME', codexHome);

    try {
      await expect(resolveCodexNativeTranscriptPathCandidate({
        identity: { v: 1, vendorResumeId: VENDOR_RESUME_ID },
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
          backendMode: 'appServer',
          providerSessionId: VENDOR_RESUME_ID,
        }),
      })).resolves.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('finds the rollout file the vendor resume id names under the configured Codex home', async () => {
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: VENDOR_RESUME_ID,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(rolloutPath);
  });

  it('finds an archived rollout with the same exact vendor-resume suffix', async () => {
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

  it('matches the exact vendor resume id bytes instead of a stripped sibling rollout', async () => {
    const exactVendorResumeId = '  provider ses AB+cd==  ';
    const strippedVendorResumeId = exactVendorResumeId.trim();
    const dayDir = join(codexHome, 'sessions', '2026', '09', '13');
    const exactRolloutPath = join(dayDir, `rollout-2026-09-13T10-00-00-${exactVendorResumeId}.jsonl`);
    const strippedRolloutPath = join(dayDir, `rollout-2026-09-13T10-00-00-${strippedVendorResumeId}.jsonl`);
    await mkdir(dayDir, { recursive: true });
    await writeFile(exactRolloutPath, '{}\n');
    await writeFile(strippedRolloutPath, '{}\n');

    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: exactVendorResumeId,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(exactRolloutPath);
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: strippedVendorResumeId,
      env: { CODEX_HOME: codexHome },
    })).resolves.toBe(strippedRolloutPath);
    await expect(resolveCodexNativeTranscriptPathCandidate({
      identity: { v: 1, vendorResumeId: exactVendorResumeId },
      runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: exactVendorResumeId,
        homePath: codexHome,
      }),
    })).resolves.toEqual({ path: exactRolloutPath, containmentRoot: codexHome });
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: ' \n ',
      env: { CODEX_HOME: codexHome },
    })).resolves.toBeNull();
  });

  it('answers nothing for an id no rollout file on this machine carries', async () => {
    await expect(resolveCodexNativeSessionLogPath({
      vendorResumeId: '019e7cfd-0000-0000-0000-000000000000',
      env: { CODEX_HOME: codexHome },
    })).resolves.toBeNull();
  });
});
