import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function createLinuxInstallerVersionScenario({ channel = 'preview', assets, findOrder }) {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-installers-local-assets-scenario-'));
  const fakeBinDir = join(scratch, 'bin');
  const assetsDir = join(scratch, 'assets');
  const installDir = join(scratch, 'install');
  const outBinDir = join(scratch, 'out-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(outBinDir, { recursive: true });

  writeExecutable(
    join(fakeBinDir, 'uname'),
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
  );
  writeExecutable(
    join(fakeBinDir, 'curl'),
    '#!/usr/bin/env bash\necho "curl should not be called when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 97\n',
  );

  const assetPaths = assets.map((name) => join(assetsDir, name));
  for (const path of assetPaths) {
    writeFileSync(path, 'asset', 'utf8');
  }
  const orderedPaths = findOrder.map((index) => assetPaths[index]);
  writeExecutable(
    join(fakeBinDir, 'find'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' ${orderedPaths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}
`,
  );

  const installerPath = resolve(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const res = spawnSync('bash', [installerPath, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HAPPIER_CHANNEL: channel,
      HAPPIER_PRODUCT: 'cli',
      HAPPIER_INSTALL_DIR: installDir,
      HAPPIER_BIN_DIR: outBinDir,
      HAPPIER_NONINTERACTIVE: '1',
      HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
    },
  });

  return {
    scratch,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    status: res.status,
  };
}

test('install.sh --version resolves release assets from HAPPIER_RELEASE_ASSETS_DIR without fetching release metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-installers-local-assets-'));
  const fakeBinDir = join(scratch, 'bin');
  const assetsDir = join(scratch, 'assets');
  const installerPath = resolve(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const curlPath = join(fakeBinDir, 'curl');
  const bashrcPath = join(scratch, '.bashrc');
  const archiveName = 'happier-v1.2.3-preview.4-darwin-arm64.tar.gz';

  execFileSync('mkdir', ['-p', fakeBinDir, assetsDir]);
  writeFileSync(join(assetsDir, archiveName), '');
  writeFileSync(
    curlPath,
    '#!/usr/bin/env bash\n' +
      'echo "curl should not be called when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\n' +
      'exit 97\n',
  );
  chmodSync(curlPath, 0o755);
  writeFileSync(bashrcPath, '');

  const output = execFileSync('bash', [installerPath, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: scratch,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      SHELL: '/bin/bash',
      HAPPIER_CHANNEL: 'preview',
      HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.doesNotMatch(output, /Fetching .* release metadata/);
  assert.match(output, /Happier CLI installer version check/);
  assert.match(output, /- version: 1\.2\.3-preview\.4/);
});

test('install.sh --version semver-sorts local release assets instead of trusting find order', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'preview',
    assets: [
      'happier-v1.2.3-preview.42-linux-x64.tar.gz',
      'happier-v1.2.3-preview.7-linux-x64.tar.gz',
    ],
    findOrder: [0, 1],
  });

  try {
    assert.equal(scenario.status, 0, `expected version check to succeed:\n${scenario.stdout}\n${scenario.stderr}`);
    assert.match(scenario.stdout, /- version: 1\.2\.3-preview\.42/);
    assert.doesNotMatch(scenario.stdout, /- version: 1\.2\.3-preview\.7/);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});

test('install.sh reports missing local release assets instead of exiting silently', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'preview',
    assets: [],
    findOrder: [],
  });

  try {
    assert.notEqual(scenario.status, 0);
    assert.match(scenario.stderr, /Unable to locate release assets for linux-x64/i);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});

test('install.sh --version keeps preview local asset lookup isolated from stable assets', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'preview',
    assets: [
      'happier-v9.9.9-linux-x64.tar.gz',
      'happier-v1.2.3-preview.42-linux-x64.tar.gz',
    ],
    findOrder: [1, 0],
  });

  try {
    assert.equal(scenario.status, 0, `expected version check to succeed:\n${scenario.stdout}\n${scenario.stderr}`);
    assert.match(scenario.stdout, /- version: 1\.2\.3-preview\.42/);
    assert.doesNotMatch(scenario.stdout, /- version: 9\.9\.9\b/);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});

test('install.sh --version keeps stable local asset lookup isolated from prerelease assets', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'stable',
    assets: [
      'happier-v9.9.9-preview.42-linux-x64.tar.gz',
      'happier-v1.2.3-linux-x64.tar.gz',
    ],
    findOrder: [1, 0],
  });

  try {
    assert.equal(scenario.status, 0, `expected version check to succeed:\n${scenario.stdout}\n${scenario.stderr}`);
    assert.match(scenario.stdout, /- version: 1\.2\.3\b/);
    assert.doesNotMatch(scenario.stdout, /- version: 9\.9\.9-preview\.42/);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});

test('install.sh --version semver-sorts local build metadata assets without numeric warnings', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'stable',
    assets: [
      'happier-v1.2.10+build5-linux-x64.tar.gz',
      'happier-v1.2.9+build7-linux-x64.tar.gz',
    ],
    findOrder: [0, 1],
  });

  try {
    assert.equal(scenario.status, 0, `expected version check to succeed:\n${scenario.stdout}\n${scenario.stderr}`);
    assert.match(scenario.stdout, /- version: 1\.2\.10\+build5/);
    assert.doesNotMatch(scenario.stderr, /integer expression expected|syntax error/i);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});

test('install.sh --version orders strict-prefix prerelease identifiers for preview local assets', () => {
  const scenario = createLinuxInstallerVersionScenario({
    channel: 'preview',
    assets: [
      'happier-v1.0.0-preview.alpha.1-linux-x64.tar.gz',
      'happier-v1.0.0-preview.alpha-linux-x64.tar.gz',
    ],
    findOrder: [0, 1],
  });

  try {
    assert.equal(scenario.status, 0, `expected version check to succeed:\n${scenario.stdout}\n${scenario.stderr}`);
    assert.match(scenario.stdout, /- version: 1\.0\.0-preview\.alpha\.1/);
    assert.doesNotMatch(scenario.stdout, /- version: 1\.0\.0-preview\.alpha$/m);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
});
