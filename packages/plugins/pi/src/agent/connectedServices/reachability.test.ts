import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatPiSessionDirectoryForCwd } from '../sessionFiles.js';
import { verifyResumeReachablePi } from './reachability.js';

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

  it('targetStrict: fails closed when the file lives only in staging/source roots', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-pi-strict-home-'));
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-reachable-strict-source-'));
    const originalHome = process.env.HOME;
    try {
      const cwd = '/tmp/native-only-project';
      const nativeDir = join(fakeHome, '.pi', 'agent', 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, '2026-05-27T00-00-00-000Z_pi-session-native.jsonl'), '{}\n');
      await mkdir(join(root, 'pi-sessions', '--workdir--'), { recursive: true });
      await writeFile(join(root, 'pi-sessions', '--workdir--', '2026-05-27T00-00-00-000Z_pi-session-native.jsonl'), '{}\n');
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
