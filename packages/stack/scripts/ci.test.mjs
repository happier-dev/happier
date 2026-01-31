import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDockerHostEnv } from './ci.mjs';

test('resolveDockerHostEnv prefers Docker Desktop user socket when present', async () => {
  const prevHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'ci-test-home-'));
  try {
    process.env.HOME = home;
    const sockPath = join(home, '.docker', 'run', 'docker.sock');
    await mkdir(join(home, '.docker', 'run'), { recursive: true });
    await writeFile(sockPath, '');

    const host = resolveDockerHostEnv();
    assert.equal(host, `unix://${sockPath}`);
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

