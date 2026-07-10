import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyResumeReachableOhMyPi } from './reachability.js';

describe('verifyResumeReachableOhMyPi', () => {
  it('returns ok when candidate persisted session file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-reachability-'));
    const candidate = join(root, 'sessions', '--tmp-project--', '2026-05-28T00-00-00-000Z_omp-session-1.jsonl');
    try {
      await mkdir(join(root, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(candidate, '{}\n');

      await expect(verifyResumeReachableOhMyPi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'omp-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toEqual({
        ok: true,
        resolvedPath: candidate,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('proves reachability from PI_CODING_AGENT_DIR session storage for cwd-encoded roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-reachability-'));
    const agentDir = join(root, 'omp-agent-dir');
    const sessionPath = join(
      agentDir,
      'sessions',
      '--tmp-project--',
      '2026-05-28T00-00-00-000Z_omp-session-1.jsonl',
    );
    try {
      await mkdir(join(agentDir, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionPath, '{}\n');

      await expect(verifyResumeReachableOhMyPi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: agentDir,
        },
        vendorResumeId: 'omp-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: await realpath(sessionPath),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('proves reachability from discovered non-Pi-encoded session roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-reachability-'));
    const agentDir = join(root, 'omp-agent-dir');
    const sessionPath = join(
      agentDir,
      'sessions',
      '-tmp-project',
      '2026-05-28T00-00-00-000Z_omp-session-1.jsonl',
    );
    try {
      await mkdir(join(agentDir, 'sessions', '-tmp-project'), { recursive: true });
      await writeFile(sessionPath, '{}\n');

      await expect(verifyResumeReachableOhMyPi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: agentDir,
        },
        vendorResumeId: 'omp-session-1',
        cwd: '/tmp/project',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: await realpath(sessionPath),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when no resume file is reachable', async () => {
    await expect(verifyResumeReachableOhMyPi({
      targetMaterializedRoot: '/tmp/fake',
      targetMaterializedEnv: {},
      vendorResumeId: 'omp-session-missing',
      cwd: '/tmp/project',
    })).resolves.toEqual({
      ok: false,
      reason: 'ohmypi_session_file_not_found',
    });
  });

  it('targetStrict: does not accept a file that is only available from a persisted candidate hint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-reachability-strict-candidate-'));
    const candidate = join(root, 'sessions', '--tmp-project--', '2026-05-28T00-00-00-000Z_omp-session-1.jsonl');
    try {
      await mkdir(join(root, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(candidate, '{}\n');

      await expect(verifyResumeReachableOhMyPi({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'omp-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
        targetStrict: true,
      })).resolves.toEqual({
        ok: false,
        reason: 'ohmypi_session_file_not_found',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
