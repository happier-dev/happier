import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh does not require a GitHub token (does not crash under set -u)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-no-token-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail

# Minimal curl stub used by installer tests.
# - For metadata calls (no -o), return an empty assets list so the installer exits
#   with a predictable "Unable to locate release assets" error.
# - For any -o download, just write an empty file.
out=""
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" = "-o" ]]; then
    j=$((i+1))
    out="\${!j}"
    break
  fi
done
if [[ -n "$out" ]]; then
  : > "$out"
  exit 0
fi
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
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
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stderr = String(res.stderr ?? '');
  assert.notEqual(res.status, 0);
  assert.match(stderr, /Unable to locate release assets/i);
  assert.doesNotMatch(stderr, /unbound variable/i);
});

test('install.sh retries GitHub requests without a rejected GitHub token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-rejected-token-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  // GitHub rejects an expired or revoked token with 401 even for public release metadata.
  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == Authorization:* ]]; then
    echo "curl: (22) The requested URL returned error: 401" >&2
    printf '\\n401'
    exit 22
  fi
done
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
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
    HAPPIER_INSTALLER_DOWNLOAD_RETRY_DELAY_SECONDS: '0',
    HAPPIER_INSTALLER_VERBOSE: '0',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: 'ghp_revoked',
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stderr = String(res.stderr ?? '');
  // Metadata was fetched anonymously, so the run reaches asset resolution instead of failing the fetch.
  assert.match(stderr, /Unable to locate release assets/i);
  assert.match(stderr, /retrying without the token/i);
});

// Exercise the real request/retry owners against HTTP, including curl's partial-body behavior.
for (const download of [false, true]) {
  for (const scenario of ['rejected', 'transient', 'partial', 'valid']) {
    test(`install.sh ${download ? 'asset' : 'metadata'} requests recover from ${scenario} responses`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-installer-http-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const authorizations = [];
      const payload = download ? Buffer.from([0, 255, 10, 13]) : Buffer.from('{"assets":[]}');
      const server = createServer((request, response) => {
        authorizations.push(request.headers.authorization ?? null);
        if (authorizations.length === 1 && scenario !== 'valid') {
          if (scenario === 'partial') {
            response.writeHead(200, { 'Content-Length': 100, Connection: 'close' });
            response.end('{"assets":');
          } else {
            response.writeHead(scenario === 'rejected' ? 401 : 502);
            response.end();
          }
          return;
        }
        response.end(payload);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const source = await readFile(join(repoRoot, 'scripts/release/installers/install.sh'), 'utf8');
      const functions = source.match(/^(?:curl_auth|fetch_release_metadata_with_retry|download_release_asset_with_retry)\(\) \{[\s\S]*?^}/gm);
      assert.equal(functions?.length, 3);
      const outputPath = join(root, 'asset');
      const script = ['set -euo pipefail', ...functions,
        download ? 'download_release_asset_with_retry "$2" "$1"' : 'fetch_release_metadata_with_retry "$1"',
      ].join('\n');
      const child = spawn('bash', ['-c', script, 'installer-test', `http://127.0.0.1:${server.address().port}/release`, outputPath], {
        env: { ...process.env, GITHUB_TOKEN: 'fixture-token', HAPPIER_INSTALLER_DOWNLOAD_RETRY_DELAY_SECONDS: '0' },
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(status, 0, stderr);
      assert.deepEqual(download ? await readFile(outputPath) : Buffer.from(stdout), payload);
      assert.deepEqual(authorizations, scenario === 'valid' ? ['Bearer fixture-token']
        : ['Bearer fixture-token', scenario === 'rejected' ? null : 'Bearer fixture-token']);
    });
  }
}
