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

test('install.sh bootstraps minisign with the correct Linux arch (aarch64)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-minisign-arch-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  // Stub uname so the installer deterministically selects linux-arm64 assets.
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
  echo aarch64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  // Build a minimal CLI tarball.
  const version = '9.9.9';
  const artifactStem = `happier-v${version}-linux-arm64`;
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
exit 0
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

  const realTar = String(spawnSync('bash', ['-lc', 'command -v tar'], { encoding: 'utf8' }).stdout ?? '').trim();
  assert.ok(realTar, 'expected tar to exist for installer test');

  // Stub tar: emit the noisy LIBARCHIVE warnings on extract so the installer must suppress them.
  const tarStubPath = join(binDir, 'tar');
  await writeFile(
    tarStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
is_extract=0
for arg in "$@"; do
  if [[ "$arg" == -*x* ]] && [[ "$arg" != -*c* ]]; then
    is_extract=1
    break
  fi
done
if [[ "$is_extract" == "1" ]]; then
  echo "tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'" >&2
  echo "tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'" >&2
fi
exec ${JSON.stringify(realTar)} "$@"
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
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  assert.ok(stdout.includes('Checksum verified.'), 'installer should verify checksums');
  assert.ok(stdout.includes('Signature verified.'), 'installer should verify minisign signature');
  assert.doesNotMatch(stderr, /Ignoring unknown extended header keyword/i, 'installer should suppress non-actionable tar warnings');

  await rm(root, { recursive: true, force: true });
});
