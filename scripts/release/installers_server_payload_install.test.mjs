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

test('install.sh (server) installs full payload tree and provides a channel-scoped shim that runs from the payload root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-server-payload-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');

  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

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

  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(minisignStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(minisignStubPath, 0o755);

  const version = '0.1.2-dev.123';
  const artifactStem = `happier-server-v${version}-linux-x64`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);

  await mkdir(join(artifactDir, 'generated', 'sqlite-client'), { recursive: true });
  const engineMarker = join(artifactDir, 'generated', 'sqlite-client', 'libquery_engine-linux-x64-openssl-3.0.x.so.node');
  await writeFile(engineMarker, 'engine\n', 'utf8');

  const serverBin = join(artifactDir, 'happier-server');
  await writeFile(
    serverBin,
    `#!/usr/bin/env bash
set -euo pipefail
# Mimic a Prisma engine lookup that expects engines alongside the payload root.
if [[ ! -f "generated/sqlite-client/libquery_engine-linux-x64-openssl-3.0.x.so.node" ]]; then
  echo "missing prisma engine marker in cwd=$PWD" >&2
  exit 2
fi
echo "ok: prisma engine marker found"
exit 0
`,
    'utf8',
  );
  await chmod(serverBin, 0o755);

  const tarPath = join(fixtureDir, artifactName);
  const tarRes = spawnSync('tar', ['-czf', tarPath, '-C', fixtureDir, artifactStem], { encoding: 'utf8' });
  assert.equal(tarRes.status, 0, `tar failed: ${String(tarRes.stderr ?? '')}`);

  const checksumsName = `checksums-happier-server-v${version}.txt`;
  const checksumsPath = join(fixtureDir, checksumsName);
  const hash = await sha256(tarPath);
  await writeFile(checksumsPath, `${hash}  ${artifactName}\n`, 'utf8');

  const sigName = `${checksumsName}.minisig`;
  const sigPath = join(fixtureDir, sigName);
  await writeFile(sigPath, 'minisign-stub\n', 'utf8');

  const releaseJson = `{
  "name": "Server Dev",
  "assets": [
    { "name": "${checksumsName}", "browser_download_url": "https://example.test/${checksumsName}" },
    { "name": "${sigName}", "browser_download_url": "https://example.test/${sigName}" },
    { "name": "${artifactName}", "browser_download_url": "https://example.test/${artifactName}" }
  ]
}`;

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
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
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'server',
    HAPPIER_CHANNEL: 'dev',
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

  const shimPath = join(outBinDir, 'happier-server-dev');
  const execRes = spawnSync('bash', ['-lc', `${JSON.stringify(shimPath)} 2>/dev/null`], { env, encoding: 'utf8' });
  assert.equal(execRes.status, 0, `expected shim to execute the payload binary successfully:\n--- stdout ---\n${String(execRes.stdout ?? '')}\n--- stderr ---\n${String(execRes.stderr ?? '')}\n`);
  assert.match(String(execRes.stdout ?? ''), /prisma engine marker found/);

  await rm(root, { recursive: true, force: true });
});
