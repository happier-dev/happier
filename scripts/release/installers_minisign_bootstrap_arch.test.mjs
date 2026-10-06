import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

// Run the real installer while replacing only OS/native and release-service boundaries.
async function runInstallerWithStubbedRelease({ minisignExitCode, os = 'Linux', arch = 'aarch64' }) {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-minisign-arch-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  // uname is the OS boundary used to select release assets.
  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo ${os}
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo ${arch}
  exit 0
fi
echo ${os}
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  // Build a minimal CLI tarball.
  const version = '9.9.9';
  const platform = os === 'Darwin' ? 'darwin' : 'linux';
  const artifactArch = arch === 'x86_64' ? 'x64' : 'arm64';
  const artifactStem = `happier-v${version}-${platform}-${artifactArch}`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);
  await mkdir(artifactDir, { recursive: true });
  const happierBin = join(artifactDir, 'happier');
  await writeFile(
    happierBin,
    `#!/usr/bin/env bash
set -euo pipefail
echo ok
`,
    'utf8',
  );
  await chmod(happierBin, 0o755);

  const tarPath = join(fixtureDir, artifactName);
  const tarRes = spawnSync('tar', ['-czf', tarPath, '-C', fixtureDir, artifactStem], { encoding: 'utf8' });
  assert.equal(tarRes.status, 0, `tar failed: ${String(tarRes.stderr ?? '')}`);

  const checksumsName = `checksums-happier-v${version}.txt`;
  const checksumsPath = join(fixtureDir, checksumsName);
  const hash = await sha256(tarPath);
  await writeFile(checksumsPath, `${hash}  ${artifactName}\n`, 'utf8');

  const sigName = `${checksumsName}.minisig`;
  const sigPath = join(fixtureDir, sigName);
  await writeFile(sigPath, 'minisign-stub\n', 'utf8');

  // Build a fake minisign archive containing both x86_64 + aarch64 minisign scripts.
  // The installer must select the aarch64 one when uname -m is aarch64.
  const minisignRoot = join(fixtureDir, 'minisign-linux');
  const minisignAarch64 = join(minisignRoot, 'aarch64', 'minisign');
  const minisignX64 = join(minisignRoot, 'x86_64', 'minisign');
  await mkdir(join(minisignRoot, 'aarch64'), { recursive: true });
  await mkdir(join(minisignRoot, 'x86_64'), { recursive: true });
  await writeFile(
    minisignAarch64,
    `#!/usr/bin/env bash
exit ${minisignExitCode}
`,
    'utf8',
  );
  await writeFile(
    minisignX64,
    `#!/usr/bin/env bash
exit 97
`,
    'utf8',
  );
  await chmod(minisignAarch64, 0o755);
  await chmod(minisignX64, 0o755);

  const minisignArchiveName = 'minisign-0.12-linux.tar.gz';
  const minisignArchivePath = join(fixtureDir, minisignArchiveName);
  const minisignTarRes = spawnSync('tar', ['-czf', minisignArchivePath, '-C', fixtureDir, 'minisign-linux'], { encoding: 'utf8' });
  assert.equal(minisignTarRes.status, 0, `tar minisign failed: ${String(minisignTarRes.stderr ?? '')}`);

  // Stub sha256sum to:
  // - return the pinned minisign archive SHA (so bootstrap verification passes)
  // - compute real SHA256 for all other files (so CLI checksum validation still works)
  const sha256sumStubPath = join(binDir, 'sha256sum');
  const pinnedMinisignSha = '9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73';
  await writeFile(
    sha256sumStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
file="$1"
base="$(basename "$file")"
case "$base" in
  minisign-0.11-macos.zip) echo "e7c410ae8b8960d7087392472b040bda9b2f307c76df0384ac37f9ad103fc893  $file"; exit 0 ;;
  minisign-0.12-macos.zip) echo "89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63  $file"; exit 0 ;;
esac
if [[ "$base" = "${minisignArchiveName}" ]]; then
  echo "${pinnedMinisignSha}  $file"
  exit 0
fi
hash="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
echo "$hash  $file"
`,
    'utf8',
  );
  await chmod(sha256sumStubPath, 0o755);

  if (os === 'Darwin') {
    // Model the inspected upstream assets at the native extraction boundary:
    // 0.12 is arm64-only; 0.11 is universal (x86_64 + arm64).
    const dittoStubPath = join(binDir, 'ditto');
    await writeFile(dittoStubPath, `#!/usr/bin/env bash
set -euo pipefail
exit_code=${minisignExitCode}
if [[ "$3" == *minisign-0.12-macos.zip && "${arch}" == x86_64 ]]; then exit_code=97; fi
printf '#!/usr/bin/env bash\\nexit %s\\n' "$exit_code" > "$4/minisign"
chmod +x "$4/minisign"
`, 'utf8');
    await chmod(dittoStubPath, 0o755);
  }

  const realTar = String(spawnSync('bash', ['-lc', 'command -v tar'], { encoding: 'utf8' }).stdout ?? '').trim();
  assert.ok(realTar, 'expected tar to exist for installer test');

  // Stub tar: emit the noisy LIBARCHIVE warnings on extract so the installer must suppress them.
  const tarStubPath = join(binDir, 'tar');
  await writeFile(
    tarStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "tar (GNU tar) 1.35"
  exit 0
fi
is_extract=0
forwarded_args=()
for arg in "$@"; do
  if [[ "$arg" == "--no-same-owner" ]]; then
    continue
  fi
  forwarded_args+=("$arg")
  if [[ "$arg" == -*x* ]] && [[ "$arg" != -*c* ]]; then
    is_extract=1
  fi
done
if [[ "$is_extract" == "1" ]]; then
  echo "tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'" >&2
  echo "tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'" >&2
fi
exec ${JSON.stringify(realTar)} "\${forwarded_args[@]}"
`,
    'utf8',
  );
  await chmod(tarStubPath, 0o755);

  // Stub curl: return release JSON (no -o), or copy fixture files to -o destinations.
  const curlStubPath = join(binDir, 'curl');
  const releaseJson = `{
  "assets": [
    {
      "name": "${artifactName}",
      "browser_download_url": "https://example.test/${artifactName}"
    },
    {
      "name": "${checksumsName}",
      "browser_download_url": "https://example.test/${checksumsName}"
    },
    {
      "name": "${sigName}",
      "browser_download_url": "https://example.test/${sigName}"
    }
  ]
}`;
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" = "-o" ]]; then
    j=$((i+1))
    out="\${!j}"
  fi
done
url="\${@: -1}"
if [[ -n "$out" ]]; then
  case "$url" in
    *${artifactName}) cp ${JSON.stringify(tarPath)} "$out" ;;
    *${checksumsName}) cp ${JSON.stringify(checksumsPath)} "$out" ;;
    *${sigName}) cp ${JSON.stringify(sigPath)} "$out" ;;
    *${minisignArchiveName}) cp ${JSON.stringify(minisignArchivePath)} "$out" ;;
    https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-macos.zip|https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-macos.zip) cp ${JSON.stringify(minisignArchivePath)} "$out" ;;
    *) : > "$out" ;;
  esac
  exit 0
fi
printf '%s' '${releaseJson}'
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath, '--without-daemon'], { env, encoding: 'utf8' });
  const result = {
    status: res.status,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    installedBinary: spawnSync('test', ['-e', join(outBinDir, 'happier')]).status === 0,
  };
  await rm(root, { recursive: true, force: true });
  return result;
}

test('install.sh bootstraps minisign with the correct Linux arch (aarch64)', async () => {
  const res = await runInstallerWithStubbedRelease({ minisignExitCode: 0 });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  assert.doesNotMatch(stderr, /Ignoring unknown extended header keyword/i, 'installer should suppress non-actionable tar warnings');

});

for (const arch of ['x86_64', 'arm64']) {
  test(`install.sh bootstraps a compatible macOS minisign on ${arch}`, async () => {
    const { status, stdout, stderr } = await runInstallerWithStubbedRelease({ os: 'Darwin', arch, minisignExitCode: 0 });
    assert.equal(status, 0, `installer failed:\n${stdout}\n${stderr}`);
    assert.match(stdout, /Extracting payload/, 'a verified payload should reach extraction');
  });
}

test('install.sh rejects a macOS payload when its signature does not verify', async () => {
  const { status, stdout, installedBinary } = await runInstallerWithStubbedRelease({ os: 'Darwin', arch: 'x86_64', minisignExitCode: 1 });
  assert.notEqual(status, 0);
  assert.doesNotMatch(stdout, /Extracting payload/, 'the installer must not extract an unverified archive');
  assert.equal(installedBinary, false, 'no binary should be installed from an unverified archive');
});
