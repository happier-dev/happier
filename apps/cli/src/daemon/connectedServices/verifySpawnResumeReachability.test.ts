import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from './connectedServiceChildEnvironment';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';
import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';

/**
 * P3-2 — direct unit tests for `verifySpawnResumeReachability`.
 *
 * The production code is already covered TRANSITIVELY by the full spawn path; these tests exercise
 * the WRAPPER ITSELF in isolation so that the three structural properties of
 * `verifySpawnResumeReachability` are directly observable:
 *
 *   (a) target-root derivation — the explicit env key
 *       (`HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT`) is preferred; when absent the root
 *       is derived from the parent of the sole absolute env value (legacy fallback).
 *   (b) dispatch ok — the provider probe is invoked with the resolved root, a real file resolves ok.
 *   (c) dispatch miss — a session id with no matching file on any search root resolves not-ok.
 *
 * Provider: PI (only provider with a real `verifyResumeReachable` catalog hook that exercises the
 * full search-root chain). Tests use real file system; no mocking.
 */

const CWD = '/tmp/vssrr-test-project';

function makeEnvWithExplicitRoot(root: string): Readonly<Record<string, string>> {
  return {
    [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: root,
    PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
  };
}

function makeEnvWithLegacyFallbackOnly(singleAbsoluteValue: string): Readonly<Record<string, string>> {
  // No HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT key → root must be derived from
  // the parent of the single absolute env value.
  return { PI_CODING_AGENT_DIR: singleAbsoluteValue };
}

describe('verifySpawnResumeReachability — wrapper unit (P3-2)', () => {
  it('(b) returns ok when the session file exists in the materialized target (real dispatch, explicit root key)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'vssrr-ok-'));
    const sessionId = 'vssrr-hit-session';
    const originalHome = process.env.HOME;

    try {
      // Build a fakeHome so the native ~/.pi/ search does not accidentally find production files.
      const fakeHome = join(tmpRoot, 'home');
      await mkdir(fakeHome);
      process.env.HOME = fakeHome;

      // Create the PI session file under the materialized target directory that the explicit root key
      // points at. verifySpawnResumeReachability must resolve the root from the env key and hand
      // it to the provider probe, which must then find the file and return ok.
      const piAgentDir = join(tmpRoot, 'pi-agent-dir');
      const sessionsDir = join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd(CWD));
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `2026-05-29T00-00-00-000Z_${sessionId}.jsonl`), '{"type":"session"}\n');

      const result = await verifySpawnResumeReachability({
        agentId: 'pi',
        vendorResumeId: sessionId,
        cwd: CWD,
        materializedEnv: makeEnvWithExplicitRoot(tmpRoot),
        candidatePersistedSessionFile: null,
      });

      expect(result.ok).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('(c) returns not-ok (structured) when no session file exists anywhere on the search roots', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'vssrr-miss-'));
    const sessionId = 'vssrr-miss-session';
    const originalHome = process.env.HOME;

    try {
      // Fake home: native root is empty → no match from native scan.
      const fakeHome = join(tmpRoot, 'home');
      await mkdir(fakeHome);
      process.env.HOME = fakeHome;

      // Materialized target exists but contains no session files for this id.
      const piAgentDir = join(tmpRoot, 'pi-agent-dir');
      await mkdir(join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd(CWD)), { recursive: true });

      const result = await verifySpawnResumeReachability({
        agentId: 'pi',
        vendorResumeId: sessionId,
        cwd: CWD,
        materializedEnv: makeEnvWithExplicitRoot(tmpRoot),
        candidatePersistedSessionFile: null,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; reason: string }).reason).toBeTruthy();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('(a) derives root from the legacy single-absolute-value fallback when the explicit env key is absent', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'vssrr-derive-'));
    const sessionId = 'vssrr-derive-session';
    const originalHome = process.env.HOME;

    try {
      const fakeHome = join(tmpRoot, 'home');
      await mkdir(fakeHome);
      process.env.HOME = fakeHome;

      // PI_CODING_AGENT_DIR is an absolute path whose parent IS the materialized root.
      // resolveConnectedServiceTargetMaterializedRoot will derive root = parent(PI_CODING_AGENT_DIR)
      // = tmpRoot/materialized-root. Place the session file under that derived root's agent-dir.
      const derivedRoot = join(tmpRoot, 'materialized-root');
      const piAgentDir = join(derivedRoot, 'pi-agent-dir');
      const sessionsDir = join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd(CWD));
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `2026-05-29T00-00-00-000Z_${sessionId}.jsonl`), '{"type":"session"}\n');

      // Env has only PI_CODING_AGENT_DIR (an absolute value) — no explicit root key. The legacy
      // derive-fallback must resolve root = parent(piAgentDir) = derivedRoot. The probe then
      // searches piAgentDir/sessions/... and finds the file.
      const result = await verifySpawnResumeReachability({
        agentId: 'pi',
        vendorResumeId: sessionId,
        cwd: CWD,
        materializedEnv: makeEnvWithLegacyFallbackOnly(piAgentDir),
        candidatePersistedSessionFile: null,
      });

      expect(result.ok).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
