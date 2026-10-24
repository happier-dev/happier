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

test('install.sh installs via atomic swap when cp to target would hit ETXTBSY', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-etxtbsy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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

  // Provide minisign so the installer does not bootstrap it.
  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(minisignStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(minisignStubPath, 0o755);

  // Build a minimal CLI tarball.
  const version = '9.9.9';
  const artifactStem = `happier-v${version}-linux-arm64`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);
  await mkdir(artifactDir, { recursive: true });
  const happierBin = join(artifactDir, 'happier');
  // The legacy CLI rejects payload promotion, so the real shell-owned binary swap runs.
  await writeFile(happierBin, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" = "self" && "\${2:-}" = "__install-payload" ]]; then
  echo "Error: Unknown self subcommand: __install-payload" >&2
  exit 1
fi
exit 0
`, 'utf8');
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
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" = "-o" ]]; then
    j=$((i+1))
    out="\${!j}"
  fi
done
url=""
for ((i=$#; i>=1; i--)); do
  candidate="\${!i}"
  if [[ -n "$out" && "$candidate" = "$out" ]]; then
    continue
  fi
  if [[ "$candidate" = "-o" ]]; then
    continue
  fi
  if [[ "$candidate" = -* ]]; then
    continue
  fi
  url="$candidate"
  break
done
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

  const realCp = String(spawnSync('bash', ['-lc', 'command -v cp'], { encoding: 'utf8' }).stdout ?? '').trim();
  assert.ok(realCp, 'expected cp to exist for installer test');

  // Stub cp: fail with ETXTBSY-like message if the installer tries to copy directly onto the target binary path.
  const cpStubPath = join(binDir, 'cp');
  const targetBinaryPath = join(installDir, 'bin', 'happier');
  await mkdir(dirname(targetBinaryPath), { recursive: true });
  await writeFile(targetBinaryPath, '#!/usr/bin/env bash\nexit 19\n', { mode: 0o755 });
  await writeFile(
    cpStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
src="$1"
dest="$2"
if [[ "$dest" = ${JSON.stringify(targetBinaryPath)} ]]; then
  echo "cp: cannot create regular file '$dest': Text file busy" >&2
  exit 1
fi
exec ${JSON.stringify(realCp)} "$@"
`,
    'utf8',
  );
  await chmod(cpStubPath, 0o755);

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
  assert.deepEqual(await readFile(targetBinaryPath), await readFile(happierBin));
  const installed = spawnSync(join(outBinDir, 'happier'), [], { env, encoding: 'utf8' });
  assert.equal(installed.status, 0, String(installed.stderr ?? ''));
});
