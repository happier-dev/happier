import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTrailingJsonObjectForTests,
  resolveSigningEnvForTests,
} from '../pipeline/release-validation/executors/installers-smoke-local-build.mjs';

test('installers-smoke local-build parser reads the trailing JSON payload after noisy build output', () => {
  const parsed = parseTrailingJsonObjectForTests(`
yarn run v1.22.22
$ node scripts/pipeline/release/build-cli-binaries.mjs --channel preview --targets darwin-arm64
warning package.json: No license field
{"outDir":"/tmp/out","artifacts":["happier-v1.2.3-preview.4-darwin-arm64.tar.gz"],"checksums":"/tmp/out/checksums.txt","signature":"/tmp/out/checksums.txt.minisig"}
  `);

  assert.deepEqual(parsed, {
    outDir: '/tmp/out',
    artifacts: ['happier-v1.2.3-preview.4-darwin-arm64.tar.gz'],
    checksums: '/tmp/out/checksums.txt',
    signature: '/tmp/out/checksums.txt.minisig',
  });
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
