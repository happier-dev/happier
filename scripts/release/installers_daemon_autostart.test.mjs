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

test('install.sh installs and enables daemon service by default (best-effort)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-daemon-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');
  const logPath = join(root, 'happier.invocations.log');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

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

  // Build two tarballs to simulate a rolling release tag that contains multiple versions.
  // The installer should select a consistent set of assets (tarball + matching checksums/sig),
  // not mix checksums from a newer version with a tarball from an older one.
  const artifactVersions = ['1.2.3', '1.2.4'];
  const artifacts = [];
  for (const version of artifactVersions) {
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
if [[ "$1" = "daemon" && "$2" = "service" && "$3" = "install" ]]; then
  echo "daemon service install ${version}" >> "${logPath}"
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

    artifacts.push({
      version,
      artifactStem,
      artifactName,
      tarPath,
      checksumsName,
      checksumsPath,
      sigName,
      sigPath,
    });
  }

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

  // Stub curl: return release JSON (no -o), or copy fixture files to -o destinations.
  const curlStubPath = join(binDir, 'curl');
  const [artifactV123, artifactV124] = artifacts;
  assert.equal(artifactV123.version, '1.2.3');
  assert.equal(artifactV124.version, '1.2.4');
  const releaseJson = `{
  "name": "CLI Preview",
  "assets": [
    {
      "name": "${artifactV123.checksumsName}",
      "browser_download_url": "https://example.test/${artifactV123.checksumsName}"
    },
    {
      "name": "${artifactV123.sigName}",
      "browser_download_url": "https://example.test/${artifactV123.sigName}"
    },
    {
      "name": "${artifactV124.checksumsName}",
      "browser_download_url": "https://example.test/${artifactV124.checksumsName}"
    },
    {
      "name": "${artifactV124.sigName}",
      "browser_download_url": "https://example.test/${artifactV124.sigName}"
    },
    {
      "name": "${artifactV123.artifactName}",
      "browser_download_url": "https://example.test/${artifactV123.artifactName}"
    },
    {
      "name": "${artifactV124.artifactName}",
      "browser_download_url": "https://example.test/${artifactV124.artifactName}"
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
    *${artifactV123.artifactName}) cp ${JSON.stringify(artifactV123.tarPath)} "$out" ;;
    *${artifactV124.artifactName}) cp ${JSON.stringify(artifactV124.tarPath)} "$out" ;;
    *${artifactV123.checksumsName}) cp ${JSON.stringify(artifactV123.checksumsPath)} "$out" ;;
    *${artifactV124.checksumsName}) cp ${JSON.stringify(artifactV124.checksumsPath)} "$out" ;;
    *${artifactV123.sigName}) cp ${JSON.stringify(artifactV123.sigPath)} "$out" ;;
    *${artifactV124.sigName}) cp ${JSON.stringify(artifactV124.sigPath)} "$out" ;;
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
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
    HAPPIER_TEST_LOG: logPath,
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const log = await readFile(logPath, 'utf8').catch(() => '');
  assert.match(log, /daemon service install 1\.2\.4/);

  const versionRes = spawnSync(join(outBinDir, 'happier'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `installed binary failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), /1\.2\.4/);

  await rm(root, { recursive: true, force: true });
});
