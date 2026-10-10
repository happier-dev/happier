import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';

async function toolchainHost(t, { node = '', corepack = '', yarn = '', buildTools = true } = {}) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-toolchain-' });
  const log = join(root, 'writes.log');
  await writeFile(log, '');
  for (const [name, version] of Object.entries({ node, corepack, yarn })) {
    await writeFile(join(root, `${name}.version`), version);
  }
  await writeFile(join(root, 'build-tools.ready'), buildTools ? 'ready' : '');
  // Commands are the real OS/package boundary. The narrow PATH prevents a
  // developer machine's existing toolchain from satisfying a fresh-host probe.
  const { binDir } = writeFakeBin({ root, name: 'id', content: '#!/bin/sh\necho 0\n' });
  for (const name of ['env', 'cat']) await symlink(`/usr/bin/${name}`, join(binDir, name));
  for (const name of ['go', 'rg']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
[ -n "$(cat "$TEST_HOST/build-tools.ready")" ] || exit 127
printf '%s\\n' '${name} ready'
` });
  }
  for (const name of ['node', 'corepack', 'yarn']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
if [ "$1" = --version ]; then
  if [ "${name}" = yarn ] && [ "\${TEST_REQUIRE_SYSTEM_CACHE:-0}" = 1 ]; then
    if [ "\${COREPACK_HOME:-}" != /usr/local/share/corepack ]; then
      [ "\${COREPACK_ENABLE_NETWORK:-1}" != 0 ] || exit 78
      echo '[fixture] readiness used an unprepared user cache and would prompt for download' >&2
      exit 78
    fi
    [ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT:-1}" = 0 ] || { echo '[fixture] download prompting is still enabled' >&2; exit 78; }
  fi
  version=$(cat "$TEST_HOST/${name}.version")
  [ -n "$version" ] || exit 127
  printf '%s\n' "$version"
elif [ "${name}" = corepack ]; then
  printf 'corepack %s\n' "$*" >> "$TEST_WRITES"
  case "$1" in
    enable) ;;
    prepare) [ "\${TEST_PREPARE_NO_YARN:-0}" = 1 ] || printf '1.22.22' > "$TEST_HOST/yarn.version" ;;
    *) exit 79 ;;
  esac
else
  exit 79
fi
` });
  }
  writeFakeBin({ root, name: 'bash', content: `#!/bin/sh
printf 'bash %s\n' "$*" >> "$TEST_WRITES"
[ "$1" = -lc ] || exit 79
case "$2" in *https://deb.nodesource.com/setup_24.x*) ;; *) exit 79 ;; esac
` });
  writeFakeBin({ root, name: 'apt-get', content: `#!/bin/sh
printf 'apt-get %s\n' "$*" >> "$TEST_WRITES"
case "$*" in
  'update -y'|'install -y --no-install-recommends ca-certificates curl gnupg') ;;
  'install -y nodejs') printf 'v24.0.0' > "$TEST_HOST/node.version" ;;
  'install -y --no-install-recommends ripgrep golang-go')
    [ "\${TEST_INSTALL_NO_BUILD_TOOLS:-0}" = 1 ] || printf ready > "$TEST_HOST/build-tools.ready" ;;
  *) exit 79 ;;
esac
` });
  writeFakeBin({ root, name: 'npm', content: `#!/bin/sh
printf 'npm %s\n' "$*" >> "$TEST_WRITES"
[ "$*" = 'install --global --no-audit --no-fund corepack' ] || exit 79
printf '0.34.0' > "$TEST_HOST/corepack.version"
` });
  writeFakeBin({ root, name: 'mkdir', content: `#!/bin/sh
printf 'mkdir %s\n' "$*" >> "$TEST_WRITES"
[ "$*" = '-p /usr/local/share/corepack' ] || exit 79
` });
  const script = await readFile(new URL('./linux-ubuntu-provision.sh', import.meta.url), 'utf8');
  return {
    root,
    run(extraEnv = {}) {
      // This is the same repository-free, streamed script surface used by
      // remote host preparation, so no companion Bun pin can be required.
      return spawnSync('/bin/bash', ['-c', script, '--', '--profile=toolchain'], {
        cwd: root,
        env: { ...process.env, PATH: binDir, HOME: root, BASH_ENV: '',
          HAPPIER_PROVISION_NODE_MAJOR: '24', HAPPIER_PROVISION_YARN_VERSION: '1.22.22',
          TEST_HOST: root, TEST_WRITES: log, ...extraEnv },
        encoding: 'utf8',
      });
    },
    writes: () => readFile(log, 'utf8'),
  };
}

test('toolchain profile bootstraps a fresh host and is a no-op on the next run', async t => {
  const host = await toolchainHost(t);
  const first = host.run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const writes = await host.writes();
  assert.match(writes, /https:\/\/deb\.nodesource\.com\/setup_24\.x/);
  assert.match(writes, /apt-get install -y nodejs/);
  assert.match(writes, /npm install --global --no-audit --no-fund corepack/);
  assert.match(writes, /corepack prepare yarn@1\.22\.22 --activate/);
  assert.equal((await readFile(join(host.root, 'node.version'), 'utf8')), 'v24.0.0');
  assert.equal((await readFile(join(host.root, 'yarn.version'), 'utf8')), '1.22.22');
  await assert.rejects(readFile(join(host.root, '.config/systemd/user/happier.slice')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(host.root, '.codex/config.toml')), { code: 'ENOENT' });
  const second = host.run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(await host.writes(), writes, 'ready toolchain must perform no writes or installs');
});

test('toolchain profile upgrades old Node and repairs absent Corepack without reinstalling ready Node', async t => {
  for (const node of ['v18.20.0', 'v24.2.0']) {
    const host = await toolchainHost(t, { node });
    const result = host.run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const writes = await host.writes();
    assert.equal(writes.includes('apt-get install -y nodejs'), node.startsWith('v18'));
    assert.match(writes, /npm install --global --no-audit --no-fund corepack/);
  }
});

test('toolchain profile preserves an already usable newer Node, Corepack and pinned Yarn', async t => {
  const host = await toolchainHost(t, { node: 'v25.1.0', corepack: '0.34.0', yarn: '1.22.22' });
  const result = host.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await host.writes(), '');
});

test('toolchain profile repairs missing CLI build tools and verifies the resulting executables', async t => {
  const host = await toolchainHost(t, { node: 'v24.2.0', corepack: '0.34.0', yarn: '1.22.22', buildTools: false });
  const first = host.run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(await readFile(join(host.root, 'build-tools.ready'), 'utf8'), 'ready');
  const writes = await host.writes();
  const second = host.run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(await host.writes(), writes, 'ready build tools must not be reinstalled');
  const broken = await toolchainHost(t, { node: 'v24.2.0', corepack: '0.34.0', yarn: '1.22.22', buildTools: false });
  assert.notEqual(broken.run({ TEST_INSTALL_NO_BUILD_TOOLS: '1' }).status, 0, 'installation without working Go/ripgrep must fail');
});

test('toolchain profile fails when preparation does not leave a usable Yarn executable', async t => {
  const host = await toolchainHost(t, { node: 'v24.2.0', corepack: '0.34.0' });
  const result = host.run({ TEST_PREPARE_NO_YARN: '1' });
  assert.notEqual(result.status, 0, result.stdout);
});

test('toolchain profile uses its prepared system cache without prompting during setup or ready-host probes', async t => {
  const host = await toolchainHost(t, { node: 'v24.2.0', corepack: '0.34.0' });
  const env = { TEST_REQUIRE_SYSTEM_CACHE: '1', COREPACK_HOME: '/unprepared/user/cache', COREPACK_ENABLE_DOWNLOAD_PROMPT: '1' };
  const first = host.run(env);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const writes = await host.writes();
  const second = host.run(env);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(await host.writes(), writes, 'the prepared system cache must satisfy subsequent checks without another install');
});
