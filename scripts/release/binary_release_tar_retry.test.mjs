import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('binary release packaging retries transient tar failures', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-tar-retry-'));
  const stageRoot = join(workspace, 'stage');
  const outDir = join(workspace, 'out');
  const binDir = join(workspace, 'bin');
  const counterPath = join(workspace, 'tar-counter.txt');

  const stageDir = join(stageRoot, 'happier-v0.0.0-test-linux-x64');
  await mkdir(stageDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(stageDir, 'happier'), 'hello\n', 'utf-8');

  const systemTar = spawnSync('command', ['-v', 'tar'], { encoding: 'utf-8', shell: true });
  assert.equal(systemTar.status, 0, systemTar.stderr);
  const systemTarPath = String(systemTar.stdout ?? '').trim();
  assert.ok(systemTarPath, 'expected to resolve system tar path');

  // A stub tar that fails the first archive attempt and succeeds on retry by delegating to the real tar.
  const stubTarPath = join(binDir, 'tar');
  await writeFile(
    stubTarPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `counter=${JSON.stringify(counterPath)}`,
      `real=${JSON.stringify(systemTarPath)}`,
      'if [[ "${1:-}" == "--version" ]]; then exec "${real}" --version; fi',
      'count=0',
      'if [[ -f "${counter}" ]]; then count="$(cat "${counter}")"; fi',
      'count="$((count+1))"',
      'echo "${count}" > "${counter}"',
      'if [[ "${count}" -eq 1 ]]; then',
      '  echo "tar: simulated transient failure" >&2',
      '  exit 1',
      'fi',
      'exec "${real}" "$@"',
      '',
    ].join('\n'),
    'utf-8',
  );
  spawnSync('chmod', ['755', stubTarPath]);

  const originalPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${originalPath}`;

  try {
    const mod = await import(`../pipeline/release/lib/binary-release.mjs?cachebust=${Date.now()}`);
    const artifact = await mod.packagePreparedTargetBinary({
      product: 'happier',
      version: '0.0.0-test',
      target: { os: 'linux', arch: 'x64', exeExt: '' },
      stageDir,
      outDir,
    });

    assert.ok(artifact?.path, 'expected packaged artifact path');
    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/happier(?:\n|$)/);
  } finally {
    process.env.PATH = originalPath;
    await rm(workspace, { recursive: true, force: true });
  }
});

