import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh --version can resolve local release assets without fetching GitHub metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-version-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const version = '9.9.9-preview.42';
  await writeFile(join(assetsDir, `happier-v${version}-linux-x64.tar.gz`), 'archive', 'utf8');
  await writeFile(join(assetsDir, `checksums-happier-v${version}.txt`), 'checksum', 'utf8');
  await writeFile(join(assetsDir, `checksums-happier-v${version}.txt.minisig`), 'signature', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+preview/i);
  assert.match(stdout, /version:\s+9\.9\.9-preview\.42/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version deterministically selects the newest local release assets for the requested channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-latest-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const findStubPath = join(binDir, 'find');
  const newerVersion = '1.2.3-preview.42';
  const olderVersion = '1.2.3-preview.7';
  const newerArchive = join(assetsDir, `happier-v${newerVersion}-linux-x64.tar.gz`);
  const olderArchive = join(assetsDir, `happier-v${olderVersion}-linux-x64.tar.gz`);
  const newerChecksums = join(assetsDir, `checksums-happier-v${newerVersion}.txt`);
  const olderChecksums = join(assetsDir, `checksums-happier-v${olderVersion}.txt`);
  const newerSig = join(assetsDir, `checksums-happier-v${newerVersion}.txt.minisig`);
  const olderSig = join(assetsDir, `checksums-happier-v${olderVersion}.txt.minisig`);

  await writeFile(
    findStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' \
  '${newerArchive}' \
  '${olderArchive}' \
  '${newerChecksums}' \
  '${olderChecksums}' \
  '${newerSig}' \
  '${olderSig}'
`,
    'utf8',
  );
  await chmod(findStubPath, 0o755);

  await writeFile(newerArchive, 'archive-newer', 'utf8');
  await writeFile(olderArchive, 'archive-older', 'utf8');
  await writeFile(newerChecksums, 'checksum-newer', 'utf8');
  await writeFile(olderChecksums, 'checksum-older', 'utf8');
  await writeFile(newerSig, 'signature-newer', 'utf8');
  await writeFile(olderSig, 'signature-older', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected deterministic local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+preview/i);
  assert.match(stdout, /version:\s+1\.2\.3-preview\.42/i);
  assert.doesNotMatch(stdout, /version:\s+1\.2\.3-preview\.7/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version ignores stable local assets when preview channel resolves a mixed asset directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-mixed-channel-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const findStubPath = join(binDir, 'find');
  const stableVersion = '1.2.3';
  const previewVersion = '1.2.3-preview.42';
  const stableArchive = join(assetsDir, `happier-v${stableVersion}-linux-x64.tar.gz`);
  const previewArchive = join(assetsDir, `happier-v${previewVersion}-linux-x64.tar.gz`);
  const stableChecksums = join(assetsDir, `checksums-happier-v${stableVersion}.txt`);
  const previewChecksums = join(assetsDir, `checksums-happier-v${previewVersion}.txt`);
  const stableSig = join(assetsDir, `checksums-happier-v${stableVersion}.txt.minisig`);
  const previewSig = join(assetsDir, `checksums-happier-v${previewVersion}.txt.minisig`);

  await writeFile(
    findStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' \
  '${stableArchive}' \
  '${previewArchive}' \
  '${stableChecksums}' \
  '${previewChecksums}' \
  '${stableSig}' \
  '${previewSig}'
`,
    'utf8',
  );
  await chmod(findStubPath, 0o755);

  await writeFile(stableArchive, 'archive-stable', 'utf8');
  await writeFile(previewArchive, 'archive-preview', 'utf8');
  await writeFile(stableChecksums, 'checksum-stable', 'utf8');
  await writeFile(previewChecksums, 'checksum-preview', 'utf8');
  await writeFile(stableSig, 'signature-stable', 'utf8');
  await writeFile(previewSig, 'signature-preview', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected mixed-channel local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+preview/i);
  assert.match(stdout, /version:\s+1\.2\.3-preview\.42/i);
  assert.doesNotMatch(stdout, /version:\s+1\.2\.3$/im);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version ignores prerelease local assets when stable channel resolves a mixed asset directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-stable-mixed-channel-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const findStubPath = join(binDir, 'find');
  const stableVersion = '1.2.3';
  const previewVersion = '9.9.9-preview.42';
  const stableArchive = join(assetsDir, `happier-v${stableVersion}-linux-x64.tar.gz`);
  const previewArchive = join(assetsDir, `happier-v${previewVersion}-linux-x64.tar.gz`);
  const stableChecksums = join(assetsDir, `checksums-happier-v${stableVersion}.txt`);
  const previewChecksums = join(assetsDir, `checksums-happier-v${previewVersion}.txt`);
  const stableSig = join(assetsDir, `checksums-happier-v${stableVersion}.txt.minisig`);
  const previewSig = join(assetsDir, `checksums-happier-v${previewVersion}.txt.minisig`);

  await writeFile(
    findStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' \
  '${previewArchive}' \
  '${stableArchive}' \
  '${previewChecksums}' \
  '${stableChecksums}' \
  '${previewSig}' \
  '${stableSig}'
`,
    'utf8',
  );
  await chmod(findStubPath, 0o755);

  await writeFile(stableArchive, 'archive-stable', 'utf8');
  await writeFile(previewArchive, 'archive-preview', 'utf8');
  await writeFile(stableChecksums, 'checksum-stable', 'utf8');
  await writeFile(previewChecksums, 'checksum-preview', 'utf8');
  await writeFile(stableSig, 'signature-stable', 'utf8');
  await writeFile(previewSig, 'signature-preview', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected stable mixed-channel local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+stable/i);
  assert.match(stdout, /version:\s+1\.2\.3/i);
  assert.doesNotMatch(stdout, /version:\s+9\.9\.9-preview\.42/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version semver-sorts local build-metadata assets without numeric parsing warnings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-build-meta-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const findStubPath = join(binDir, 'find');
  const newerVersion = '1.2.10+build5';
  const olderVersion = '1.2.9+build7';
  const newerArchive = join(assetsDir, `happier-v${newerVersion}-linux-x64.tar.gz`);
  const olderArchive = join(assetsDir, `happier-v${olderVersion}-linux-x64.tar.gz`);
  const newerChecksums = join(assetsDir, `checksums-happier-v${newerVersion}.txt`);
  const olderChecksums = join(assetsDir, `checksums-happier-v${olderVersion}.txt`);
  const newerSig = join(assetsDir, `checksums-happier-v${newerVersion}.txt.minisig`);
  const olderSig = join(assetsDir, `checksums-happier-v${olderVersion}.txt.minisig`);

  await writeFile(
    findStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' \
  '${newerArchive}' \
  '${olderArchive}' \
  '${newerChecksums}' \
  '${olderChecksums}' \
  '${newerSig}' \
  '${olderSig}'
`,
    'utf8',
  );
  await chmod(findStubPath, 0o755);

  await writeFile(newerArchive, 'archive-newer', 'utf8');
  await writeFile(olderArchive, 'archive-older', 'utf8');
  await writeFile(newerChecksums, 'checksum-newer', 'utf8');
  await writeFile(olderChecksums, 'checksum-older', 'utf8');
  await writeFile(newerSig, 'signature-newer', 'utf8');
  await writeFile(olderSig, 'signature-older', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected build-metadata local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+stable/i);
  assert.match(stdout, /version:\s+1\.2\.10\+build5/i);
  assert.doesNotMatch(stdout, /version:\s+1\.2\.9\+build7/i);
  assert.doesNotMatch(stderr, /invalid number/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version orders strict-prefix prerelease identifiers for preview local rolling assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-prerelease-prefix-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const findStubPath = join(binDir, 'find');
  const newerVersion = '1.0.0-preview.alpha.1';
  const olderVersion = '1.0.0-preview.alpha';
  const newerArchive = join(assetsDir, `happier-v${newerVersion}-linux-x64.tar.gz`);
  const olderArchive = join(assetsDir, `happier-v${olderVersion}-linux-x64.tar.gz`);
  const newerChecksums = join(assetsDir, `checksums-happier-v${newerVersion}.txt`);
  const olderChecksums = join(assetsDir, `checksums-happier-v${olderVersion}.txt`);
  const newerSig = join(assetsDir, `checksums-happier-v${newerVersion}.txt.minisig`);
  const olderSig = join(assetsDir, `checksums-happier-v${olderVersion}.txt.minisig`);

  await writeFile(
    findStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' \
  '${newerArchive}' \
  '${olderArchive}' \
  '${newerChecksums}' \
  '${olderChecksums}' \
  '${newerSig}' \
  '${olderSig}'
`,
    'utf8',
  );
  await chmod(findStubPath, 0o755);

  await writeFile(newerArchive, 'archive-newer', 'utf8');
  await writeFile(olderArchive, 'archive-older', 'utf8');
  await writeFile(newerChecksums, 'checksum-newer', 'utf8');
  await writeFile(olderChecksums, 'checksum-older', 'utf8');
  await writeFile(newerSig, 'signature-newer', 'utf8');
  await writeFile(olderSig, 'signature-older', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /version:\s+1\.0\.0-preview\.alpha\.1/i);
  assert.doesNotMatch(stdout, /version:\s+1\.0\.0-preview\.alpha$/im);

  await rm(root, { recursive: true, force: true });
});
