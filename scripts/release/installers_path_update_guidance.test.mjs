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

test('install.sh updates bash rc + login files and prints a reload hint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-path-hint-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  // Create both interactive + login bash files to cover common PATH-loading entrypoints.
  await writeFile(join(homeDir, '.bashrc'), '# bashrc\n', 'utf8');
  await writeFile(join(homeDir, '.profile'), '# profile\n', 'utf8');

  // Stub uname so the installer deterministically selects linux-x64 assets.
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

  // Build a minimal CLI tarball.
  const version = '9.9.9';
  const artifactStem = `happier-v${version}-linux-x64`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);
  await mkdir(artifactDir, { recursive: true });
  const happierBin = join(artifactDir, 'happier');
  await writeFile(
    happierBin,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--version" ]]; then
  echo "${version}"
  exit 0
fi
exit 0
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

  // Stub minisign so signature verification succeeds.
  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(
    minisignStubPath,
    `#!/usr/bin/env bash
exit 0
`,
    'utf8',
  );
  await chmod(minisignStubPath, 0o755);

  // Stub sha256sum so the installer is deterministic across platforms.
  const sha256sumStubPath = join(binDir, 'sha256sum');
  await writeFile(
    sha256sumStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
file="$1"
hash="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
echo "$hash  $file"
`,
    'utf8',
  );
  await chmod(sha256sumStubPath, 0o755);

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
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath, '--without-daemon'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const exportLine = `export PATH="${outBinDir}:$PATH"`;
  const bashrc = await readFile(join(homeDir, '.bashrc'), 'utf8');
  const profile = await readFile(join(homeDir, '.profile'), 'utf8');
  assert.ok(bashrc.includes(exportLine), 'expected installer to add PATH export to ~/.bashrc');
  assert.ok(profile.includes(exportLine), 'expected installer to add PATH export to ~/.profile (login shells)');
  assert.match(stdout, /(source|reload).*(bashrc|profile)|open a new terminal/i, 'expected installer to print a PATH reload hint');

  await rm(root, { recursive: true, force: true });
});

