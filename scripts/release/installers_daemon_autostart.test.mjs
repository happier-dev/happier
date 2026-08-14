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

async function runInstallerScenario(envOverrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-daemon-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const fixtureDir = join(root, 'fixture');
  const systemdUserDir = join(root, 'systemd', 'user');
  const systemdSystemDir = join(root, 'systemd', 'system');
  const logPath = join(root, 'happier.invocations.log');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(systemdUserDir, { recursive: true });
  await mkdir(systemdSystemDir, { recursive: true });

  const {
    __installerArgs: installerArgs = [],
    HAPPIER_TEST_NATIVE_USER_SERVICE_CONTENT: nativeUserServiceContent,
    HAPPIER_TEST_NATIVE_SYSTEM_SERVICE_CONTENT: nativeSystemServiceContent,
    ...installerEnvOverrides
  } = envOverrides;

  if (nativeUserServiceContent) {
    await writeFile(join(systemdUserDir, 'happier-daemon.default.service'), nativeUserServiceContent, 'utf8');
  }
  if (nativeSystemServiceContent) {
    await writeFile(join(systemdSystemDir, 'happier-daemon.default.service'), nativeSystemServiceContent, 'utf8');
  }

  // Stub uname so the installer deterministically selects linux-x64 assets.
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

  // Build two tarballs to simulate a rolling release tag that contains multiple versions.
  // The installer should select a consistent set of assets (tarball + matching checksums/sig),
  // not mix checksums from a newer version with a tarball from an older one.
  const artifactVersions = ['1.2.3', '1.2.4'];
  const artifacts = [];
  for (const version of artifactVersions) {
    const artifactStem = `happier-v${version}-linux-x64`;
    const artifactName = `${artifactStem}.tar.gz`;
    const artifactDir = join(fixtureDir, artifactStem);
    await mkdir(join(artifactDir, 'package-dist'), { recursive: true });
  const happierBin = join(artifactDir, 'happier');
  await writeFile(
    happierBin,
    `#!/usr/bin/env bash
set -euo pipefail
copy_tree() {
  local source="$1"
  local target="$2"
  mkdir -p "$target"
  cp -R "$source"/. "$target"/
}
if [[ "$1" = "--version" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" = "self" && "$2" = "__install-payload" ]]; then
  payload_root=""
  version_id=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --payload-root)
        payload_root="$2"
        shift 2
        ;;
      --version)
        version_id="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  install_root="$HAPPIER_HOME_DIR/cli"
  target_version_dir="$install_root/versions/$version_id"
  mkdir -p "$install_root/versions" "$HAPPIER_HOME_DIR/bin"
  if [[ -d "$install_root/current" ]]; then
    rm -rf "$install_root/previous"
    cp -R "$install_root/current" "$install_root/previous"
  fi
  rm -rf "$target_version_dir" "$install_root/current"
  copy_tree "$payload_root" "$target_version_dir"
  copy_tree "$payload_root" "$install_root/current"
  cp "$install_root/current/happier" "$HAPPIER_HOME_DIR/bin/happier"
  chmod +x "$HAPPIER_HOME_DIR/bin/happier"
  exit 0
fi
if [[ "$1" = "service" && "$2" = "install" ]]; then
  if [[ "\${HAPPIER_TEST_UNSUPPORTED_SERVICE_SURFACE:-0}" = "1" ]]; then
    echo "Usage: happier <command> [options]"
    exit 0
  fi
  if [[ -f "${logPath}.repair-ran" && " $* " != *" --yes "* ]]; then
    echo "conflict: service already installed" >&2
    exit 1
  fi
  echo "service install ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  exit 0
fi
if [[ ( "$1" = "service" || "$1" = "doctor" ) && "$2" = "repair" && "$3" = "--yes" ]]; then
  if [[ "\${HAPPIER_TEST_UNSUPPORTED_SERVICE_SURFACE:-0}" = "1" ]]; then
    echo "error: unknown option '--yes'" >&2
    exit 1
  fi
  if [[ "\${HAPPIER_TEST_SERVICE_REPAIR_FAIL:-0}" = "1" ]]; then
    echo "repair failed: root privileges are required" >&2
    exit 1
  fi
  : > "${logPath}.repair-ran"
  echo "$1 repair ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  exit 0
fi
if [[ ( "$1" = "service" || "$1" = "doctor" ) && "$2" = "repair" && "$3" = "--json" ]]; then
  if [[ "\${HAPPIER_TEST_LOG_SERVICE_PREFLIGHT:-0}" = "1" ]]; then
    echo "$1 repair-json ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  fi
  if [[ -n "\${HAPPIER_TEST_SERVICE_REPAIR_JSON:-}" ]]; then
    printf '%s' "\${HAPPIER_TEST_SERVICE_REPAIR_JSON}"
    exit 0
  fi
  echo "error: unknown option '--json'" >&2
  exit 1
fi
if [[ "$1" = "doctor" && "$2" = "repair" && "$3" = "--report-only" ]]; then
  if [[ "\${HAPPIER_TEST_UNSUPPORTED_DOCTOR_REPAIR_REPORT_ONLY:-0}" = "1" ]]; then
    echo "error: unknown option '--report-only'" >&2
    exit 1
  fi
  echo "doctor repair-report-only ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  if [[ -n "\${HAPPIER_TEST_DOCTOR_REPAIR_REPORT_ONLY_TEXT:-}" ]]; then
    printf '%s\n' "\${HAPPIER_TEST_DOCTOR_REPAIR_REPORT_ONLY_TEXT}"
  fi
  exit 0
fi
if [[ "$1" = "service" && "$2" = "list" && "$3" = "--json" ]]; then
  if [[ "\${HAPPIER_TEST_LOG_SERVICE_PREFLIGHT:-0}" = "1" ]]; then
    echo "service list-json ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  fi
  if [[ "\${HAPPIER_TEST_UNSUPPORTED_SERVICE_SURFACE:-0}" = "1" ]]; then
    echo "error: unknown option '--json'" >&2
    exit 1
  fi
  if [[ -n "\${HAPPIER_TEST_SERVICE_LIST_JSON:-}" ]]; then
    printf '%s' "\${HAPPIER_TEST_SERVICE_LIST_JSON}"
    exit 0
  fi
  echo '{"services":[]}'
  exit 0
fi
if [[ "$1" = "service" && "$2" = "list" ]]; then
  if [[ -n "\${HAPPIER_TEST_SERVICE_LIST_TEXT:-}" ]]; then
    printf '%s\n' "\${HAPPIER_TEST_SERVICE_LIST_TEXT}"
  fi
  exit 0
fi
if [[ "$1" = "service" && "$2" = "status" ]]; then
  if [[ "$3" = "--json" ]]; then
    if [[ "\${HAPPIER_TEST_LOG_SERVICE_PREFLIGHT:-0}" = "1" ]]; then
      echo "service status-json ${version} home=\${HAPPIER_HOME_DIR:-unset} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
    fi
    if [[ -n "\${HAPPIER_TEST_SERVICE_STATUS_JSON:-}" ]]; then
      printf '%s' "\${HAPPIER_TEST_SERVICE_STATUS_JSON}"
      exit 0
    fi
    echo '{"ok":true,"daemon":{"running":false,"pid":null},"owner":null}'
    exit 0
  fi
  if [[ -n "\${HAPPIER_TEST_SERVICE_STATUS_TEXT:-}" ]]; then
    printf '%s\n' "\${HAPPIER_TEST_SERVICE_STATUS_TEXT}"
  fi
  exit 0
fi
if [[ "$1" = "daemon" && "$2" = "service" && "$3" = "install" ]]; then
  echo "daemon service install ${version} channel=\${HAPPIER_DAEMON_SERVICE_CHANNEL:-unset} public=\${HAPPIER_PUBLIC_RELEASE_CHANNEL:-unset} strategy=\${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-unset}" >> "${logPath}"
  exit 0
fi
exit 0
`,
      'utf8',
    );
    await chmod(happierBin, 0o755);
    await writeFile(join(artifactDir, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(version)};\n`, 'utf8');

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

    artifacts.push({
      version,
      artifactStem,
      artifactName,
      tarPath,
      checksumsName,
      checksumsPath,
      sigName,
      sigPath,
    });
  }

  // Stub minisign so signature verification succeeds.
  const minisignStubPath = join(binDir, 'minisign');
  await writeFile(
    minisignStubPath,
    `#!/usr/bin/env bash
exit 0
`,
    'utf8',
  );
  await chmod(minisignStubPath, 0o755);

  // Stub curl: return release JSON (no -o), or copy fixture files to -o destinations.
  const curlStubPath = join(binDir, 'curl');
  const [artifactV123, artifactV124] = artifacts;
  assert.equal(artifactV123.version, '1.2.3');
  assert.equal(artifactV124.version, '1.2.4');
  const releaseJson = `{
  "name": "CLI Preview",
  "assets": [
    {
      "name": "${artifactV123.checksumsName}",
      "browser_download_url": "https://example.test/${artifactV123.checksumsName}"
    },
    {
      "name": "${artifactV123.sigName}",
      "browser_download_url": "https://example.test/${artifactV123.sigName}"
    },
    {
      "name": "${artifactV124.checksumsName}",
      "browser_download_url": "https://example.test/${artifactV124.checksumsName}"
    },
    {
      "name": "${artifactV124.sigName}",
      "browser_download_url": "https://example.test/${artifactV124.sigName}"
    },
    {
      "name": "${artifactV123.artifactName}",
      "browser_download_url": "https://example.test/${artifactV123.artifactName}"
    },
    {
      "name": "${artifactV124.artifactName}",
      "browser_download_url": "https://example.test/${artifactV124.artifactName}"
    }
  ]
}`;
  const expectedFailureMessage = options.expectedFailureMessage ?? null;

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
if [[ -n "\${HAPPIER_TEST_CURL_FAIL_ON_MATCH:-}" && "$url" == *"\${HAPPIER_TEST_CURL_FAIL_ON_MATCH}"* ]]; then
  echo "\${HAPPIER_TEST_CURL_FAIL_MESSAGE:-curl failed for $url}" >&2
  exit 17
fi
if [[ -n "\${HAPPIER_TEST_CURL_FAIL_ONCE_MATCH:-}" ]] && [[ "$url" == *"\${HAPPIER_TEST_CURL_FAIL_ONCE_MATCH}"* ]]; then
  marker="${root}/curl-fail-once.marker"
  if [[ ! -f "$marker" ]]; then
    : > "$marker"
    if [[ -n "\${HAPPIER_TEST_CURL_FAIL_ONCE_STDERR:-}" ]]; then
      printf '%s\\n' "\${HAPPIER_TEST_CURL_FAIL_ONCE_STDERR}" >&2
    fi
    exit "\${HAPPIER_TEST_CURL_FAIL_ONCE_EXIT_CODE:-56}"
  fi
fi
if [[ -n "$out" ]]; then
  case "$url" in
    *${artifactV123.artifactName}) cp ${JSON.stringify(artifactV123.tarPath)} "$out" ;;
    *${artifactV124.artifactName}) cp ${JSON.stringify(artifactV124.tarPath)} "$out" ;;
    *${artifactV123.checksumsName}) cp ${JSON.stringify(artifactV123.checksumsPath)} "$out" ;;
    *${artifactV124.checksumsName}) cp ${JSON.stringify(artifactV124.checksumsPath)} "$out" ;;
    *${artifactV123.sigName}) cp ${JSON.stringify(artifactV123.sigPath)} "$out" ;;
    *${artifactV124.sigName}) cp ${JSON.stringify(artifactV124.sigPath)} "$out" ;;
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
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_HOME_DIR: '',
    HAPPIER_SYSTEMD_USER_UNIT_DIR: systemdUserDir,
    HAPPIER_SYSTEMD_SYSTEM_UNIT_DIR: systemdSystemDir,
    HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY: 'replace-ring',
    HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
    HAPPIER_DAEMON_SERVICE_CHANNEL: '',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
    HAPPIER_TEST_LOG: logPath,
    ...installerEnvOverrides,
  };

  const res = spawnSync('bash', [installerPath, ...installerArgs], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  if (expectedFailureMessage) {
    assert.notEqual(res.status, 0, 'expected installer to fail');
    assert.match(
      `${stdout}\n${stderr}`,
      expectedFailureMessage,
      `installer failed for an unexpected reason:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
    );

    return {
      log: await readFile(logPath, 'utf8').catch(() => ''),
      stdout,
      stderr,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  assert.equal(res.status, 0, `installer failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const log = await readFile(logPath, 'utf8').catch(() => '');

  const versionRes = spawnSync(join(outBinDir, 'happier'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `installed binary failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), /1\.2\.4/);
  assert.equal(await readFile(join(installDir, 'cli', 'current', 'package-dist', 'index.mjs'), 'utf8'), 'export default "1.2.4";\n');
  assert.match(await readFile(join(installDir, 'cli', 'current', 'happier'), 'utf8'), /1\.2\.4/);

  return {
    log,
    stdout,
    stderr,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('install.sh skips daemon service installation by default in noninteractive mode', async () => {
  const scenario = await runInstallerScenario();
  try {
    assert.equal(scenario.log.trim(), '');
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh skips daemon service preflight when daemon setup is explicitly disabled', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '0',
    HAPPIER_TEST_LOG_SERVICE_PREFLIGHT: '1',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      schemaVersion: 2,
      ok: true,
      executed: false,
      existingServices: [
        { mode: 'user', targetMode: 'default-following', releaseChannel: 'stable' },
      ],
      actions: [
        { kind: 'remove-service', service: { mode: 'user', targetMode: 'default-following', releaseChannel: 'stable' } },
      ],
      manualWarnings: [],
    }),
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following', releaseChannel: 'stable' },
      ],
    }),
    HAPPIER_TEST_SERVICE_STATUS_JSON: JSON.stringify({
      ok: true,
      daemon: { running: true, pid: 42 },
      owner: null,
    }),
  });
  try {
    assert.equal(scenario.log.trim(), '');
    assert.doesNotMatch(scenario.stdout, /Background Service/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh prints download and extraction progress so large installs do not look stuck', async () => {
  const scenario = await runInstallerScenario();
  try {
    assert.match(scenario.stdout, /- \[\.\.\] Fetching cli-stable release metadata/);
    assert.match(scenario.stdout, /- \[✓\] Fetching cli-stable release metadata/);
    assert.match(scenario.stdout, /- \[\.\.\] Downloading release archive/);
    assert.match(scenario.stdout, /- \[✓\] Downloading release archive/);
    assert.match(scenario.stdout, /- \[\.\.\] Downloading checksums/);
    assert.match(scenario.stdout, /- \[✓\] Downloading minisign signature/);
    assert.match(scenario.stdout, /- \[\.\.\] Extracting payload/);
    assert.match(scenario.stdout, /- \[✓\] Extracting payload/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh retries transient minisign signature downloads before failing the install', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_TEST_CURL_FAIL_ONCE_MATCH: '.minisig',
    HAPPIER_TEST_CURL_FAIL_ONCE_STDERR: 'curl: (56) The requested URL returned error: 618',
    HAPPIER_TEST_CURL_FAIL_ONCE_EXIT_CODE: '56',
  });
  try {
    assert.match(scenario.stdout, /- \[\.\.\] Downloading minisign signature/);
    assert.match(scenario.stdout, /- \[✓\] Downloading minisign signature/);
    assert.match(scenario.stdout, /Signature verified\./);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh retries a transient rolling release metadata gap', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_TEST_CURL_FAIL_ONCE_MATCH: '/releases/tags/cli-stable',
    HAPPIER_TEST_CURL_FAIL_ONCE_STDERR: 'curl: (22) The requested URL returned error: 404',
    HAPPIER_TEST_CURL_FAIL_ONCE_EXIT_CODE: '22',
    HAPPIER_INSTALLER_DOWNLOAD_RETRY_DELAY_SECONDS: '0',
  });
  try {
    assert.match(scenario.stdout, /- \[✓\] Fetching cli-stable release metadata/);
    assert.match(scenario.stdout, /Signature verified\./);
  } finally {
    await scenario.cleanup();
  }
});

test('install.ps1 retries the transient rolling release 404 gap', async () => {
  const source = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');
  assert.match(source, /\$retryableStatusCodes = @\(404, 502, 503, 504\)/);
  assert.match(source, /Invoke-InstallerRestMethodWithRetry -Uri "https:\/\/api\.github\.com\/repos\/\$Repo\/releases\/tags\/\$tag"/);
});

test('install.sh does not render a shell-owned post-install summary when doctor repair --report-only yields no output', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_NONINTERACTIVE: '',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      ok: true,
      executed: false,
      existingServices: [
        {
          name: 'Default background service',
          serverId: 'default',
          mode: 'user',
          path: '/tmp/com.happier.cli.daemon.default.plist',
          targetMode: 'default-following',
          releaseChannel: 'stable',
        },
        {
          name: 'company',
          serverId: 'company',
          mode: 'user',
          path: '/tmp/com.happier.cli.daemon.env_9675c02.plist',
          targetMode: 'pinned',
          releaseChannel: 'stable',
        },
      ],
      daemonStatus: {
        daemon: {
          running: true,
          pid: 28768,
          startedWithCliVersion: '0.2.1-preview.1775503793.4227',
          startedWithPublicReleaseChannel: null,
          serviceManaged: false,
        },
      },
      relays: [
        {
          ring: 'dev',
          scope: 'user',
          relayUrl: 'http://127.0.0.1:4400',
          healthy: true,
          serviceActive: true,
          serviceEnabled: true,
        },
      ],
      actions: [],
      manualWarnings: [],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'Default background service (default, stable)\n  installed: /tmp/com.happier.cli.daemon.default.plist',
  });
  try {
    assert.match(scenario.log, /doctor repair-report-only 1\.2\.4 home=.*\/install/);
    assert.doesNotMatch(scenario.stdout, /Automatic Startup/);
    assert.doesNotMatch(scenario.stdout, /Installed background services:/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh uses doctor repair --report-only for the post-install summary when supported', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_NONINTERACTIVE: '',
    HAPPIER_TEST_DOCTOR_REPAIR_REPORT_ONLY_TEXT: [
      'Automatic startup:',
      '  - Report-only automatic startup summary',
      '',
      'Current daemon status:',
      '  - Running now: yes (pid 5555)',
      '',
      'Local relays:',
      '  - preview (user) -> http://127.0.0.1:4400',
    ].join('\n'),
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      ok: true,
      executed: false,
      existingServices: [
        { mode: 'user', targetMode: 'default-following', releaseChannel: 'stable' },
      ],
      daemonStatus: {
        daemon: {
          running: true,
          pid: 5555,
          startedWithCliVersion: '0.2.5-dev.7.1',
          startedWithPublicReleaseChannel: 'dev',
          serviceManaged: false,
        },
      },
      relays: [
        {
          ring: 'preview',
          scope: 'user',
          relayUrl: 'http://127.0.0.1:4400',
          healthy: true,
          serviceActive: true,
          serviceEnabled: true,
        },
      ],
      actions: [],
      manualWarnings: [],
    }),
  });
  try {
    assert.match(scenario.log, /doctor repair-report-only 1\.2\.4 home=.*\/install/);
    assert.match(scenario.stdout, /Report-only automatic startup summary/);
    assert.doesNotMatch(scenario.stdout, /Installed background services:/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh skips the post-install summary when doctor repair --report-only is unsupported', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_NONINTERACTIVE: '',
    HAPPIER_TEST_UNSUPPORTED_DOCTOR_REPAIR_REPORT_ONLY: '1',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      ok: true,
      executed: false,
      existingServices: [
        { mode: 'user', targetMode: 'default-following', releaseChannel: 'stable' },
      ],
      actions: [],
      manualWarnings: [],
    }),
  });
  try {
    assert.doesNotMatch(scenario.log, /doctor repair-report-only 1\.2\.4/);
    assert.doesNotMatch(scenario.stdout, /Automatic Startup/);
    assert.doesNotMatch(scenario.stdout, /Installed background services:/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh preserves non-TTY step summaries when a download step fails', async () => {
  const scenario = await runInstallerScenario(
    {
      HAPPIER_TEST_CURL_FAIL_ON_MATCH: 'checksums-happier-v1.2.4.txt',
      HAPPIER_TEST_CURL_FAIL_MESSAGE: 'simulated checksum download failure',
    },
    {
      expectedFailureMessage: /simulated checksum download failure/,
    },
  );
  try {
    assert.match(scenario.stdout, /- \[\.\.\] Downloading checksums/);
    assert.match(scenario.stdout, /- \[x\] Downloading checksums/);
    assert.match(scenario.stderr, /simulated checksum download failure/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh installs and enables daemon service when explicitly opted in (best-effort)', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      schemaVersion: 2,
      ok: true,
      executed: false,
      existingServices: [],
      actions: [
        { kind: 'install-default-following-service', releaseChannel: 'stable', mode: 'user' },
      ],
      manualWarnings: [],
    }, null, 2),
  });
  try {
    assert.equal(scenario.stderr.trim(), '');
    assert.match(scenario.log, /doctor repair 1\.2\.4 home=.*\/install channel=stable public=stable strategy=replace-ring/);
    assert.match(scenario.log, /service install 1\.2\.4 home=.*\/install channel=stable public=stable strategy=replace-ring/);
    assert.ok(
      scenario.log.indexOf('doctor repair 1.2.4') < scenario.log.indexOf('service install 1.2.4'),
      'expected background-service repair to run before install',
    );
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh silently skips automatic background-service setup when the installed CLI lacks the required service surface', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_UNSUPPORTED_SERVICE_SURFACE: '1',
  });
  try {
    assert.equal(scenario.log.trim(), '');
    assert.equal(scenario.stderr.trim(), '');
    assert.doesNotMatch(scenario.stdout, /Installing background service \(user-mode\)\.\.\./);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh fails closed and prints sudo repair guidance when noninteractive repair would need root', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following' },
        { mode: 'system', targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)\ndefault service (system)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service',
    HAPPIER_TEST_SERVICE_REPAIR_FAIL: '1',
  });
  try {
    assert.match(scenario.stderr, /system background services require sudo to repair or switch/i);
    assert.match(scenario.stderr, /sudo .*doctor repair --yes/);
    assert.doesNotMatch(scenario.stdout, /Installing background service \(user-mode\)\.\.\./);
    assert.equal(scenario.log.trim(), '');
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh ignores non-JSON repair preflight output and falls back to service list inventory', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following' },
        { mode: 'system', targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)\ndefault service (system)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: 'error: "existingServices": []',
  });
  try {
    assert.match(scenario.stderr, /system background services require sudo to repair or switch/i);
    assert.match(scenario.stderr, /sudo .*doctor repair --yes/);
    assert.equal(scenario.log.trim(), '');
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh does not attempt tty prompting for daemon opt-in when no controlling tty is available', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_NONINTERACTIVE: '',
  });
  try {
    assert.equal(scenario.log.trim(), '');
    assert.doesNotMatch(scenario.stderr, /\/dev\/tty/);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh keeps existing background services unchanged when no controlling tty is available', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_NONINTERACTIVE: '',
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service',
  });
  try {
    assert.equal(scenario.log.trim(), '');
    assert.doesNotMatch(scenario.stderr, /\/dev\/tty/);
    assert.match(scenario.stdout, /Keeping existing background services unchanged\./);
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh uses aggregated repair preflight JSON before attempting noninteractive repair', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      schemaVersion: 2,
      ok: true,
      executed: false,
      existingServices: [
        { mode: 'user', targetMode: 'default-following' },
        { mode: 'system', targetMode: 'default-following' },
      ],
      actions: [
        { kind: 'remove-service', service: { mode: 'system', targetMode: 'default-following' } },
      ],
      manualWarnings: [],
    }, null, 2),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service\nsystem duplicate exists',
    HAPPIER_TEST_SERVICE_REPAIR_FAIL: '1',
  });
  try {
    assert.match(scenario.stderr, /system background services require sudo to repair or switch/i);
    assert.match(scenario.stderr, /sudo .*doctor repair --yes/);
    assert.doesNotMatch(scenario.stderr, /background service install failed/i);
    assert.equal(scenario.log.trim(), '');
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh accepts doctor repair inventory by shape before attempting noninteractive repair', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      ok: true,
      executed: false,
      existingServices: [
        { mode: 'system', targetMode: 'default-following' },
      ],
      actions: [],
      manualWarnings: [],
    }),
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { mode: 'user', targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service',
  });
  try {
    assert.match(scenario.stderr, /system background services require sudo to repair or switch/i);
    assert.match(scenario.stderr, /sudo .*doctor repair --yes/);
    assert.equal(scenario.log.trim(), '');
  } finally {
    await scenario.cleanup();
  }
});

test('install.sh does not prompt for automatic-startup changes when the current default service already matches the selected release channel', async () => {
  const raw = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');

  assert.match(
    raw,
    /if \[\[ "\$\{NONINTERACTIVE\}" == "1" \]\]; then[\s\S]*fi[\s\S]*if \[\[ "\$\{has_existing_services\}" == "1" \]\] && background_service_inventory_has_matching_default_following "\$\{services_json\}"; then[\s\S]*echo "0"[\s\S]*return[\s\S]*fi[\s\S]*prompt_for_daemon_install_choice/,
  );
});

test('install.sh trusts CLI repair preflight over native Linux unit scans when service inventory is supported', async () => {
  const scenario = await runInstallerScenario({
    HAPPIER_WITH_DAEMON: '1',
    HAPPIER_TEST_SERVICE_REPAIR_JSON: JSON.stringify({
      schemaVersion: 2,
      ok: true,
      executed: false,
      existingServices: [
        { targetMode: 'default-following' },
      ],
      actions: [
        { kind: 'remove-service', service: { targetMode: 'default-following' } },
        { kind: 'install-default-following-service', releaseChannel: 'stable' },
      ],
      manualWarnings: [],
    }, null, 2),
    HAPPIER_TEST_SERVICE_LIST_JSON: JSON.stringify({
      entries: [
        { targetMode: 'default-following' },
      ],
    }),
    HAPPIER_TEST_SERVICE_LIST_TEXT: 'default service (user)',
    HAPPIER_TEST_SERVICE_STATUS_TEXT: 'current owner: background service',
    HAPPIER_TEST_NATIVE_SYSTEM_SERVICE_CONTENT: `[Unit]
Description=Happier CLI daemon (default)

[Service]
Environment=HAPPIER_DAEMON_SERVICE_LABEL=com.happier.cli.daemon.default
Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following
Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview
ExecStart=/usr/bin/node /tmp/happier daemon start-sync
`,
  });
  try {
    assert.doesNotMatch(scenario.stderr, /system background services require sudo to repair or switch/i);
    assert.doesNotMatch(scenario.stderr, /outside the installer CLI inventory/i);
    assert.match(scenario.log, /doctor repair 1\.2\.4 home=.*\/install channel=stable public=stable strategy=replace-ring/);
    assert.match(scenario.log, /service install 1\.2\.4 home=.*\/install channel=stable public=stable strategy=replace-ring/);
  } finally {
    await scenario.cleanup();
  }
});
