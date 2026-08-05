import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prepareInstallersSmokeCandidateAssets,
  resolveSigningEnvForTests,
} from '../pipeline/release-validation/executors/installers-smoke-local-build.mjs';

test('installers-smoke exposes only consumer-private candidate assets after verification', async () => {
  const platform = process.platform;
  const targetOs = platform === 'win32' ? 'windows' : platform;
  const installerField = platform === 'win32' ? 'powershell' : 'shell';
  const sourceCandidate = {
    cli: { version: '1.2.3' },
    standaloneCli: {
      signature: { filePath: '/candidate/native/checksums.txt.minisig' },
      checksums: { filePath: '/candidate/native/checksums.txt' },
      archives: [{
        os: targetOs,
        arch: process.arch,
        archivePath: `/candidate/native/happier-v1.2.3-${targetOs}-${process.arch}.tar.gz`,
      }],
    },
    installers: {
      shell: { filePath: '/candidate/installers/install-dev.sh' },
      powershell: { filePath: '/candidate/installers/install-dev.ps1' },
      publicKey: { filePath: '/candidate/installers/happier-release.pub' },
    },
  };
  const privateCandidate = {
    ...sourceCandidate,
    standaloneCli: {
      ...sourceCandidate.standaloneCli,
      signature: { filePath: '/private/native/checksums.txt.minisig' },
      checksums: { filePath: '/private/native/checksums.txt' },
      archives: [{
        ...sourceCandidate.standaloneCli.archives[0],
        archivePath: `/private/native/happier-v1.2.3-${targetOs}-${process.arch}.tar.gz`,
      }],
    },
    installers: {
      shell: { filePath: '/private/installers/install-dev.sh' },
      powershell: { filePath: '/private/installers/install-dev.ps1' },
      publicKey: { filePath: '/private/installers/happier-release.pub' },
    },
  };
  const events = [];
  const prepared = await prepareInstallersSmokeCandidateAssets({
    repoRoot: '/repo',
    platform,
    candidateManifestPath: '/candidate/candidate.json',
  }, {
    loadCandidateImpl: async () => sourceCandidate,
    captureCandidateImpl: async (_candidate, options) => {
      events.push('captured');
      return {
        candidate: privateCandidate,
        cleanup: async () => await options.rmImpl('/private'),
        root: '/private',
        manifestPath: null,
      };
    },
    prepareMinisignEnvImpl: async () => ({
      keyPathEntries: ['/private/minisign'],
      env: {},
      cleanup: async () => events.push('minisign-cleanup'),
    }),
    readFileImpl: async (path) => {
      assert.equal(path, privateCandidate.installers.publicKey.filePath);
      return 'verified-public-key';
    },
    removeCapturedRootImpl: async () => events.push('capture-cleanup'),
  });

  assert.equal(events[0], 'captured');
  assert.equal(prepared.assetsDir, '/private/native');
  assert.equal(prepared.installerPath, privateCandidate.installers[installerField].filePath);
  assert.equal(prepared.publicKey, 'verified-public-key');
  await prepared.cleanup();
  assert.deepEqual(events, ['captured', 'minisign-cleanup', 'capture-cleanup']);
});

test('installers-smoke local-build bootstrap still returns a minisign dir when GITHUB_PATH is set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installers-smoke-local-build-test-'));
  const repoRoot = join(root, 'repo');
  const scratchDir = join(root, 'scratch');
  const bootstrapDir = join(repoRoot, '.github', 'actions', 'bootstrap-minisign');
  const pathBinDir = join(root, 'path-bin');
  const minisignDir = join(root, 'bootstrapped-bin');
  const githubPathFile = join(root, 'github-path.txt');

  await mkdir(bootstrapDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  await mkdir(pathBinDir, { recursive: true });
  await mkdir(minisignDir, { recursive: true });

  const bashPath = join(pathBinDir, 'bash');
  await writeFile(
    bashPath,
    `#!/bin/bash
set -euo pipefail
exec /bin/bash "$@"
`,
    'utf8',
  );
  await chmod(bashPath, 0o755);

  const minisignPath = join(minisignDir, 'minisign');
  await writeFile(
    minisignPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-v" ]]; then
  exit 0
fi
echo "unexpected minisign args: $*" >&2
exit 1
`,
    'utf8',
  );
  await chmod(minisignPath, 0o755);

  const bootstrapPath = join(bootstrapDir, 'bootstrap-minisign.sh');
  await writeFile(
    bootstrapPath,
    `#!/usr/bin/env bash
set -euo pipefail
bin_dir=${JSON.stringify(minisignDir)}
if [[ -n "\${GITHUB_PATH:-}" ]]; then
  echo "$bin_dir" >> "$GITHUB_PATH"
else
  echo "$bin_dir"
fi
`,
    'utf8',
  );
  await chmod(bootstrapPath, 0o755);

  const signing = resolveSigningEnvForTests({
    repoRoot,
    scratchDir,
    baseEnv: {
      ...process.env,
      PATH: pathBinDir,
      GITHUB_PATH: githubPathFile,
    },
  });

  assert.deepEqual(signing.keyPathEntries, [minisignDir]);
  assert.match(signing.env.PATH ?? '', new RegExp(`^${minisignDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  await rm(root, { recursive: true, force: true });
});
