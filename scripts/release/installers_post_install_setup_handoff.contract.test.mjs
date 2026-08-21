import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/**
 * Build a throwaway install root with a fake `happier` payload whose every
 * invocation is appended to a log file, so a test can assert on exactly which
 * CLI commands the installer decided to run.
 */
async function prepareInstallFixture(prefix, options = {}) {
  const authStatusJson = options.authStatusJson
    ?? '{"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}';

  const root = await mkdtemp(join(tmpdir(), prefix));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');
  const cliLogPath = join(root, 'cli-invocations.log');

  for (const dir of [homeDir, binDir, installDir, outBinDir, fixtureDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(homeDir, '.bashrc'), '# bashrc\n', 'utf8');
  await writeFile(cliLogPath, '', 'utf8');

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" = "-s" ]]; then echo Linux; exit 0; fi
if [[ "\${1:-}" = "-m" ]]; then echo x86_64; exit 0; fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const version = '9.9.9';
  const artifactStem = `happier-v${version}-linux-x64`;
  const artifactName = `${artifactStem}.tar.gz`;
  const artifactDir = join(fixtureDir, artifactStem);
  await mkdir(artifactDir, { recursive: true });

  // The fake CLI mirrors the real root help layout closely enough for the
  // installer's `--run` support gate ("^\s*(happier|<bin>)\s+<subcommand>\b").
  const happierBin = join(artifactDir, 'happier');
  await writeFile(
    happierBin,
    `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "\${HAPPIER_TEST_CLI_LOG}"
if [[ "\${1:-}" = "--version" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "\${1:-}" = "--help" ]]; then
  cat <<'HELPEOF'
happier - AI CLI On the Go

Usage:
  happier [options]           Start the default backend with mobile control
  happier setup               Connect this computer to your Happier account
  happier auth                Manage authentication
  happier status              Show status
HELPEOF
  exit 0
fi
if [[ "\${1:-}" = "self" && "\${2:-}" = "__install-payload" ]]; then
  # Mimic the real CLI's payload promotion so the installer takes its modern path.
  payload_root=""
  payload_version=""
  while [[ $# -gt 0 ]]; do
    case "\$1" in
      --payload-root) payload_root="\$2"; shift 2 ;;
      --version) payload_version="\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  dest="\${HAPPIER_HOME_DIR}/cli/versions/\${payload_version}/\$(basename "\${payload_root}")"
  mkdir -p "\$(dirname "\${dest}")"
  rm -rf "\${dest}"
  cp -R "\${payload_root}" "\${dest}"
  ln -sfn "\${dest}" "\${HAPPIER_HOME_DIR}/cli/current"
  exit 0
fi
if [[ "\${1:-}" = "auth" && "\${2:-}" = "status" ]]; then
  cat "\${HAPPIER_TEST_AUTH_STATUS_JSON_FILE}"
  exit 0
fi
if [[ "\${1:-}" = "setup" ]]; then
  # The CLI's own prompts read stdin; record whether the installer handed us a
  # terminal to read from.
  if [[ -t 0 ]]; then
    printf 'stdin_tty=yes\\n' >> "\${HAPPIER_TEST_CLI_LOG}"
  else
    printf 'stdin_tty=no\\n' >> "\${HAPPIER_TEST_CLI_LOG}"
  fi
  echo "fake setup ran"
  exit 0
fi
exit 0
`,
    'utf8',
  );
  await chmod(happierBin, 0o755);

  const authStatusJsonFile = join(root, 'auth-status.json');
  await writeFile(authStatusJsonFile, `${authStatusJson}\n`, 'utf8');

  const tarPath = join(fixtureDir, artifactName);
  const tarRes = spawnSync('tar', ['-czf', tarPath, '-C', fixtureDir, artifactStem], { encoding: 'utf8' });
  assert.equal(tarRes.status, 0, `tar failed: ${String(tarRes.stderr ?? '')}`);

  const checksumsName = `checksums-happier-v${version}.txt`;
  const checksumsPath = join(fixtureDir, checksumsName);
  await writeFile(checksumsPath, `${await sha256(tarPath)}  ${artifactName}\n`, 'utf8');

  const sigName = `${checksumsName}.minisig`;
  const sigPath = join(fixtureDir, sigName);
  await writeFile(sigPath, 'minisign-stub\n', 'utf8');

  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(minisignStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(minisignStubPath, 0o755);

  const sha256sumStubPath = join(binDir, 'sha256sum');
  await writeFile(
    sha256sumStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
file="$1"
hash="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
echo "$hash  $file"
`,
    'utf8',
  );
  await chmod(sha256sumStubPath, 0o755);

  const releaseJson = `{
  "assets": [
    { "name": "${artifactName}", "browser_download_url": "https://example.test/${artifactName}" },
    { "name": "${checksumsName}", "browser_download_url": "https://example.test/${checksumsName}" },
    { "name": "${sigName}", "browser_download_url": "https://example.test/${sigName}" }
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

  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
    HAPPIER_TEST_CLI_LOG: cliLogPath,
    HAPPIER_TEST_AUTH_STATUS_JSON_FILE: authStatusJsonFile,
  };
  delete env.HAPPIER_NONINTERACTIVE;

  return { root, env, cliLogPath, installerPath: join(repoRoot, 'scripts', 'release', 'installers', 'install.sh') };
}

// `script(1)` is the portable way to hand a child a real controlling terminal.
// BSD (macOS) and util-linux (most Linux distros) disagree on the invocation, so
// pick by what the host actually ships rather than by platform name.
const SCRIPT_IS_UTIL_LINUX = (() => {
  const probe = spawnSync('script', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && /util-linux/i.test(String(probe.stdout ?? ''));
})();

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Run the installer with a real controlling terminal via `script(1)`. */
function runInstallerOnPty(installerPath, args, env) {
  const command = ['bash', installerPath, ...args].map(shellQuote).join(' ');
  const scriptArgs = SCRIPT_IS_UTIL_LINUX
    ? ['-qec', command, '/dev/null']
    : ['-q', '/dev/null', 'bash', installerPath, ...args];
  // stdin must be inherited-or-ignored, never a pipe we close: `script` treats an
  // immediately-EOF stdin as "session over" and kills the child before it runs.
  return spawnSync('script', scriptArgs, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function readCliInvocations(cliLogPath) {
  const raw = await readFile(cliLogPath, 'utf8');
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('install.sh hands a fresh interactive install off to `happier setup`', async () => {
  assert.ok(existsSync('/usr/bin/script'), 'expected script(1) for a real pty');
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-fresh-');

  const res = runInstallerOnPty(fixture.installerPath, ['--without-daemon'], fixture.env);
  const output = String(res.stdout ?? '').replaceAll('\r', '');
  const invocations = await readCliInvocations(fixture.cliLogPath);

  assert.ok(
    invocations.includes('setup'),
    `expected the installer to run \`happier setup\` after a fresh interactive install; CLI invocations were ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );

  await rm(fixture.root, { recursive: true, force: true });
});

test('install.sh never runs setup unattended, and still prints next steps', async () => {
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-noninteractive-');
  const res = spawnSync('bash', [fixture.installerPath, '--without-daemon'], {
    env: { ...fixture.env, HAPPIER_NONINTERACTIVE: '1' },
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);

  const invocations = await readCliInvocations(fixture.cliLogPath);
  assert.ok(
    !invocations.includes('setup'),
    `an unattended install must never run guided setup; CLI invocations were ${JSON.stringify(invocations)}`,
  );
  assert.match(stdout, /Get started/i, 'expected the installer to always print next steps');
  assert.match(stdout, /happier setup/, 'expected unattended next steps to name the setup command');
  assert.match(stdout, /happier status/, 'expected next steps to name the status command');

  await rm(fixture.root, { recursive: true, force: true });
});

test('install.sh does not run setup unattended even when a controlling terminal exists but --yes was passed', async () => {
  assert.ok(existsSync('/usr/bin/script'), 'expected script(1) for a real pty');
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-yes-');

  const res = runInstallerOnPty(fixture.installerPath, ['--without-daemon', '--yes'], fixture.env);
  const output = String(res.stdout ?? '').replaceAll('\r', '');
  const invocations = await readCliInvocations(fixture.cliLogPath);

  assert.ok(
    !invocations.includes('setup'),
    `--yes must decline guided setup even with a tty; CLI invocations were ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );
  assert.match(output, /Get started/i, 'expected next steps even when setup is declined');

  await rm(fixture.root, { recursive: true, force: true });
});

test('install.sh re-run on an already-configured machine neither runs setup nor tells the user to', async () => {
  assert.ok(existsSync('/usr/bin/script'), 'expected script(1) for a real pty');
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-configured-', {
    authStatusJson: '{"ok":true,"kind":"auth_status","data":{"authenticated":true,"machineRegistered":true,"daemonRunning":false}}',
  });

  const res = runInstallerOnPty(fixture.installerPath, ['--without-daemon'], fixture.env);
  const output = String(res.stdout ?? '').replaceAll('\r', '');
  const invocations = await readCliInvocations(fixture.cliLogPath);

  assert.ok(
    !invocations.includes('setup'),
    `an already-configured machine must not be pushed through setup again; CLI invocations were ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );
  assert.match(output, /Get started/i, 'expected next steps on a re-run too');
  assert.ok(
    !/happier setup/.test(output),
    `an already-configured machine must not be told to run setup:\n--- output ---\n${output}`,
  );
  assert.match(output, /happier status/, 'expected next steps to name the status command');

  await rm(fixture.root, { recursive: true, force: true });
});

test('install.sh still runs setup when credentials exist but this machine is not registered', async () => {
  assert.ok(existsSync('/usr/bin/script'), 'expected script(1) for a real pty');
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-machine-missing-', {
    authStatusJson: '{"ok":true,"kind":"auth_status","data":{"authenticated":true,"machineRegistered":false,"daemonRunning":false}}',
  });

  const res = runInstallerOnPty(fixture.installerPath, ['--without-daemon'], fixture.env);
  const output = String(res.stdout ?? '').replaceAll('\r', '');
  const invocations = await readCliInvocations(fixture.cliLogPath);

  assert.ok(
    invocations.includes('setup'),
    `credentials without a registered machine still need guided setup; invocations were ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );

  await rm(fixture.root, { recursive: true, force: true });
});

test('install.sh gives guided setup the controlling terminal even when the installer itself was piped (curl | bash)', async () => {
  assert.ok(existsSync('/usr/bin/script'), 'expected script(1) for a real pty');
  const fixture = await prepareInstallFixture('happier-installer-setup-handoff-piped-');

  // Reproduce the documented one-liner: the installer's own stdin is an
  // exhausted pipe, but a controlling terminal exists. Without an explicit
  // /dev/tty redirect the CLI's prompts would read EOF immediately.
  const inner = ['bash', fixture.installerPath, '--without-daemon'].map(shellQuote).join(' ');
  const piped = `printf '' | ${inner}`;
  const scriptArgs = SCRIPT_IS_UTIL_LINUX
    ? ['-qec', piped, '/dev/null']
    : ['-q', '/dev/null', 'bash', '-c', piped];
  const res = spawnSync('script', scriptArgs, { env: fixture.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = String(res.stdout ?? '').replaceAll('\r', '');
  const invocations = await readCliInvocations(fixture.cliLogPath);

  assert.ok(
    invocations.includes('setup'),
    `expected the piped one-liner to still hand off; CLI invocations were ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );
  assert.ok(
    invocations.includes('stdin_tty=yes'),
    `guided setup must be able to prompt: it was handed ${JSON.stringify(invocations)}\n--- output ---\n${output}`,
  );

  await rm(fixture.root, { recursive: true, force: true });
});

// install.ps1 cannot be executed on the Linux/macOS hosts that run this suite, so
// the Windows behaviour is pinned here by shape and verified by running the real
// installer on a Windows host during development.
async function readInstallPs1() {
  return await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');
}

function extractPowerShellFunction(source, name) {
  const start = source.indexOf(`function ${name} {`);
  if (start === -1) return null;
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

test('install.ps1 routes every installer-initiated CLI invocation through one command-surface gate', async () => {
  const source = await readInstallPs1();
  const gate = extractPowerShellFunction(source, 'Test-InstalledCliSupportsCommandSurface');
  assert.ok(gate, 'expected a single owner for the installed-CLI command-surface check');
  assert.match(gate, /\$pattern\s*=\s*"/, 'expected the gate to own the help-matching pattern');

  const postInstall = extractPowerShellFunction(source, 'Invoke-PostInstallAction');
  assert.ok(postInstall, 'expected Invoke-PostInstallAction to exist');
  assert.match(
    postInstall,
    /Test-InstalledCliSupportsCommandSurface\s+-CliPath\s+\$CliPath\s+-requiredSubcommand\s+\$requiredSubcommand/,
    'expected -Run to reuse the shared command-surface gate rather than re-deriving it',
  );
  assert.doesNotMatch(
    postInstall,
    /\$pattern\s*=\s*"/,
    'the -Run support gate must not keep a second copy of the help-matching pattern',
  );
});

test('install.ps1 hands a fresh interactive install off to guided setup and never does it unattended', async () => {
  const source = await readInstallPs1();
  const decision = extractPowerShellFunction(source, 'Test-ShouldHandOffToGuidedSetup');
  assert.ok(decision, 'expected an explicit handoff decision on Windows too');
  assert.match(
    decision,
    /Test-InteractiveInstallerPromptAvailable/,
    'unattended runs (-Yes / HAPPIER_NONINTERACTIVE / redirected stdin) must decline setup',
  );
  assert.match(
    decision,
    /PostInstallMachineIsConfigured/,
    'an already-configured machine must not be pushed through setup again',
  );
  assert.match(
    decision,
    /Test-InstalledCliSupportsCommandSurface\s+-CliPath\s+\$CliPath\s+-requiredSubcommand\s+"setup"/,
    'the handoff must clear the same support gate as an explicit -Run setup',
  );

  assert.match(
    source,
    /elseif\s*\(Test-ShouldHandOffToGuidedSetup\s+-CliPath\s+\$invoker\)\s*\{[\s\S]*?\$Run\s*=\s*"setup"[\s\S]*?Invoke-PostInstallAction\s+-CliPath\s+\$invoker/,
    'expected the handoff to reuse the existing -Run machinery rather than a second dispatch path',
  );
  const invocation = extractPowerShellFunction(source, 'Invoke-InstallerCommandWithDaemonServiceContext');
  assert.ok(invocation, 'expected the shared native-command wrapper');
  assert.match(
    invocation,
    /LastInstallerCommandExitCode\s*=\s*if\s*\(\$null\s+-eq\s+\$LASTEXITCODE\)/,
    'native non-zero exits must be captured explicitly on Windows PowerShell 5.1',
  );
  assert.match(
    source,
    /PostInstallSetupIsDone\s*=\s*\(\$script:LastInstallerCommandExitCode\s+-eq\s+0\)/,
    'automatic setup is done only when the CLI exited zero',
  );
  assert.match(
    source,
    /if\s*\(\$script:PostInstallActionWasExplicit\)\s*\{\s*exit\s+\$script:PostInstallRunStatus/,
    'explicit -Run/-SetupRelay must propagate the child exit code',
  );
});

test('install.ps1 always closes an install with next steps instead of a version string', async () => {
  const source = await readInstallPs1();
  const printer = extractPowerShellFunction(source, 'Write-PostInstallGetStarted');
  assert.ok(printer, 'expected a next-steps printer');
  assert.match(printer, /setup/, 'expected the setup command to be offered when it is still needed');
  assert.match(printer, /status/, 'expected the status command in next steps');
  assert.match(
    printer,
    /if\s*\(-not\s+\$script:PostInstallSetupIsDone\)/,
    'expected the setup line to be dropped once this computer is set up',
  );

  const tail = source.slice(source.lastIndexOf('Invoke-PostInstallAction -CliPath $invoker'));
  assert.match(
    tail,
    /Write-PostInstallGetStarted/,
    'expected next steps to be printed after the post-install action, on every install',
  );
});
