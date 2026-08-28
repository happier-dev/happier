import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

test('linux provision (happier profile) runs corepack enable as root', async () => {
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
      'printf "#!/usr/bin/env bash\\necho 1.3.5\\n" > "$bundle_dir/bun"',
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

  const scriptPath = join(__dirname, 'linux-ubuntu-provision.sh');
  const res = spawnSync('bash', [scriptPath, '--profile=happier'], {
    cwd: root,
    env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH ?? ''}` },
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
  assert.doesNotMatch(happierCriticalSliceUnit, /MemoryMax|MemoryHigh|TasksMax|OOM/u);
  assert.match(happierJobsSliceUnit, /^\[Slice\]$/m);
  assert.match(happierJobsSliceUnit, /^CPUWeight=50$/m);
  assert.match(happierJobsSliceUnit, /^IOWeight=50$/m);
  assert.doesNotMatch(happierJobsSliceUnit, /MemoryMax|MemoryHigh|TasksMax|OOM/u);

  const corepackOut = await readIfExists(corepackLog);
  assert.match(corepackOut, /corepack enable root=1/, 'expected corepack enable to be invoked via sudo/as_root');
  assert.ok(!corepackOut.includes('corepack enable root=0'), 'expected corepack enable not to run unprivileged');

  const aptOut = await readIfExists(aptLog);
  assert.match(aptOut, /apt-get update/, 'expected apt-get update to run');
  assert.match(aptOut, /apt-get install/, 'expected apt-get install to run');
  assert.match(aptOut, /ripgrep/, 'expected the worker source-search tool to be installed');
  assert.match(aptOut, /apt-get install[^\n]*[\s\S]*bubblewrap/, 'expected the agent sandbox runtime to be installed');
  const mutagenOut = await readIfExists(mutagenLog);
  assert.match(
    mutagenOut,
    /mutagen_linux_arm64_v0\.18\.1\.tar\.gz/,
    'expected the matching ARM64 Mutagen release to be installed',
  );
  assert.match(mutagenOut, /install .*mutagen-agents\.tar\.gz \/usr\/local\/bin\/mutagen-agents\.tar\.gz/);
  assert.match(await readIfExists(bunDownloadLog), /bun-v1\.3\.5\/bun-linux-aarch64\.zip/);
  assert.match(mutagenOut, /install .*\/bun-linux-aarch64\/bun \/usr\/local\/bin\/bun/);
  assert.equal(spawnSync(join(binDir, 'bun'), ['--version'], { encoding: 'utf-8' }).stdout.trim(), '1.3.5');
  assert.match(mutagenOut, /install .* \/etc\/apparmor\.d\/happier-bwrap/);
  assert.match(await readIfExists(apparmorLog), /apparmor_parser -r \/etc\/apparmor\.d\/happier-bwrap/);
  assert.match(
    corepackOut,
    /corepack npm install --global --no-audit --no-fund --allow-scripts=agent-browser agent-browser@0\.34\.0 root=1/,
  );
  assert.match(
    corepackOut,
    /corepack npm exec --yes --package=playwright@1\.58\.2 -- playwright install chromium-headless-shell root=0 project_spec=0/,
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
    'project_doc_max_bytes = 81920',
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
    env: { ...process.env, HOME: root, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf-8',
  });
  assert.equal(secondResult.status, 0, `expected second exit 0\nstdout:\n${secondResult.stdout}\nstderr:\n${secondResult.stderr}`);
  assert.equal(await readFile(codexConfigPath, 'utf8'), codexConfig, 'expected Codex config convergence to be idempotent');
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier.slice'), 'utf8'), happierSliceUnit);
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier-critical.slice'), 'utf8'), happierCriticalSliceUnit);
  assert.equal(await readFile(join(userSystemdUnitDir, 'happier-jobs.slice'), 'utf8'), happierJobsSliceUnit);
  assert.equal(
    (await readIfExists(bunDownloadLog)).match(/bun-v1\.3\.5\/bun-linux-aarch64\.zip/g)?.length,
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
