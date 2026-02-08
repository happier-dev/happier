import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
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
    const hostPath = host.replace(/^unix:\/\//, '');
    const expected = await realpath(sockPath);
    const actual = await realpath(hostPath);
    assert.equal(actual, expected);
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('resolveDockerHostEnv still resolves user socket when HOME is unset', async () => {
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  const cwd = await mkdtemp(join(tmpdir(), 'ci-test-cwd-'));
  try {
    delete process.env.HOME;
    process.chdir(cwd);
    const sockPath = join(cwd, '.docker', 'run', 'docker.sock');
    await mkdir(join(cwd, '.docker', 'run'), { recursive: true });
    await writeFile(sockPath, '');

    const host = resolveDockerHostEnv();
    const hostPath = host.replace(/^unix:\/\//, '');
    const expected = await realpath(sockPath);
    const actual = await realpath(hostPath);
    assert.equal(actual, expected);
  } finally {
    process.chdir(prevCwd);
    if (typeof prevHome === 'undefined') delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(cwd, { recursive: true, force: true });
  }
});
