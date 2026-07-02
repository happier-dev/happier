import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';

import { verifyResumeReachablePi } from './verifyResumeReachablePi';

describe('verifyResumeReachablePi', () => {
  it('returns ok=true from the PI target layout under PI_CODING_AGENT_DIR/sessions/--encodedCwd--', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-modern-'));
    try {
      const targetDir = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--');
      const sessionFile = join(targetDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(targetDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: sessionFile,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to legacy pi-sessions layout for one release when modern layout does not contain the session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-legacy-'));
    try {
      const legacyDir = join(root, 'pi-sessions', '--workdir--');
      const sessionFile = join(legacyDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: sessionFile,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when no reachable session file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-miss-'));
    try {
      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({
        ok: false,
        reason: 'pi_session_file_not_found',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not accept a persisted candidate file whose name does not match the vendor resume id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-stale-candidate-'));
    try {
      const staleCandidate = join(
        root,
        'pi-agent-dir',
        'sessions',
        '--tmp-project--',
        '2026-05-27T00-00-00-000Z_pi-session-B.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(staleCandidate, '{}\n');

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'pi-session-A',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: staleCandidate,
      })).resolves.toEqual({
        ok: false,
        reason: 'pi_session_file_not_found',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the NATIVE ~/.pi/agent/sessions file for a native->connected switch (no target PI_CODING_AGENT_DIR) — VG-8', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-pi-home-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-pi-native-target-'));
    const originalHome = process.env.HOME;
    try {
      const cwd = '/tmp/native-project';
      const nativeDir = join(fakeHome, '.pi', 'agent', 'sessions', formatPiSessionDirectoryForCwd(cwd));
      const sessionFile = join(nativeDir, '2026-05-27T00-00-00-000Z_pi-session-native.jsonl');
      await mkdir(nativeDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');
      process.env.HOME = fakeHome;

      // Native->connected: target env has NO PI_CODING_AGENT_DIR yet (pre-switch native env) and the
      // materialized target root is still empty (import has not run). Before VG-8 the gate searched
      // only target roots and fail-closed a supported switch; now it proves reachability from the
      // native root the switch will import from.
      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: targetRoot,
        targetMaterializedEnv: {},
        vendorResumeId: 'pi-session-native',
        cwd,
      })).resolves.toEqual({ ok: true, resolvedPath: sessionFile });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it('targetStrict: returns ok=true ONLY from the final PI-readable path (PI_CODING_AGENT_DIR/sessions/--encodedCwd--)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-strict-ok-'));
    try {
      const piAgentDir = join(root, 'pi-agent-dir');
      const finalDir = join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd('/tmp/project'));
      const sessionFile = join(finalDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(finalDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: piAgentDir },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        targetStrict: true,
      })).resolves.toEqual({ ok: true, resolvedPath: sessionFile });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('targetStrict: fails closed when the file lives ONLY in pi-sessions staging (no false-positive via staging)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-strict-staging-'));
    try {
      // File present ONLY in the legacy `pi-sessions` staging root (the §2 false-positive vector).
      const stagingDir = join(root, 'pi-sessions', '--workdir--');
      await mkdir(stagingDir, { recursive: true });
      await writeFile(join(stagingDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl'), '{}\n');
      // The final PI-readable path exists but is empty (no session file).
      await mkdir(join(root, 'pi-agent-dir', 'sessions', formatPiSessionDirectoryForCwd('/tmp/project')), { recursive: true });

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir') },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        targetStrict: true,
      })).resolves.toEqual({ ok: false, reason: 'pi_session_file_not_found' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('targetStrict: fails closed when the file lives ONLY in the native ~/.pi root (excludes native source)', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-pi-strict-home-'));
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-strict-native-'));
    const originalHome = process.env.HOME;
    try {
      const cwd = '/tmp/native-only-project';
      const nativeDir = join(fakeHome, '.pi', 'agent', 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, '2026-05-27T00-00-00-000Z_pi-session-native.jsonl'), '{}\n');
      // Final PI-readable path exists but empty.
      await mkdir(join(root, 'pi-agent-dir', 'sessions', formatPiSessionDirectoryForCwd(cwd)), { recursive: true });
      process.env.HOME = fakeHome;

      await expect(verifyResumeReachablePi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir') },
        vendorResumeId: 'pi-session-native',
        cwd,
        targetStrict: true,
      })).resolves.toEqual({ ok: false, reason: 'pi_session_file_not_found' });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
