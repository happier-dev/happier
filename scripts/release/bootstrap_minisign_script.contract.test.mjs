import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('bootstrap-minisign script uses portable find grouping syntax', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh'), 'utf8');
  assert.doesNotMatch(raw, /find [^\n]*\\\\\(/, 'bootstrap-minisign should not double-escape find grouping');
  assert.match(
    raw,
    /find [^\n]*\\\( -name minisign -o -name minisign\.exe \\\)/,
    'bootstrap-minisign should use single-escaped find grouping for minisign binary lookup',
  );
});

test('bootstrap-minisign script selects linux minisign binary by runner architecture first', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh'), 'utf8');
  assert.match(raw, /case "\$\{arch\}" in[\s\S]*?x86_64\|amd64\)[\s\S]*?linux_arch="x86_64"/);
  assert.match(raw, /case "\$\{arch\}" in[\s\S]*?aarch64\|arm64\)[\s\S]*?linux_arch="aarch64"/);
  assert.match(
    raw,
    /candidate="\$\{extract_dir\}\/minisign-linux\/\$\{linux_arch\}\/minisign"/,
    'bootstrap-minisign should prefer architecture-specific minisign path on linux',
  );
});

test('bootstrap-minisign script selects the Windows minisign binary by runner architecture before generic discovery', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh'), 'utf8');
  assert.match(raw, /if \[\[ -z "\$\{bin_path\}" && \( "\$\{os\}" == msys\* \|\| "\$\{os\}" == mingw\* \|\| "\$\{os\}" == cygwin\* \) \]\]; then[\s\S]*?case "\$\{arch\}" in[\s\S]*?x86_64\|amd64\)[\s\S]*?windows_arch="x64"/);
  assert.match(raw, /if \[\[ -z "\$\{bin_path\}" && \( "\$\{os\}" == msys\* \|\| "\$\{os\}" == mingw\* \|\| "\$\{os\}" == cygwin\* \) \]\]; then[\s\S]*?case "\$\{arch\}" in[\s\S]*?aarch64\|arm64\)[\s\S]*?windows_arch="aarch64"/);
  assert.match(
    raw,
    /candidate="\$\{extract_dir\}\/minisign-win64\/\$\{windows_arch\}\/minisign\.exe"/,
    'bootstrap-minisign should prefer architecture-specific minisign path on Windows',
  );
});

test('bootstrap-minisign script accepts Windows sha256sum output that prefixes the checksum with a backslash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-minisign-win-sha-'));
  const binDir = join(root, 'bin');
  const runnerTemp = join(root, 'runner-temp');
  const fixtureDir = join(root, 'fixture');
  await mkdir(binDir, { recursive: true });
  await mkdir(runnerTemp, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  const expectedSha = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479';
  const assetName = 'minisign-0.12-win64.zip';
  const fixtureArchivePath = join(fixtureDir, assetName);
  await writeFile(fixtureArchivePath, 'dummy-minisign-zip', 'utf8');

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo MINGW64_NT-10.0
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo MINGW64_NT-10.0
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

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
cp ${JSON.stringify(fixtureArchivePath)} "$out"
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const sha256sumStubPath = join(binDir, 'sha256sum');
  await writeFile(
    sha256sumStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "\\\\${expectedSha}  $1"
`,
    'utf8',
  );
  await chmod(sha256sumStubPath, 0o755);

  const unzipStubPath = join(binDir, 'unzip');
  await writeFile(
    unzipStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
archive=""
destination=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -d)
      destination="$2"
      shift 2
      ;;
    -q)
      shift
      ;;
    *)
      archive="$1"
      shift
      ;;
  esac
done
mkdir -p "$destination/minisign-win"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$destination/minisign-win/minisign.exe"
chmod +x "$destination/minisign-win/minisign.exe"
`,
    'utf8',
  );
  await chmod(unzipStubPath, 0o755);

  const bootstrapPath = join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh');
  const result = spawnSync('bash', [bootstrapPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_PATH: '',
    },
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `bootstrap script should accept Windows-style escaped sha256sum output:\nstdout=${String(result.stdout ?? '')}\nstderr=${String(result.stderr ?? '')}`,
  );
  assert.match(String(result.stdout ?? '').trim(), /minisign-win$/, 'expected stdout to contain the bootstrapped minisign directory');

  await rm(root, { recursive: true, force: true });
});

test('bootstrap-minisign script selects the Windows minisign binary that matches the runner architecture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-minisign-win-arch-'));
  const binDir = join(root, 'bin');
  const runnerTemp = join(root, 'runner-temp');
  const fixtureDir = join(root, 'fixture');
  await mkdir(binDir, { recursive: true });
  await mkdir(runnerTemp, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  const expectedSha = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479';
  const assetName = 'minisign-0.12-win64.zip';
  const fixtureArchivePath = join(fixtureDir, assetName);
  await writeFile(fixtureArchivePath, 'dummy-minisign-zip', 'utf8');

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo MINGW64_NT-10.0
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo MINGW64_NT-10.0
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

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
cp ${JSON.stringify(fixtureArchivePath)} "$out"
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const sha256sumStubPath = join(binDir, 'sha256sum');
  await writeFile(
    sha256sumStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "${expectedSha}  $1"
`,
    'utf8',
  );
  await chmod(sha256sumStubPath, 0o755);

  const unzipStubPath = join(binDir, 'unzip');
  await writeFile(
    unzipStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
destination=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -d)
      destination="$2"
      shift 2
      ;;
    -q)
      shift
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$destination/minisign-win64/aarch64"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$destination/minisign-win64/aarch64/minisign.exe"
mkdir -p "$destination/minisign-win64/x64"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$destination/minisign-win64/x64/minisign.exe"
chmod +x "$destination/minisign-win64/aarch64/minisign.exe" "$destination/minisign-win64/x64/minisign.exe"
`,
    'utf8',
  );
  await chmod(unzipStubPath, 0o755);

  const bootstrapPath = join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh');
  const result = spawnSync('bash', [bootstrapPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_PATH: '',
    },
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `bootstrap script should select the Windows minisign binary matching the runner architecture:\nstdout=${String(result.stdout ?? '')}\nstderr=${String(result.stderr ?? '')}`,
  );
  assert.match(
    String(result.stdout ?? '').trim(),
    /minisign-win64\/x64$/,
    'expected stdout to contain the x64 minisign directory on x64 Windows runners',
  );

  await rm(root, { recursive: true, force: true });
});
