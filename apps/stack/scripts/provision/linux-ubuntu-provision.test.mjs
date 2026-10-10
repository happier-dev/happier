import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('fresh Lima provisioning forwards its CRLF companion or explicit Bun override without executing a live guest', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-lima-bun-owner-' });
  const fixtureProvisionDir = join(root, 'apps', 'stack', 'scripts', 'provision');
  await mkdir(fixtureProvisionDir, { recursive: true });
  for (const name of ['macos-lima-vm.sh', 'linux-ubuntu-provision.sh']) {
    await writeFile(join(fixtureProvisionDir, name), await readFile(join(__dirname, name)));
  }
  // limactl is the genuine VM/process boundary. Never execute the streamed
  // provisioner: unknown VM commands fail closed rather than reaching the host.
  const { binDir } = writeFakeBin({ root, name: 'limactl', content: [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$1" in',
    '  create) /bin/mkdir -p "$(dirname "$TEST_LIMA_CONFIG")"; echo "images: []" > "$TEST_LIMA_CONFIG" ;;',
    '  start|stop) ;;',
    '  shell)',
    '    [[ "$4" == env && "$5" == "HAPPIER_PROVISION_BUN_VERSION=$TEST_EXPECTED_BUN_VERSION" ]] || exit 79',
    '    /bin/cat > /dev/null',
    '    ;;',
    '  *) exit 79 ;;',
    'esac',
  ].join('\n') + '\n' });
  for (const [index, profile, override, expected] of [
    [0, 'happier', '', '9.9.9'],
    [1, 'happier', '8.8.8', '8.8.8'],
    [2, 'installer', '', ''],
  ]) {
    const limaHome = join(root, `lima-${index}`);
    if (profile === 'happier') await writeFile(join(fixtureProvisionDir, '.bun-version'), '9.9.9\r\n');
    else await unlink(join(fixtureProvisionDir, '.bun-version'));
    const result = spawnSync('bash', [join(fixtureProvisionDir, 'macos-lima-vm.sh'), 'fixture'], {
      env: { ...process.env, HOME: root, LIMA_HOME: limaHome, PATH: `${binDir}:${process.env.PATH}`,
        HSTACK_PROVISION_PROFILE: profile, HAPPIER_PROVISION_BUN_VERSION: override,
        TEST_LIMA_CONFIG: join(limaHome, 'fixture', 'lima.yaml'), TEST_EXPECTED_BUN_VERSION: expected },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('downloaded happier provisioning fails before OS writes without a valid companion or explicit Bun version', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-bun-owner-' });
  const script = join(root, 'linux-ubuntu-provision.sh');
  await writeFile(script, await readFile(join(__dirname, 'linux-ubuntu-provision.sh')));
  const aptLog = join(root, 'apt.log');
  const { binDir } = writeFakeBin({ root, name: 'apt-get', content:
    '#!/bin/sh\nprintf apt > "$TEST_APT_LOG"\nexit 79\n' });
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root,
    HAPPIER_PROVISION_BUN_VERSION: '', TEST_APT_LOG: aptLog };
  const absent = spawnSync('bash', [script, '--profile=happier'], { env, encoding: 'utf8' });
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /missing Bun version owner/);
  await writeFile(join(root, '.bun-version'), 'not-a-version\n');
  const invalid = spawnSync('bash', [script, '--profile=happier'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /invalid Bun version/);
  await assert.rejects(readFile(aptLog), { code: 'ENOENT' });
});

test('QA provisioning reuses only the browser install owner and preserves user Agent configuration', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-provision-' });
  const realCorepack = spawnSync('bash', ['-c', 'command -v corepack'], { encoding: 'utf8' });
  assert.equal(realCorepack.status, 0, realCorepack.stderr);
  const manifest = JSON.stringify({ packageManager: 'yarn@1.22.22' });
  await writeFile(join(root, 'package.json'), manifest);
  const log = join(root, 'browser.log');
  const { binDir } = writeFakeBin({ root, name: 'agent-browser', content:
    '#!/bin/sh\nif [ "$1" = --version ]; then echo "agent-browser 0.34.0"; else printf "%s\\n" "$*" >> "$QA_BROWSER_LOG"; fi\n' });
  writeFakeBin({ root, name: 'uname', content: '#!/bin/sh\necho x86_64\n' });
  // If QA takes the full worker setup path, fail at its first OS/package boundary.
  for (const name of ['sudo', 'apt-get', 'corepack', 'python3']) {
    writeFakeBin({ root, name, content: '#!/bin/sh\necho "unexpected non-browser setup" >&2\nexit 77\n' });
  }
  const result = spawnSync('bash', [join(__dirname, 'linux-ubuntu-provision.sh'), '--profile=qa'], {
    env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH}`, QA_BROWSER_LOG: log }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(log, 'utf8')).trim(), 'install --with-deps');
  await assert.rejects(readFile(join(root, '.codex', 'config.toml')), { code: 'ENOENT' });
  // An absent browser CLI must install through the narrow non-interactive root boundary.
  const installed = join(root, 'installed');
  const privilegeLog = join(root, 'privilege.log');
  const corepackCache = join(root, 'corepack-cache');
  const npmPackage = join(corepackCache, 'v1', 'npm', '11.0.0');
  await mkdir(join(npmPackage, 'bin'), { recursive: true });
  await writeFile(join(corepackCache, 'lastKnownGood.json'), JSON.stringify({ npm: '11.0.0' }));
  await writeFile(join(npmPackage, '.corepack'), JSON.stringify({ bin: { npm: 'bin/npm-cli.js' }, hash: 'fixture' }));
  // npm's package acquisition/install is the external boundary. The real
  // Corepack still resolves the Yarn project and invokes this cached npm CLI.
  await writeFile(join(npmPackage, 'bin/npm-cli.js'), `
require('node:assert/strict').deepEqual(process.argv.slice(2), ['install', '--global', '--no-audit', '--no-fund', '--allow-scripts=agent-browser', 'agent-browser@0.34.0']);
require('node:fs').writeFileSync(process.env.QA_INSTALLED, 'installed');
`);
  writeFakeBin({ root, name: 'id', content: '#!/bin/sh\necho 1000\n' });
  writeFakeBin({ root, name: 'agent-browser', content:
    '#!/bin/sh\nif [ "$1" = --version ]; then if [ -f "$QA_INSTALLED" ]; then echo "agent-browser 0.34.0"; else echo 0.0.0; fi; fi\n' });
  writeFakeBin({ root, name: 'sudo', content:
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$QA_PRIVILEGE_LOG"\n[ "$1" = -n ] || exit 78\nshift\nunset COREPACK_ENABLE_PROJECT_SPEC\nexec "$@"\n' });
  writeFakeBin({ root, name: 'corepack', content:
    '#!/bin/sh\nCOREPACK_HOME="$QA_COREPACK_CACHE" COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0 exec "$QA_NODE_REAL" "$QA_COREPACK_REAL" "$@"\n' });
  writeFakeBin({ root, name: 'node', content:
    '#!/bin/sh\nif [ "$1" = -p ]; then printf "%s\\n" "$QA_NODE_EXEC"; else exec "$@"; fi\n' });
  const initialSetup = spawnSync('bash', [join(__dirname, 'linux-ubuntu-provision.sh'), '--profile=qa'], {
    cwd: root,
    env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH}`, QA_NODE_EXEC: join(binDir, 'node'),
      QA_INSTALLED: installed, QA_PRIVILEGE_LOG: privilegeLog, QA_COREPACK_CACHE: corepackCache,
      QA_NODE_REAL: process.execPath, QA_COREPACK_REAL: realCorepack.stdout.trim(),
      COREPACK_ENABLE_PROJECT_SPEC: '1', COREPACK_ENABLE_STRICT: '1', COREPACK_ENV_FILE: '0' }, encoding: 'utf8',
  });
  assert.equal(initialSetup.status, 0, initialSetup.stderr);
  assert.equal(await readFile(installed, 'utf8'), 'installed');
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
  assert.match(await readFile(privilegeLog, 'utf8'), new RegExp(`^-n (?:env COREPACK_ENABLE_PROJECT_SPEC=0 )?${binDir}/node ${binDir}/corepack npm install --global`));
});

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

test('linux provision consumes its companion Bun pin and runs corepack enable as root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-linux-provision-test-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'logs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(
    join(root, '.codex', 'config.toml'),
    [
      'model = "older-model"',
      'unrelated_root = "preserve-me"',
      '',
      '[features]',
      'hooks = false',
      'unrelated_feature = "preserve-me-too"',
      '',
      '[[preserved_items]]',
      'hooks = false',
      'name = "array-entry"',
      '',
      '[mcp_servers.preserved]',
      'command = "preserved-command"',
      '',
    ].join('\n'),
    'utf8',
  );

  const corepackLog = join(logDir, 'corepack.log');
  const aptLog = join(logDir, 'apt.log');
  const mutagenLog = join(logDir, 'mutagen.log');
  const bunDownloadLog = join(logDir, 'bun-download.log');
  const apparmorLog = join(logDir, 'apparmor.log');
  const agentBrowserLog = join(logDir, 'agent-browser.log');
  const agentBrowserInstalled = join(logDir, 'agent-browser-installed');
  const bashEnvPath = join(root, 'test-bash-env');
  await writeFile(
    bashEnvPath,
    `bun() { if [[ -x ${JSON.stringify(join(binDir, 'bun'))} ]]; then ${JSON.stringify(join(binDir, 'bun'))} "$@"; else echo 0.0.0; fi; }\n`,
    'utf8',
  );

  const idPath = join(binDir, 'id');
  await writeFile(
    idPath,
    ['#!/usr/bin/env bash', 'if [[ "${1:-}" == "-u" ]]; then echo 1000; else echo "uid=1000"; fi'].join('\n') + '\n',
    'utf-8'
  );
  await chmod(idPath, 0o755);

  const sudoPath = join(binDir, 'sudo');
  await writeFile(
    sudoPath,
    ['#!/usr/bin/env bash', 'export RUN_AS_ROOT=1', 'exec "$@"'].join('\n') + '\n',
    'utf-8'
  );
  await chmod(sudoPath, 0o755);

  const aptPath = join(binDir, 'apt-get');
  await writeFile(
    aptPath,
    [
      '#!/usr/bin/env bash',
      `echo "apt-get $*" >> ${JSON.stringify(aptLog)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(aptPath, 0o755);

  const mkdirPath = join(binDir, 'mkdir');
  await writeFile(
    mkdirPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'for a in "$@"; do',
      '  if [[ "$a" == "/usr/local/share/corepack" ]]; then',
      '    exit 0',
      '  fi',
      'done',
      'exec /bin/mkdir "$@"',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(mkdirPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(nodePath, ['#!/usr/bin/env bash', 'echo "v24.0.0"'].join('\n') + '\n', 'utf-8');
  await chmod(nodePath, 0o755);

  const corepackPath = join(binDir, 'corepack');
  await writeFile(
    corepackPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "corepack $* root=${RUN_AS_ROOT:-0} project_spec=${COREPACK_ENABLE_PROJECT_SPEC:-unset}" >> ' + JSON.stringify(corepackLog),
      'if [[ "${1:-}" == "enable" && "${RUN_AS_ROOT:-0}" != "1" ]]; then',
      '  echo "enable must run as root" >&2',
      '  exit 13',
      'fi',
      `if [[ "\${1:-}" == "npm" && "$*" == *"agent-browser@0.34.0"* ]]; then : > ${JSON.stringify(agentBrowserInstalled)}; fi`,
      'if [[ "${1:-}" == "npm" && "$*" == *"playwright@1.58.2"* ]]; then',
      '  browser_dir="$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1208/chrome-linux"',
      '  /bin/mkdir -p "$browser_dir"',
      '  : > "$browser_dir/headless_shell"',
      '  chmod 755 "$browser_dir/headless_shell"',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(corepackPath, 0o755);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, ['#!/usr/bin/env bash', 'echo "1.22.22"'].join('\n') + '\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const agentBrowserPath = join(binDir, 'agent-browser');
  await writeFile(
    agentBrowserPath,
    [
      '#!/usr/bin/env bash',
      `echo "agent-browser $*" >> ${JSON.stringify(agentBrowserLog)}`,
      `if [[ "\${1:-}" == "--version" ]]; then if [[ -f ${JSON.stringify(agentBrowserInstalled)} ]]; then echo 0.34.0; else echo 0.0.0; fi; fi`,
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(agentBrowserPath, 0o755);

  const existingMutagenPath = join(binDir, 'mutagen');
  await writeFile(existingMutagenPath, '#!/usr/bin/env bash\necho 0.0.0\n', 'utf-8');
  await chmod(existingMutagenPath, 0o755);

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, '#!/usr/bin/env bash\necho aarch64\n', 'utf-8');
  await chmod(unamePath, 0o755);

  const curlPath = join(binDir, 'curl');
  await writeFile(
    curlPath,
    [
      '#!/usr/bin/env bash',
      `echo "curl $*" >> ${JSON.stringify(mutagenLog)}`,
      `if [[ "$*" == *"github.com/oven-sh/bun/releases/download"* ]]; then echo "curl $*" >> ${JSON.stringify(bunDownloadLog)}; fi`,
      'output=""',
      'while [[ $# -gt 0 ]]; do',
      '  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else shift; fi',
      'done',
      ': > "$output"',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(curlPath, 0o755);

  const tarPath = join(binDir, 'tar');
  await writeFile(
    tarPath,
    [
      '#!/usr/bin/env bash',
      'destination=""',
      'while [[ $# -gt 0 ]]; do',
      '  if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else shift; fi',
      'done',
      'printf "#!/usr/bin/env bash\\necho 0.18.1\\n" > "$destination/mutagen"',
      'chmod 755 "$destination/mutagen"',
      ': > "$destination/mutagen-agents.tar.gz"',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(tarPath, 0o755);

  const unzipPath = join(binDir, 'unzip');
  await writeFile(
    unzipPath,
    [
      '#!/usr/bin/env bash',
      'destination=""',
      'while [[ $# -gt 0 ]]; do',
      '  if [[ "$1" == "-d" ]]; then destination="$2"; shift 2; else shift; fi',
      'done',
      'bundle_dir="$destination/bun-linux-aarch64"',
      '/bin/mkdir -p "$bundle_dir"',
      'printf "#!/usr/bin/env bash\\necho 9.9.9\\n" > "$bundle_dir/bun"',
      'chmod 755 "$bundle_dir/bun"',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(unzipPath, 0o755);

  const installPath = join(binDir, 'install');
  await writeFile(
    installPath,
    [
      '#!/usr/bin/env bash',
      `echo "install $*" >> ${JSON.stringify(mutagenLog)}`,
      'source="${@: -2:1}"',
      'destination="${@: -1}"',
      `if [[ "$destination" == "/usr/local/bin/mutagen" ]]; then cp "$source" ${JSON.stringify(join(binDir, 'mutagen'))}; chmod 755 ${JSON.stringify(join(binDir, 'mutagen'))}; fi`,
      `if [[ "$destination" == "/usr/local/bin/bun" ]]; then cp "$source" ${JSON.stringify(join(binDir, 'bun'))}; chmod 755 ${JSON.stringify(join(binDir, 'bun'))}; fi`,
      `if [[ "$destination" == ${JSON.stringify(join(root, '.agent-browser', 'config.json'))} ]]; then cp "$source" "$destination"; chmod 644 "$destination"; fi`,
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(installPath, 0o755);

  const apparmorParserPath = join(binDir, 'apparmor_parser');
  await writeFile(
    apparmorParserPath,
    `#!/usr/bin/env bash\necho "apparmor_parser $*" >> ${JSON.stringify(apparmorLog)}\n`,
    'utf-8',
  );
  await chmod(apparmorParserPath, 0o755);

  const aaEnabledPath = join(binDir, 'aa-enabled');
  await writeFile(aaEnabledPath, '#!/usr/bin/env bash\nexit 0\n');
  await chmod(aaEnabledPath, 0o755);

  // A downloaded provision script has no checkout. Its same-ref companion pin
  // must drive the real install path, independently of the caller's cwd.
  const scriptPath = join(root, 'linux-ubuntu-provision.sh');
  await writeFile(scriptPath, await readFile(join(__dirname, 'linux-ubuntu-provision.sh')));
  // Windows checkout line endings must not change the scalar version.
  await writeFile(join(root, '.bun-version'), '9.9.9\r\n');
  const res = spawnSync('bash', [scriptPath, '--profile=happier'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HAPPIER_PROVISION_BUN_VERSION: '',
      BASH_ENV: bashEnvPath,
    },
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const userSystemdUnitDir = join(root, '.config', 'systemd', 'user');
  const happierSliceUnit = await readFile(join(userSystemdUnitDir, 'happier.slice'), 'utf8');
  const happierCriticalSliceUnit = await readFile(join(userSystemdUnitDir, 'happier-critical.slice'), 'utf8');
  const happierJobsSliceUnit = await readFile(join(userSystemdUnitDir, 'happier-jobs.slice'), 'utf8');
  assert.match(happierSliceUnit, /^\[Unit\]$/m);
  assert.match(happierCriticalSliceUnit, /^\[Slice\]$/m);
  assert.match(happierCriticalSliceUnit, /^MemoryLow=4G$/m);
  assert.doesNotMatch(happierCriticalSliceUnit, /^(?:MemoryMax|MemoryHigh|TasksMax|OOM\w*)=/mu);
  assert.match(happierJobsSliceUnit, /^\[Slice\]$/m);
  assert.match(happierJobsSliceUnit, /^CPUWeight=50$/m);
  assert.match(happierJobsSliceUnit, /^IOWeight=50$/m);
  assert.match(happierJobsSliceUnit, /^MemoryHigh=80%$/m);
  assert.doesNotMatch(happierJobsSliceUnit, /^(?:MemoryMax|TasksMax|OOM\w*)=/mu);

  const corepackOut = await readIfExists(corepackLog);
  assert.match(corepackOut, /corepack enable root=1/, 'expected corepack enable to be invoked via sudo/as_root');
  assert.ok(!corepackOut.includes('corepack enable root=0'), 'expected corepack enable not to run unprivileged');

  const aptOut = await readIfExists(aptLog);
  assert.match(aptOut, /apt-get update/, 'expected apt-get update to run');
  assert.match(aptOut, /apt-get install/, 'expected apt-get install to run');
  assert.match(aptOut, /ripgrep/, 'expected the worker source-search tool to be installed');
  assert.match(aptOut, /(?:^|\s)gh(?:\s|$)/, 'expected the GitHub CLI to be installed');
  assert.match(aptOut, /(?:^|\s)golang-go(?:\s|$)/, 'expected the daemon support build toolchain to be installed');
  assert.match(aptOut, /apt-get install[^\n]*[\s\S]*bubblewrap/, 'expected the agent sandbox runtime to be installed');
  const mutagenOut = await readIfExists(mutagenLog);
  assert.match(
    mutagenOut,
    /mutagen_linux_arm64_v0\.18\.1\.tar\.gz/,
    'expected the matching ARM64 Mutagen release to be installed',
  );
  assert.match(mutagenOut, /install .*mutagen-agents\.tar\.gz \/usr\/local\/bin\/mutagen-agents\.tar\.gz/);
  assert.match(await readIfExists(bunDownloadLog), /bun-v9\.9\.9\/bun-linux-aarch64\.zip/);
  assert.match(mutagenOut, /install .*\/bun-linux-aarch64\/bun \/usr\/local\/bin\/bun/);
  assert.equal(spawnSync(join(binDir, 'bun'), ['--version'], { encoding: 'utf-8' }).stdout.trim(), '9.9.9');
  assert.match(mutagenOut, /install .* \/etc\/apparmor\.d\/happier-bwrap/);
  assert.match(await readIfExists(apparmorLog), /apparmor_parser -r \/etc\/apparmor\.d\/happier-bwrap/);
  assert.match(
    corepackOut,
    /corepack npm install --global --no-audit --no-fund --allow-scripts=agent-browser agent-browser@0\.34\.0 root=1/,
  );
  assert.match(
    corepackOut,
    /corepack npm exec --yes --package=playwright@1\.58\.2 -- playwright install --with-deps chromium-headless-shell root=0 project_spec=0/,
  );
  assert.doesNotMatch(await readIfExists(agentBrowserLog), /agent-browser install --with-deps/);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, '.agent-browser', 'config.json'), 'utf8')),
    {
      executablePath: join(
        root,
        '.cache',
        'happier',
        'agent-browser-browsers',
        'chromium_headless_shell-1208',
        'chrome-linux',
        'headless_shell',
      ),
      args: '--no-sandbox',
    },
  );

  const codexConfigPath = join(root, '.codex', 'config.toml');
  const codexConfig = await readFile(codexConfigPath, 'utf8');
  for (const expected of [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    'cli_auth_credentials_store = "file"',
    'project_doc_max_bytes = 98304',
    'startup_timeout_sec = 20',
    'web_search = "live"',
    'preferred_auth_method = "chatgpt"',
    'personality = "pragmatic"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'service_tier = "default"',
    'hooks = true',
    'unified_exec = true',
    'shell_snapshot = true',
    'multi_agent = true',
    'goals = true',
    'terminal_resize_reflow = false',
    'js_repl = false',
    '[features.multi_agent_v2]',
    'hide_spawn_agent_metadata = false',
    'tool_namespace = "agents"',
    'max_concurrent_threads_per_session = 42',
    '[agents]',
    'max_threads = 100',
    '[sandbox_workspace_write]',
    'network_access = true',
  ]) {
    assert.match(codexConfig, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(codexConfig, /^unrelated_root = "preserve-me"$/m);
  assert.match(codexConfig, /^unrelated_feature = "preserve-me-too"$/m);
  assert.match(codexConfig, /^\[\[preserved_items\]\]\nhooks = false\nname = "array-entry"$/m);
  assert.match(codexConfig, /^\[mcp_servers\.preserved\]$/m);
  assert.match(codexConfig, /^command = "preserved-command"$/m);

  const secondResult = spawnSync('bash', [scriptPath, '--profile=happier'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HAPPIER_PROVISION_BUN_VERSION: '9.9.9',
      BASH_ENV: bashEnvPath,
    },
    encoding: 'utf-8',
  });
  assert.equal(secondResult.status, 0, `expected second exit 0\nstdout:\n${secondResult.stdout}\nstderr:\n${secondResult.stderr}`);
  // aa-enabled and apparmor_parser are OS boundaries: WSL can ship the
  // userspace parser without exposing the kernel profile-loading interface.
  await writeFile(aaEnabledPath, '#!/usr/bin/env bash\nexit 1\n');
  await writeFile(join(binDir, 'apparmor_parser'), '#!/usr/bin/env bash\nexit 17\n');
  const unsupportedKernel = spawnSync('bash', [scriptPath, '--profile=happier'], {
    cwd: root, env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH ?? ''}`, HAPPIER_PROVISION_BUN_VERSION: '9.9.9', BASH_ENV: bashEnvPath }, encoding: 'utf8',
  });
  assert.equal(unsupportedKernel.status, 0, `unsupported AppArmor kernel must remain provisionable: ${unsupportedKernel.stderr}`);
  assert.equal(await readFile(codexConfigPath, 'utf8'), codexConfig, 'expected Codex config convergence to be idempotent');
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier.slice'), 'utf8'), happierSliceUnit);
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier-critical.slice'), 'utf8'), happierCriticalSliceUnit);
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier-jobs.slice'), 'utf8'), happierJobsSliceUnit);
  assert.equal(
    (await readIfExists(bunDownloadLog)).match(/bun-v9\.9\.9\/bun-linux-aarch64\.zip/g)?.length,
    1,
    'expected an already-pinned Bun installation to avoid a second download',
  );
});

test('linux provision maps both managed Linux architectures to Bun release assets', async () => {
  const script = await readFile(join(__dirname, 'linux-ubuntu-provision.sh'), 'utf8');

  assert.match(script, /aarch64\|arm64\) BUN_ARCH="aarch64"/);
  assert.match(script, /x86_64\|amd64\) BUN_ARCH="x64"/);
});

test('linux provision (installer profile) does not touch node/corepack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-linux-provision-installer-test-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'logs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const corepackLog = join(logDir, 'corepack.log');

  const idPath = join(binDir, 'id');
  await writeFile(idPath, ['#!/usr/bin/env bash', 'echo 1000'].join('\n') + '\n', 'utf-8');
  await chmod(idPath, 0o755);

  const sudoPath = join(binDir, 'sudo');
  await writeFile(sudoPath, ['#!/usr/bin/env bash', 'export RUN_AS_ROOT=1', 'exec "$@"'].join('\n') + '\n', 'utf-8');
  await chmod(sudoPath, 0o755);

  const aptPath = join(binDir, 'apt-get');
  await writeFile(aptPath, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf-8');
  await chmod(aptPath, 0o755);

  const corepackPath = join(binDir, 'corepack');
  await writeFile(
    corepackPath,
    [
      '#!/usr/bin/env bash',
      `echo "corepack $*" >> ${JSON.stringify(corepackLog)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(corepackPath, 0o755);

  const scriptPath = join(__dirname, 'linux-ubuntu-provision.sh');
  const res = spawnSync('bash', [scriptPath, '--profile=installer'], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const corepackOut = await readIfExists(corepackLog);
  assert.equal(corepackOut.trim(), '', 'expected no corepack calls in installer profile');
});
