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

async function writeUnameStub(binDir) {
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
}

async function writeLegacyCliArtifact(fixtureDir, version, marker = 'legacy') {
  const artifactStem = `happier-v${version}-linux-x64`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);
  await mkdir(join(artifactDir, 'package-dist'), { recursive: true });
  const happierBin = join(artifactDir, 'happier');
  await writeFile(
    happierBin,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--version" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" = "self" && "$2" = "__install-payload" ]]; then
  echo "Error: Unknown self subcommand: __install-payload" >&2
  exit 1
fi
exit 0
`,
    'utf8',
  );
  await chmod(happierBin, 0o755);
  await writeFile(join(artifactDir, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(marker)};\n`, 'utf8');

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

  return {
    artifactName,
    tarPath,
    checksumsName,
    checksumsPath,
    sigName,
    sigPath,
  };
}

async function writeMinisignStub(binDir) {
  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(minisignStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(minisignStubPath, 0o755);
}

test('install.sh falls back to direct binary install when extracted CLI lacks internal payload installer support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-legacy-cli-fallback-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  await writeUnameStub(binDir);

  const version = '1.2.3';
  const asset = await writeLegacyCliArtifact(fixtureDir, version);
  await writeMinisignStub(binDir);

  const releaseJson = `{
  "name": "CLI Stable",
  "assets": [
    {
      "name": "${asset.checksumsName}",
      "browser_download_url": "https://example.test/${asset.checksumsName}"
    },
    {
      "name": "${asset.sigName}",
      "browser_download_url": "https://example.test/${asset.sigName}"
    },
    {
      "name": "${asset.artifactName}",
      "browser_download_url": "https://example.test/${asset.artifactName}"
    }
  ]
}`;
  const curlStubPath = join(binDir, 'curl');
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
    *${asset.artifactName}) cp ${JSON.stringify(asset.tarPath)} "$out" ;;
    *${asset.checksumsName}) cp ${JSON.stringify(asset.checksumsPath)} "$out" ;;
    *${asset.sigName}) cp ${JSON.stringify(asset.sigPath)} "$out" ;;
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
    HAPPIER_WITH_DAEMON: '0',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /falling back to legacy binary install/i);

  const versionRes = spawnSync(join(outBinDir, 'happier'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `installed binary failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), /1\.2\.3/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version value installs the requested CLI release from rolling assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-exact-version-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  await writeUnameStub(binDir);
  await writeMinisignStub(binDir);

  const requestedVersion = '1.2.3';
  const newerVersion = '9.9.9';
  await writeLegacyCliArtifact(fixtureDir, newerVersion, 'newer');
  await writeLegacyCliArtifact(fixtureDir, requestedVersion, 'requested');

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
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
    HAPPIER_WITH_DAEMON: '0',
    HAPPIER_RELEASE_ASSETS_DIR: fixtureDir,
  };

  const res = spawnSync('bash', [installerPath, '--version', requestedVersion], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /falling back to legacy binary install/i);

  const versionRes = spawnSync(join(outBinDir, 'happier'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `installed binary failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), /1\.2\.3/);
  assert.doesNotMatch(String(versionRes.stdout ?? ''), /9\.9\.9/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh installs preview CLI assets from a mixed local asset directory without drifting to stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-preview-local-assets-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  await writeUnameStub(binDir);
  await writeMinisignStub(binDir);

  const stableVersion = '1.2.3';
  const previewVersion = '1.2.3-preview.42';
  await writeLegacyCliArtifact(fixtureDir, stableVersion, 'stable');
  await writeLegacyCliArtifact(fixtureDir, previewVersion, 'preview');

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_WITH_DAEMON: '0',
    HAPPIER_RELEASE_ASSETS_DIR: fixtureDir,
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /falling back to legacy binary install/i);

  const versionRes = spawnSync(join(outBinDir, 'hprev'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `installed preview shim failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), /1\.2\.3-preview\.42/);
  assert.doesNotMatch(String(versionRes.stdout ?? ''), /1\.2\.3$/im);

  await rm(root, { recursive: true, force: true });
});
