import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, stat, realpath, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

if (process.env.WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK === undefined) {
  // Unit tests run with stubbed limactl shell that can execute commands on the host; disable any
  // real TCP connectivity probes by default to keep the suite deterministic and fast.
  process.env.WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK = '0';
}

if (process.env.WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL === undefined) {
  process.env.WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL = '1';
}

const test = (name, options, fn) => {
  if (typeof options === 'function') {
    return nodeTest(name, { concurrency: false }, options);
  }
  return nodeTest(name, { concurrency: false, ...(options ?? {}) }, fn);
};

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function allocateFreeTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && typeof address.port === 'number', 'expected TCP server to expose a numeric port');
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function readPlaywrightMetaFromReportRoot(reportDir) {
  const summaryPath = join(reportDir, 'summary.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const candidatePaths = [
    summary?.logs?.playwrightMeta,
    join(reportDir, 'playwright', 'meta.json'),
    join(reportDir, 'playwright', 'attempt-01', 'meta.json'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidatePath of candidatePaths) {
    if (await fileExists(candidatePath)) {
      return JSON.parse(await readFile(candidatePath, 'utf8'));
    }
  }

  throw new Error(`expected Playwright meta.json in ${candidatePaths.join(', ') || reportDir}`);
}

test('wsrepl lima payload tar helper creates a portable archive with relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wsrepl-payload-tar-'));
  const payloadDir = join(root, 'payload');
  const tarPath = join(root, 'payload.tar');
  const helperPath = join(__dirname, 'create-wsrepl-payload-tar.py');
  await mkdir(join(payloadDir, 'nested'), { recursive: true });
  await writeFile(join(payloadDir, 'alpha.txt'), 'alpha\n', 'utf8');
  await writeFile(join(payloadDir, 'nested', 'beta.txt'), 'beta\n', 'utf8');

  const result = spawnSync('python3', [helperPath, payloadDir, tarPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `expected tar helper to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(await fileExists(tarPath), true, 'expected tar helper to create the output archive');

  const membersResult = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sys, tarfile',
        'with tarfile.open(sys.argv[1], "r") as archive:',
        '    print(json.dumps(sorted(member.name for member in archive.getmembers())))',
      ].join('\n'),
      tarPath,
    ],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(
    membersResult.status,
    0,
    `expected to inspect tar archive members\nstdout:\n${membersResult.stdout}\nstderr:\n${membersResult.stderr}`,
  );

  const memberNames = JSON.parse(membersResult.stdout.trim());
  assert.deepEqual(memberNames, ['.', './alpha.txt', './nested', './nested/beta.txt']);
});

function buildStopAwareDaemonScript(options = {}) {
  const stoppedMarker = String(options.stoppedMarker ?? '${HOME}/.host-daemon-stopped');
  const version = String(options.version ?? '0.1.0');
  const daemonLogPath = options.daemonLogPath ? String(options.daemonLogPath) : '';
  const statusLogPath = options.statusLogPath ? String(options.statusLogPath) : '';
  const startLogPath = options.startLogPath ? String(options.startLogPath) : '';
  const logsOutputPath = options.logsOutputPath ? String(options.logsOutputPath) : '';
  const startExtraLines = Array.isArray(options.startExtraLines) ? options.startExtraLines : [];
  const statusExtraLines = Array.isArray(options.statusExtraLines) ? options.statusExtraLines : [];
  const stopExtraLines = Array.isArray(options.stopExtraLines) ? options.stopExtraLines : [];
  const logsExtraLines = Array.isArray(options.logsExtraLines) ? options.logsExtraLines : [];
  const startSuccessLines = Array.isArray(options.startSuccessLines)
    ? options.startSuccessLines
    : ['echo "Daemon is running"', 'exit 0'];
  const statusRunningLines = Array.isArray(options.statusRunningLines)
    ? options.statusRunningLines
    : ['echo "Daemon is running"', 'exit 0'];
  const statusStoppedLines = Array.isArray(options.statusStoppedLines)
    ? options.statusStoppedLines
    : ['echo "Daemon is not running"', 'exit 0'];
  const stopShouldExit = options.stopShouldExit !== false;
  const statusShouldExit = options.statusShouldExit !== false;
  const startShouldExit = options.startShouldExit !== false;
  const logsShouldExit = options.logsShouldExit !== false;
  const daemonCommands = options.daemonCommands ?? ['start', 'stop', 'status', 'logs'];
  const includeDaemonControl = options.includeDaemonControl !== false;
  const includeVersion = options.includeVersion !== false;
  const includeCommandEcho = options.includeCommandEcho === true;
  const commandEchoPath = options.commandEchoPath ? String(options.commandEchoPath) : '';
  const commandEchoPrefix = options.commandEchoPrefix ? String(options.commandEchoPrefix) : '';

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
  ];

  if (includeCommandEcho && commandEchoPath) {
    lines.push(`echo "${commandEchoPrefix ? `${commandEchoPrefix} ` : ''}$*" >> ${JSON.stringify(commandEchoPath)}`);
  }

  if (includeDaemonControl) {
    lines.push(`stopped_marker=${JSON.stringify(stoppedMarker)}`);
    lines.push('if [[ "${1:-}" == "daemon" ]]; then');
    lines.push('  cmd="${2:-}"');
    lines.push('  case "$cmd" in');
    if (daemonCommands.includes('start')) {
      lines.push('    start|start-sync)');
      lines.push('      rm -f "$stopped_marker" >/dev/null 2>&1 || true');
      lines.push(...startExtraLines);
      lines.push(...startSuccessLines);
      if (startShouldExit) {
        lines.push('      exit 0');
      }
      lines.push('      ;;');
    }
    if (daemonCommands.includes('stop')) {
      lines.push('    stop)');
      lines.push('      printf "1" > "$stopped_marker"');
      lines.push(...stopExtraLines);
      if (stopShouldExit) {
        lines.push('      exit 0');
      }
      lines.push('      ;;');
    }
    if (daemonCommands.includes('status')) {
      lines.push('    status)');
      lines.push('      if [[ -f "$stopped_marker" ]]; then');
      lines.push(...statusStoppedLines);
      lines.push('      fi');
      lines.push(...statusExtraLines);
      lines.push(...statusRunningLines);
      if (statusShouldExit) {
        lines.push('      exit 0');
      }
      lines.push('      ;;');
    }
    if (daemonCommands.includes('logs')) {
      lines.push('    logs)');
      if (daemonLogPath) {
        lines.push(`      echo ${JSON.stringify(daemonLogPath)}`);
      } else if (logsOutputPath) {
        lines.push(`      echo ${JSON.stringify(logsOutputPath)}`);
      } else {
        lines.push('      echo "/tmp/daemon.log"');
      }
      lines.push(...logsExtraLines);
      if (logsShouldExit) {
        lines.push('      exit 0');
      }
      lines.push('      ;;');
    }
    lines.push('    *)');
    lines.push('      exit 0');
    lines.push('      ;;');
    lines.push('  esac');
    lines.push('fi');
  }

  if (includeVersion) {
    lines.push('if [[ "${1:-}" == "--version" ]]; then');
    lines.push(`  echo ${JSON.stringify(version)}`);
    lines.push('  exit 0');
    lines.push('fi');
  }

  return lines.join('\n') + '\n';
}

function buildPlaywrightHarnessNodeScript(options = {}) {
  const nodeLogPath = options.nodeLogPath ? String(options.nodeLogPath) : '';
  const daemonLogPath = options.daemonLogPath ? String(options.daemonLogPath) : '';
  const sessionId = String(options.sessionId ?? 'sess_created_1');
  const sessionPathExpr = String(options.sessionPathExpr ?? '${HAPPIER_QA_SESSION_PATH:-}');
  const createSessionId = options.createSessionId !== false;
  const includeDaemonControl = options.includeDaemonControl !== false;
  const daemonStatedPath = String(options.stoppedMarker ?? '${HOME}/.host-daemon-stopped');
  const daemonStatusMode = String(options.daemonStatusMode ?? 'plain');
  const daemonStatusCountPath = options.daemonStatusCountPath ? String(options.daemonStatusCountPath) : '';
  const daemonStatusMachineId = String(options.daemonStatusMachineId ?? 'machine_host_derived');
  const daemonStatusOutputPath = options.daemonStatusOutputPath ? String(options.daemonStatusOutputPath) : '';
  const daemonStartExtraLines = Array.isArray(options.daemonStartExtraLines) ? options.daemonStartExtraLines : [];
  const daemonStatusExtraLines = Array.isArray(options.daemonStatusExtraLines) ? options.daemonStatusExtraLines : [];
  const daemonStartShouldFail = options.daemonStartShouldFail === true;
  const daemonStartFailureMessage = String(options.daemonStartFailureMessage ?? 'Cannot find module \'/tmp/apps/cli/dist/index.mjs\'');
  const playwrightScriptLines = Array.isArray(options.playwrightScriptLines) ? options.playwrightScriptLines : [];
  const includeVmPayloadBuilder = options.includeVmPayloadBuilder === true;
  const vmPayloadHappierVersion = String(options.vmPayloadHappierVersion ?? '0.1.0');
  const passthroughMode = String(options.passthroughMode ?? 'echo');
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
  ];

  if (nodeLogPath) {
    lines.push(`echo "node $*" >> ${JSON.stringify(nodeLogPath)}`);
  }
  lines.push('if [[ "${1:-}" == "--version" ]]; then');
  lines.push('  echo "v99.0.0-test"');
  lines.push('  exit 0');
  lines.push('fi');

  if (includeVmPayloadBuilder) {
    lines.push('if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then');
    lines.push('  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"');
    lines.push('  if [[ -z "$payload" ]]; then');
    lines.push('    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2');
    lines.push('    exit 2');
    lines.push('  fi');
    lines.push('  mkdir -p "$payload"');
    lines.push('  cat > "$payload/happier" <<\'EOF\'');
    lines.push('  #!/usr/bin/env bash');
    lines.push('  set -euo pipefail');
    lines.push('  if [[ "${1:-}" == "--version" ]]; then echo ' + JSON.stringify(vmPayloadHappierVersion) + '; exit 0; fi');
    lines.push('  if [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]; then echo "unexpected daemon start-sync" >&2; exit 12; fi');
    lines.push('  if [[ "${1:-}" == "daemon" ]]; then exit 0; fi');
    lines.push('  exit 0');
    lines.push('EOF');
    lines.push('  chmod +x "$payload/happier"');
    lines.push('  exit 0');
    lines.push('fi');
  }

  if (includeDaemonControl) {
    lines.push('if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then');
    lines.push(`  stopped_marker=${JSON.stringify(daemonStatedPath)}`);
    lines.push('  sub="${3:-}"');
    lines.push('  case "$sub" in');
    lines.push('    stop)');
    lines.push('      printf "1" > "$stopped_marker"');
    lines.push('      exit 0');
    lines.push('      ;;');
    lines.push('    start|start-sync)');
    lines.push('      rm -f "$stopped_marker" >/dev/null 2>&1 || true');
    lines.push(...daemonStartExtraLines);
    if (daemonStartShouldFail) {
      lines.push(`      echo ${JSON.stringify(daemonStartFailureMessage)}`);
      lines.push('      exit 0');
    } else {
      lines.push('      echo "Daemon started successfully"');
      lines.push('      exit 0');
    }
    lines.push('      ;;');
    lines.push('    status)');
    lines.push('      if [[ -f "$stopped_marker" ]]; then');
    lines.push('        echo "Daemon is not running"');
    lines.push('        exit 0');
    lines.push('      fi');
    if (daemonStatusMode === 'doctor') {
      lines.push(`      count_file=${JSON.stringify(daemonStatusCountPath)}`);
      lines.push('      count="0"');
      lines.push('      if [[ -f "$count_file" ]]; then');
      lines.push('        count="$(cat "$count_file" 2>/dev/null || echo 0)"');
      lines.push('      fi');
      lines.push('      count="$((count + 1))"');
      lines.push('      printf "%s" "$count" > "$count_file"');
      lines.push('      echo "🤖 Daemon Status"');
      lines.push('      echo "✓ Daemon is running"');
      lines.push('      echo "📄 Daemon State:"');
      lines.push(`      if [[ "$count" -ge 2 ]]; then echo '{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":${JSON.stringify(daemonStatusMachineId)}}'; else echo '{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0"}'; fi`);
    } else {
      lines.push('      echo "Daemon is running"');
    }
    lines.push(...daemonStatusExtraLines);
    lines.push('      exit 0');
    lines.push('      ;;');
    lines.push('    logs)');
    lines.push(`      echo ${JSON.stringify(daemonLogPath || daemonStatusOutputPath || '/tmp/daemon.log')}`);
    lines.push('      exit 0');
    lines.push('      ;;');
    lines.push('  esac');
    lines.push('  exit 0');
    lines.push('fi');
  }

  lines.push('script="${1:-}"');
  lines.push('shift || true');
  lines.push('if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then');
  lines.push('  out="${HAPPIER_QA_OUTDIR:-}"');
  lines.push('  if [[ -z "$out" ]]; then');
  lines.push('    echo "missing HAPPIER_QA_OUTDIR" >&2');
  lines.push('    exit 2');
  lines.push('  fi');
  lines.push('  steps="${HAPPIER_QA_STEPS_JSON:-}"');
  lines.push('  if [[ -z "$steps" ]]; then');
  lines.push('    echo "missing HAPPIER_QA_STEPS_JSON" >&2');
  lines.push('    exit 3');
  lines.push('  fi');
  lines.push(`  sid="${sessionId}"`);
  lines.push('  if [[ "${HAPPIER_QA_TEST_STUB_OMIT_SESSION_ID:-0}" == "1" ]]; then sid=""; fi');
  if (playwrightScriptLines.length > 0) {
    lines.push(...playwrightScriptLines);
  } else {
    lines.push('  mkdir -p "$out/steps/step-01"');
    lines.push('  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"');
    lines.push(`  printf "%s\\n" "HAPPIER_QA_STACK_NAME=${'${HAPPIER_QA_STACK_NAME:-}'}" > "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "HAPPIER_QA_HEADLESS=${'${HAPPIER_QA_HEADLESS:-}'}" >> "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "EXPO_PUBLIC_HAPPY_STORAGE_SCOPE=${'${EXPO_PUBLIC_HAPPY_STORAGE_SCOPE:-}'}" >> "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "EXPO_PUBLIC_HAPPY_SERVER_CONTEXT=${'${EXPO_PUBLIC_HAPPY_SERVER_CONTEXT:-}'}" >> "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "EXPO_PUBLIC_HAPPIER_SERVER_URL=${'${EXPO_PUBLIC_HAPPIER_SERVER_URL:-}'}" >> "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "HAPPIER_QA_SESSION_PATH=${sessionPathExpr}" >> "$out/env.txt"`);
    lines.push(`  printf "%s\\n" "HAPPIER_QA_PREFERRED_AGENT_ENGINES=${'${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}'}" >> "$out/env.txt"`);
    lines.push('  python3 - "$out" "$steps" "${HAPPIER_QA_SESSION_PATH:-}" "$sid" <<\'PY\'');
    lines.push('import json');
    lines.push('import sys');
    lines.push('from pathlib import Path');
    lines.push('out_dir, steps, session_path, sid = sys.argv[1:]');
    lines.push('sid_value = sid.strip() or None');
    lines.push('payload = {');
    lines.push('  "kind": "stub",');
    lines.push('  "outDir": out_dir,');
    lines.push('  "sessionId": sid_value,');
    lines.push('  "sessionPath": session_path,');
    lines.push('  "stepsJson": steps,');
    lines.push('}');
    lines.push('Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")');
    lines.push('PY');
    lines.push('  echo "stub ok"');
  }
  lines.push('  exit 0');
  lines.push('fi');
  if (passthroughMode !== 'silent') {
    lines.push('echo "stub node passthrough"');
  }
  lines.push('exit 0');
  return lines.join('\n') + '\n';
}

async function writeScript(filePath, content) {
  await writeFile(filePath, content, 'utf8');
  await chmod(filePath, 0o755);
}

test('macos wsrepl lima matrix wrapper defaults Playwright to headless (supports --headed override)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const reportDirHeaded = join(root, 'reports-headed');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(reportDirHeaded, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s'), { recursive: true });
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const stdinLog = join(logDir, 'node.stdin.log');
  const happierLog = join(logDir, 'happier.log');
  const guestDaemonLog = join(logDir, 'guest-daemon.log');
  const hostDirectPeerPort = await allocateFreeTcpPort();

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  echo "start-env direct-peer-bind-port=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}" >> ' +
	        JSON.stringify(happierLog),
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      // Simulate a host daemon dying during the Playwright run: status checks should succeed
	      // during initial wrapper setup, then fail once while Playwright is running so the watchdog
	      // restarts the daemon.
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      `  running_marker=${JSON.stringify(join(homeDir, '.playwright-running'))}`,
	      `  failed_marker=${JSON.stringify(join(homeDir, '.daemon-status-failed-once'))}`,
	      '  if [[ -f "$running_marker" && ! -f "$failed_marker" ]]; then',
	      '    printf "1" > "$failed_marker"',
	      '    exit 1',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const runtimeHappierDir = join(
    homeDir,
    '.happier',
    'stacks',
    'stack-test',
    'runtime',
    'current',
    'cli',
  );
  await mkdir(runtimeHappierDir, { recursive: true });
  const runtimeHappierPath = join(runtimeHappierDir, 'happier');
  await writeFile(runtimeHappierPath, await readFile(happierPath, 'utf8'), 'utf8');
  await chmod(runtimeHappierPath, 0o755);

  await mkdir(join(homeDir, '.happier', 'bin'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'bin', 'happier'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "guest happier $*" >> ${JSON.stringify(guestDaemonLog)}`,
      `runtime_log=${JSON.stringify(join(logDir, 'guest-daemon-runtime.log'))}`,
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  printf \'%s\\n\' "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf \'%s\\n\' "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf \'%s\\n\' "HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES=${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf \'%s\\n\' "HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf \'%s\\n\' "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf \'%s\\n\' "START_ENV MAX_BYTES=${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-} BIND_PORT=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-} ADVERTISED_HOSTS=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-} FEATURE_ENABLED=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-} SERVER_ENABLED=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}" >> ' + JSON.stringify(guestDaemonLog),
      '  printf "%s\\n" "guest daemon started" > "$runtime_log"',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "$runtime_log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(join(homeDir, '.happier', 'bin', 'happier'), 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
	      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
	      '  stopped_marker="${HOME}/.host-daemon-stopped"',
	      '  sub="${3:-}"',
	      '  case "$sub" in',
	      '    stop)',
	      '      printf "1" > "$stopped_marker"',
	      '      exit 0',
	      '      ;;',
	      '    start|start-sync)',
	      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '      echo "Daemon started successfully"',
	      '      exit 0',
	      '      ;;',
	      '    status)',
	      '      if [[ -f "$stopped_marker" ]]; then',
	      '        echo "Daemon is not running"',
	      '        exit 0',
	      '      fi',
	      '      echo "Daemon is running"',
	      '      exit 0',
	      '      ;;',
	      '    logs)',
	      '      log_path="${HOME}/daemon.log"',
	      '      printf "%s\\n" "stub daemon log" > "$log_path"',
	      '      echo "$log_path"',
	      '      exit 0',
	      '      ;;',
	      '  esac',
	      '  exit 0',
	      'fi',
	      'script="${1:-}"',
	      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  if [[ "${HAPPIER_QA_TEST_STUB_OMIT_SESSION_ID:-0}" == "1" ]]; then',
      '    sid=""',
      '  else',
      '    sid="sess_created_1"',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "HAPPIER_QA_STACK_NAME=${HAPPIER_QA_STACK_NAME:-}" > "$out/env.txt"',
      '  printf "%s\\n" "HAPPIER_QA_HEADLESS=${HAPPIER_QA_HEADLESS:-}" >> "$out/env.txt"',
      '  printf "%s\\n" "EXPO_PUBLIC_HAPPY_STORAGE_SCOPE=${EXPO_PUBLIC_HAPPY_STORAGE_SCOPE:-}" >> "$out/env.txt"',
      '  printf "%s\\n" "EXPO_PUBLIC_HAPPY_SERVER_CONTEXT=${EXPO_PUBLIC_HAPPY_SERVER_CONTEXT:-}" >> "$out/env.txt"',
      '  printf "%s\\n" "EXPO_PUBLIC_HAPPIER_SERVER_URL=${EXPO_PUBLIC_HAPPIER_SERVER_URL:-}" >> "$out/env.txt"',
      '  printf "%s\\n" "HAPPIER_QA_SESSION_PATH=${HAPPIER_QA_SESSION_PATH:-}" >> "$out/env.txt"',
      '  printf "%s\\n" "HAPPIER_QA_PREFERRED_AGENT_ENGINES=${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}" >> "$out/env.txt"',
      '  python3 - "$out" "$steps" "${HAPPIER_QA_SESSION_PATH:-}" "$sid" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, steps, session_path, sid = sys.argv[1:]',
      'sid_value = sid.strip() or None',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": sid_value,',
      '  "sessionPath": session_path,',
      '  "stepsJson": steps,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      `  printf "1" > ${JSON.stringify(join(homeDir, '.playwright-running'))}`,
      '  # Give the wrapper background watchdog time to run at least once.',
      '  sleep 1',
      '  echo "stub ok"',
      '  exit 0',
'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == --name=* ]]; then',
      '        name="${1#--name=}"',
      '        shift',
      '        continue',
      '      fi',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    if [[ -z "$name" ]]; then',
      '      name="happy-wsrepl"',
      '    fi',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATUS"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "info: $*"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      "    # Run guest commands in a minimal PATH so they don't accidentally pick up the host's stub happier binary.",
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(
    lsofPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(lsofPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(
    ncPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(ncPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    // Ensure the runner forces headless-by-default even if the caller has an ambient override.
    HAPPIER_QA_HEADLESS: '0',
    HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: '4096',
    HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: '',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: '',
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL: '',
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT: '48888',
    WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
    WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT: String(hostDirectPeerPort),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'ensure-vm.log')), true);
  assert.equal(await fileExists(join(reportDir, 'host.diag.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'guest.diag.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'lima.list.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'lima.info.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'vm.host-direct-peer.tcp.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.daemon.start.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.daemon.status.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.daemon.log.path.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.daemon.log.tail.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'guest.daemon.start.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'guest.daemon.status.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'guest.daemon.log.path.txt')), true);
  assert.equal(await fileExists(join(reportDir, 'daemon', 'guest.daemon.log.tail.txt')), true);

  const playwrightDir = join(reportDir, 'playwright', 'attempt-01');
  assert.equal(await fileExists(join(playwrightDir, 'runner.log')), true);
  assert.equal(await fileExists(join(playwrightDir, 'meta.json')), true, 'expected Playwright harness meta.json under report root');
  assert.equal(await fileExists(join(playwrightDir, 'env.txt')), true, 'expected wrapper to pass env hints to Playwright runner');

  const expectedSessionPath = join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s');
  const runnerEnv = await readFile(join(playwrightDir, 'env.txt'), 'utf8');
  assert.match(runnerEnv, /HAPPIER_QA_STACK_NAME=stack-test/);
  assert.match(runnerEnv, /HAPPIER_QA_HEADLESS=1/);
  assert.match(runnerEnv, /EXPO_PUBLIC_HAPPY_STORAGE_SCOPE=stack-test/);
  assert.match(runnerEnv, /EXPO_PUBLIC_HAPPY_SERVER_CONTEXT=stack/);
  assert.ok(
    runnerEnv.includes('EXPO_PUBLIC_HAPPIER_SERVER_URL=http://localhost:53288'),
    `expected runner env to include EXPO_PUBLIC_HAPPIER_SERVER_URL (got: ${runnerEnv})`,
  );
  assert.ok(
    runnerEnv.includes(`HAPPIER_QA_SESSION_PATH=${expectedSessionPath}`),
    `expected runner env to include default HAPPIER_QA_SESSION_PATH (got: ${runnerEnv})`,
  );
  assert.ok(
    runnerEnv.includes('HAPPIER_QA_PREFERRED_AGENT_ENGINES=claude'),
    `expected runner env to include default HAPPIER_QA_PREFERRED_AGENT_ENGINES=claude (got: ${runnerEnv})`,
  );

  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 0);
  assert.equal(await realpath(summary.playwrightOutDir), await realpath(playwrightDir));
  assert.equal(summary.sessionId, 'sess_created_1');
  assert.equal(summary.sessionPath, expectedSessionPath);
  assert.equal(summary.parameters.hostMachineId, 'machine_host_1');
  assert.equal(summary.parameters.vmMachineId, 'machine_vm_1');
  assert.equal(summary.parameters.sourceMachineId, 'machine_host_1');
  assert.deepEqual(summary.parameters.targetMachineIds, ['machine_target_1']);

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl list --all-fields --json happy-wsrepl/);
  assert.match(limactlOut, /limactl list/);

  const limaYaml = await readFile(join(limaHome, 'happy-wsrepl', 'lima.yaml'), 'utf8');
  assert.match(limaYaml, /guestPortRange: \[48888, 48888\]/);

  const guestDaemonOut = await readFile(guestDaemonLog, 'utf8');
  assert.match(guestDaemonOut, /guest happier daemon start/);
  assert.match(guestDaemonOut, /HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES=4096/);
  assert.match(guestDaemonOut, /HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=48888/);
  assert.match(guestDaemonOut, /HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS=127.0.0.1/);
  assert.match(
    guestDaemonOut,
    /START_ENV MAX_BYTES=4096 BIND_PORT=48888 ADVERTISED_HOSTS=127\.0\.0\.1 FEATURE_ENABLED=true SERVER_ENABLED=true/,
  );

  const nodeOut = await readFile(nodeLog, 'utf8');
  assert.match(nodeOut, /playwright-session-handoff-wsrepl-matrix\.mjs/);

  const happierOut = await readFile(happierLog, 'utf8').catch(() => '');
  if (happierOut) {
    assert.match(happierOut, /install provider claude/);
    assert.match(happierOut, /^happier daemon start$/m, `expected wrapper to start the host daemon\n${happierOut}`);
    assert.match(happierOut, new RegExp(`start-env direct-peer-bind-port=${hostDirectPeerPort}`));
  }

  const entries = await readdir(join(playwrightDir, 'steps'));
  assert.deepEqual(entries, ['step-01']);

  const resHeaded = spawnSync('bash', [scriptPath, '--headed', 'happy-wsrepl'], {
    cwd: root,
    env: {
      ...env,
      WSREPL_QA_OUTPUT_DIR: reportDirHeaded,
    },
    encoding: 'utf8',
  });

  assert.equal(
    resHeaded.status,
    0,
    `expected exit 0 for --headed run\nstdout:\n${resHeaded.stdout}\nstderr:\n${resHeaded.stderr}`,
  );

  const headedPlaywrightDir = join(reportDirHeaded, 'playwright', 'attempt-01');
  const headedRunnerEnv = await readFile(join(headedPlaywrightDir, 'env.txt'), 'utf8');
  assert.match(headedRunnerEnv, /HAPPIER_QA_HEADLESS=0/);

  // If the Playwright harness writes a fully green summary but exits nonzero (cleanup/interrupt noise),
  // the wrapper should still treat the run as successful and produce summary.json.status=0.
  const reportDirNonZeroOk = join(root, 'reports-nonzero-ok');
  await mkdir(reportDirNonZeroOk, { recursive: true });

  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      log_path="${HOME}/daemon.log"',
      '      printf "%s\\n" "stub daemon log" > "$log_path"',
      '      echo "$log_path"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  sid="sess_created_1"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"wsrepl_handoff_matrix_summary\\",\\"ok\\":true,\\"sessionId\\":\\"sess_created_1\\",\\"steps\\":[{\\"stepId\\":\\"step-01\\",\\"ok\\":true}]}" > "$out/summary.json"',
      '  python3 - "$out" "$steps" "${HAPPIER_QA_SESSION_PATH:-}" "$sid" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, steps, session_path, sid = sys.argv[1:]',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": sid.strip() or None,',
      '  "sessionPath": session_path,',
      '  "stepsJson": steps,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      '  echo "stub ok but exiting nonzero"',
      '  exit 2',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const resNonZeroOk = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env: {
      ...env,
      WSREPL_QA_OUTPUT_DIR: reportDirNonZeroOk,
    },
    encoding: 'utf8',
  });

  assert.equal(
    resNonZeroOk.status,
    0,
    `expected exit 0 for nonzero Playwright exit + ok summary\nstdout:\n${resNonZeroOk.stdout}\nstderr:\n${resNonZeroOk.stderr}`,
  );

  const summaryNonZeroOk = JSON.parse(await readFile(join(reportDirNonZeroOk, 'summary.json'), 'utf8'));
  assert.equal(summaryNonZeroOk.status, 0);
  assert.equal(summaryNonZeroOk.sessionId, 'sess_created_1');
});

test('macos wsrepl lima matrix wrapper fails closed when host daemon does not stop before restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-stop-fail-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s'), { recursive: true });
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );

  const happierLog = join(logDir, 'happier.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  // Host happier stub that *never* reports not-running, even after stop.
  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  // Minimal guest happier + tooling stubs so the wrapper reaches host daemon restart.
  await mkdir(join(homeDir, '.happier', 'bin'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'bin', 'happier'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo "Daemon is running"', 'exit 0'].join('\n') + '\n',
    'utf8',
  );
  await chmod(join(homeDir, '.happier', 'bin', 'happier'), 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0'].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'sub="${1:-}"',
      'shift || true',
      'case "$sub" in',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  start|stop|list)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: '',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_DAEMON_STOP_POLL_RETRIES: '2',
    WSREPL_QA_HOST_DAEMON_STOP_POLL_DELAY_MS: '10',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected nonzero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected wrapper summary.json even on failure');
  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.failureStage, 'host_daemon');
  assert.equal(summary.failureReason, 'host_daemon_stop_failed');
});

	test('macos wsrepl lima matrix wrapper defaults guest direct-peer bind port + advertised hosts when unset', async () => {
	  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-default-vm-direct-peer-'));
	  const binDir = join(root, 'bin');
	  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s'), { recursive: true });
  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );

  const limactlLog = join(logDir, 'limactl.log');
  const guestDaemonLog = join(logDir, 'guest-daemon.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

	  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  await mkdir(join(homeDir, '.happier', 'bin'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'bin', 'happier'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "guest happier $*" >> ${JSON.stringify(guestDaemonLog)}`,
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  printf \'%s\\n\' "START_ENV BIND_PORT=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-} ADVERTISED_HOSTS=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-} FEATURE_ENABLED=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-} SERVER_ENABLED=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}" >> ' +
        JSON.stringify(guestDaemonLog),
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(join(homeDir, '.happier', 'bin', 'happier'), 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\\":\\"[]\\"}" > "$out/meta.json"',
      '  mkdir -p "$out/steps/step-01"',
      '  echo "stub ok" > "$out/runner.log"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  start|stop|list|copy|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: '',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: '',
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT_DEFAULT: '13377',
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const limaYaml = await readFile(join(limaHome, 'happy-wsrepl', 'lima.yaml'), 'utf8');
  assert.match(limaYaml, /guestPortRange: \[13377, 13377\]/);

  const guestDaemonOut = await readFile(guestDaemonLog, 'utf8');
	assert.match(
	  guestDaemonOut,
	  /START_ENV BIND_PORT=13377 ADVERTISED_HOSTS=127\.0\.0\.1 FEATURE_ENABLED=true SERVER_ENABLED=true/,
	);
});

test('macos wsrepl lima matrix wrapper configures unique guest direct-peer ports and dual advertised hosts when multiple VMs are active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-multi-vm-direct-peer-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');
  const primaryVm = 'happy-wsrepl';
  const extraVm = 'happy-wsrepl-2';

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s'), { recursive: true });
  await mkdir(join(limaHome, primaryVm), { recursive: true });
  await mkdir(join(limaHome, extraVm), { recursive: true });
  await writeFile(
    join(limaHome, primaryVm, 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    join(limaHome, extraVm, 'lima.yaml'),
    ['memory: \"4GiB\"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );

  const limactlLog = join(logDir, 'limactl.log');
  const guestDaemonLogDir = join(logDir, 'guest-daemon');
  const hostDirectPeerPort = await allocateFreeTcpPort();
  await mkdir(guestDaemonLogDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  await mkdir(join(homeDir, '.happier', 'bin'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'bin', 'happier'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `log_dir=${JSON.stringify(guestDaemonLogDir)}`,
      'instance="${LIMA_INSTANCE:-unknown}"',
      'safe_instance="${instance//[^A-Za-z0-9._-]/_}"',
      'log_path="${log_dir}/${safe_instance}.log"',
      'echo "guest happier ${instance} $*" >> "$log_path"',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  printf \'%s\\n\' "START_ENV BIND_PORT=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-} ADVERTISED_HOSTS=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-} FEATURE_ENABLED=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-} SERVER_ENABLED=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}" >> "$log_path"',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(join(homeDir, '.happier', 'bin', 'happier'), 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\\":\\"[]\\"}" > "$out/meta.json"',
      '  mkdir -p "$out/steps/step-01"',
      '  echo "stub ok" > "$out/runner.log"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  start|stop|list|copy|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    instance="${1:-}"',
      '    shift || true',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin LIMA_INSTANCE="$instance" "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: '',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: '',
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT_DEFAULT: '13377',
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT: String(hostDirectPeerPort),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, primaryVm, extraVm], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\\nstdout:\\n${res.stdout}\\nstderr:\\n${res.stderr}`);

  const primaryYaml = await readFile(join(limaHome, primaryVm, 'lima.yaml'), 'utf8');
  const extraYaml = await readFile(join(limaHome, extraVm, 'lima.yaml'), 'utf8');
  assert.match(primaryYaml, /guestPortRange: \[13377, 13377\]/);
  assert.match(extraYaml, /guestPortRange: \[13378, 13378\]/);

  const primaryGuestOut = await readFile(join(guestDaemonLogDir, `${primaryVm}.log`), 'utf8');
  const extraGuestOut = await readFile(join(guestDaemonLogDir, `${extraVm}.log`), 'utf8');
  assert.match(
    primaryGuestOut,
    /START_ENV BIND_PORT=13377 ADVERTISED_HOSTS=127\.0\.0\.1,host\.lima\.internal FEATURE_ENABLED=true SERVER_ENABLED=true/,
  );
  assert.match(
    extraGuestOut,
    /START_ENV BIND_PORT=13378 ADVERTISED_HOSTS=127\.0\.0\.1,host\.lima\.internal FEATURE_ENABLED=true SERVER_ENABLED=true/,
  );
});

test('macos wsrepl lima matrix wrapper fails closed when Playwright does not produce a sessionId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-missing-sessionid-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

	  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const runtimeHappierDir = join(
    homeDir,
    '.happier',
    'stacks',
    'stack-test',
    'runtime',
    'current',
    'cli',
  );
  await mkdir(runtimeHappierDir, { recursive: true });
  const runtimeHappierPath = join(runtimeHappierDir, 'happier');
  await writeFile(
    runtimeHappierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "🤖 Daemon Status"',
      '  echo "✓ Daemon is running"',
      '  echo "📄 Daemon State:"',
      '  echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":"machine_host_derived"}\'',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo ""',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(runtimeHappierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      // Intentionally omit sessionId in meta.json.
      '  python3 - "$out" "${HAPPIER_QA_SESSION_PATH:-}" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, session_path = sys.argv[1:]',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": None,',
      '  "sessionPath": session_path,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 1, `expected exit 1 when sessionId is missing\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 1);
  assert.equal(summary.failureStage, 'playwright');
  assert.equal(summary.failureReason, 'missing_session_id');
  assert.equal(summary.sessionId, null);
});

test('macos wsrepl lima matrix wrapper normalizes nonzero Playwright runner exit when playwright summary ok is true', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-nonzero-runner-ok-summary-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const runtimeHappierDir = join(
    homeDir,
    '.happier',
    'stacks',
    'stack-test',
    'runtime',
    'current',
    'cli',
  );
  await mkdir(runtimeHappierDir, { recursive: true });
  const runtimeHappierPath = join(runtimeHappierDir, 'happier');
  await writeFile(runtimeHappierPath, await readFile(happierPath, 'utf8'), 'utf8');
  await chmod(runtimeHappierPath, 0o755);

  await mkdir(join(homeDir, '.happier', 'bin'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'bin', 'happier'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(join(homeDir, '.happier', 'bin', 'happier'), 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  python3 - "$out" "${HAPPIER_QA_SESSION_PATH:-}" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, session_path = sys.argv[1:]',
      'Path(out_dir, \"meta.json\").write_text(json.dumps({',
      '  \"kind\": \"stub\",',
      '  \"outDir\": out_dir,',
      '  \"sessionId\": \"sess_created_1\",',
      '  \"sessionPath\": session_path,',
      '}, indent=2) + \"\\n\", encoding=\"utf-8\")',
      'Path(out_dir, \"summary.json\").write_text(json.dumps({',
      '  \"kind\": \"wsrepl_handoff_matrix_summary\",',
      '  \"ok\": True,',
      '  \"sessionId\": \"sess_created_1\",',
      '}, indent=2) + \"\\n\", encoding=\"utf-8\")',
      'PY',
      '  # Simulate an unexpected nonzero process exit even though the harness wrote a green summary.',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  await mkdir(join(limaHome, 'happy-wsrepl'), { recursive: true });
  await writeFile(
    join(limaHome, 'happy-wsrepl', 'lima.yaml'),
    ['memory: "4GiB"', '# --- happier port forwards (managed) ---'].join('\n') + '\n',
    'utf8',
  );

  await mkdir(join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s'), { recursive: true });

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(
    res.status,
    0,
    `expected exit 0 when playwright summary is ok, even if the runner exits nonzero\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 0);
  assert.equal(summary.failureStage, null);
  assert.equal(summary.failureReason, null);
  assert.equal(summary.sessionId, 'sess_created_1');
});

test('macos wsrepl lima matrix wrapper defaults host happier source to stack runtime when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-default-stack-runtime-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');
  const limactlLog = join(logDir, 'limactl.log');
  const runtimeCliLog = join(logDir, 'stack-runtime-cli.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  echo "unexpected worktree_node host happier invocation" >&2',
      '  exit 12',
      'fi',
      // The wrapper invokes the Playwright harness via `node <repo>/.project/scripts/...`.
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  session_id="${HAPPIER_QA_SESSION_ID:-sess_default_source_1}"',
      '  session_path="${HAPPIER_QA_SESSION_PATH:-}"',
      '  python3 - "$out" "$session_id" "$session_path" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, session_id, session_path = sys.argv[1:]',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": session_id,',
      '  "sessionPath": session_path,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(lsofPath, ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n', 'utf8');
  await chmod(lsofPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(ncPath, ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n', 'utf8');
  await chmod(ncPath, 0o755);

  const guestHappierPath = join(homeDir, '.happier', 'bin', 'happier');
  await mkdir(join(guestHappierPath, '..'), { recursive: true });
  await writeFile(
    guestHappierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" ]]; then',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(guestHappierPath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH="$HOME/.happier/bin:/usr/bin:/bin" "$@"',
      '    ;;',
      '  copy)',
      '    # No-op copy in this test (guest autoupdate is skipped).',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const stackName = 'stack-default-host-source';
  const runtimeCliPath = join(homeDir, '.happier', 'stacks', stackName, 'runtime', 'current', 'cli', 'happier');
  await mkdir(join(runtimeCliPath, '..'), { recursive: true });
  await writeFile(
    runtimeCliPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "stack-runtime-cli $*" >> ${JSON.stringify(runtimeCliLog)}`,
      'stopped_marker="$HOME/.stack-runtime-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" ]]; then',
      '  sub="${2:-}"',
      '  case "$sub" in',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      exit 0',
      '      ;;',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(runtimeCliPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_SESSION_ID: 'sess_default_source_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK: '0',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const resolved = JSON.parse(await readFile(join(reportDir, 'daemon', 'host.happier.resolve.json'), 'utf8'));
  assert.equal(resolved.hostHappierKind, 'stack_runtime');
});

test('macos wsrepl lima matrix watchdog probes daemon status using stack-scoped cli home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-watchdog-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const stdinLog = join(logDir, 'node.stdin.log');
  const happierLog = join(logDir, 'happier.log');

  const stackCliRoot = join(homeDir, 'stackCli');
  const stackServerId = 'stack_wsrepl-test__id_default';
  const accessKeyPath = join(stackCliRoot, 'servers', stackServerId, 'access.key');
  await mkdir(join(stackCliRoot, 'servers', stackServerId), { recursive: true });
  await writeFile(accessKeyPath, 'test-access-key', 'utf8');
  await chmod(accessKeyPath, 0o600);

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      // When the daemon is managed under a stack-scoped HAPPIER_HOME_DIR, status probes must
	      // use that same home and active server id. Otherwise the watchdog will see "not running"
	      // and restart the daemon continuously, corrupting matrix results.
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      `  expected_home=${JSON.stringify(stackCliRoot)}`,
	      `  expected_id=${JSON.stringify(stackServerId)}`,
	      '  if [[ "${HAPPIER_HOME_DIR:-}" == "$expected_home" && "${HAPPIER_ACTIVE_SERVER_ID:-}" == "$expected_id" ]]; then',
	      '    echo "Daemon is running"',
	      '    exit 0',
      '  fi',
      '  echo "Daemon is not running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(
    lsofPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(lsofPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(
    ncPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(ncPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
	      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
	      '  stopped_marker="${HOME}/.host-daemon-stopped"',
	      '  sub="${3:-}"',
	      '  case "$sub" in',
	      '    stop)',
	      '      printf "1" > "$stopped_marker"',
	      '      exit 0',
	      '      ;;',
	      '    start|start-sync)',
	      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '      echo "Daemon started successfully"',
	      '      exit 0',
	      '      ;;',
	      '    status)',
	      '      if [[ -f "$stopped_marker" ]]; then',
	      '        echo "Daemon is not running"',
	      '        exit 0',
	      '      fi',
	      '      echo "Daemon is running"',
	      '      exit 0',
	      '      ;;',
	      '    logs)',
	      '      log_path="${HOME}/daemon.log"',
	      '      printf "%s\\n" "stub daemon log" > "$log_path"',
	      '      echo "$log_path"',
	      '      exit 0',
	      '      ;;',
	      '  esac',
	      '  exit 0',
	      'fi',
	      'script="${1:-}"',
	      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "stub ok" > "$out/runner.log"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\")}" > "$out/meta.json"',
      `  printf "1" > ${JSON.stringify(join(homeDir, '.playwright-running'))}`,
      '  # Give the wrapper background watchdog time to probe the daemon at least once.',
      '  sleep 0.25',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATUS"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "info: $*"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_ACCESS_KEY_PATH: accessKeyPath,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const watchdogPath = join(reportDir, 'playwright', 'attempt-01', 'host-daemon-watchdog.log');
  assert.equal(await fileExists(watchdogPath), false, 'expected watchdog to avoid restarting daemon when stack-scoped status checks succeed');
});

test('macos wsrepl lima matrix watchdog ignores transient "Daemon is not running" while Playwright boots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-watchdog-transient-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      // Simulate the common "daemon is restarting" race: status returns exit 0 but prints
	      // "Daemon is not running" once while Playwright is booting. The watchdog should not
	      // restart on a single transient probe.
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      `  running_marker=${JSON.stringify(join(homeDir, '.playwright-running'))}`,
	      `  once_marker=${JSON.stringify(join(homeDir, '.daemon-not-running-once'))}`,
	      '  if [[ -f "$running_marker" && ! -f "$once_marker" ]]; then',
	      '    printf "1" > "$once_marker"',
	      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  cmd="${2:-}"',
      '  sub="${3:-}"',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  if [[ "$cmd" == "--version" ]]; then',
      '    echo "0.1.0"',
      '    exit 0',
      '  fi',
      '  if [[ "$cmd" == "install" ]]; then',
      '    exit 0',
      '  fi',
      '  if [[ "$cmd" == "daemon" ]]; then',
      '    case "$sub" in',
      '      stop)',
      '        printf "1" > "$stopped_marker"',
      '        exit 0',
      '        ;;',
      '      start|start-sync)',
      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '        echo "Daemon started successfully"',
      '        exit 0',
      '        ;;',
      '      status)',
      '        if [[ -f "$stopped_marker" ]]; then',
      '          echo "Daemon is not running"',
      '          exit 0',
      '        fi',
      '        echo "Waiting for credentials"',
      '        exit 1',
      '        ;;',
      '      logs)',
      '        log_path="${HOME}/daemon.log"',
      '        printf "%s\\n" "stub daemon log" > "$log_path"',
      '        echo "$log_path"',
      '        exit 0',
      '        ;;',
      '    esac',
      '  fi',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\")}" > "$out/meta.json"',
      `  printf "1" > ${JSON.stringify(join(homeDir, '.playwright-running'))}`,
      '  sleep 0.25',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    echo "ok"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const watchdogPath = join(reportDir, 'playwright', 'attempt-01', 'host-daemon-watchdog.log');
  assert.equal(await fileExists(watchdogPath), false, 'expected watchdog to ignore a single transient "Daemon is not running" probe');
});

test('macos wsrepl lima matrix wrapper fails closed when Playwright harness writes fatal.json but exits 0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-fatal-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

	  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'echo "Daemon is running"',
	      'exit 0',
	    ].join('\n') + '\n',
	    'utf8',
	  );
	  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$out/steps"',
      '  printf "%s\\n" "{\\"ok\\":false,\\"error\\":\\"stub fatal\\"}" > "$out/fatal.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"ok\\":false,\\"fatalError\\":\\"stub fatal\\",\\"outDir\\":\\"$out\\",\\"steps\\":[]}" > "$out/meta.json"',
      '  echo "stub fatal (but exit 0)"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summaryPath = join(reportDir, 'summary.json');
  assert.equal(await fileExists(summaryPath), true, 'expected wrapper summary.json even on failure');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.equal(summary.status, 1);
  assert.equal(summary.failureStage, 'playwright');
  assert.equal(summary.failureReason, 'playwright_fatal_json');
});

test('macos wsrepl lima matrix wrapper fails closed when Playwright runner does not write meta.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-no-meta-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const curlPath = join(binDir, 'curl');
  await writeFile(
    curlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'for arg in "$@"; do',
      '  if [[ "$arg" == *"/v1/features"* ]]; then',
      '    echo \'{"capabilities":{"machines":{"transfer":{"serverRouted":{"maxBytes":4096}}}}}\'',
      '    exit 0',
      '  fi',
      'done',
      'echo "unexpected curl args: $*" >&2',
      'exit 2',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(curlPath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo ""',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "stub ok (no meta)" > "$out/runner.log"',
      '  # Intentionally do NOT write $out/meta.json. This must fail closed in the wrapper.',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATUS"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "info: $*"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');
  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.notEqual(summary.status, 0, 'expected summary status to be non-zero when meta.json is missing');
  assert.equal(summary.failureStage, 'playwright');
  assert.ok(
    typeof summary.failureReason === 'string' && summary.failureReason.length > 0,
    `expected failureReason to be set (got: ${JSON.stringify(summary.failureReason)})`,
  );
});

test('macos wsrepl lima matrix wrapper can derive host server url from stack.runtime.json when UI url does not include a server param', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-derive-server-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.log');

  const stacksRoot = join(homeDir, '.happier', 'stacks');
  const runtimeDir = join(stacksRoot, 'stack-test');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, 'stack.runtime.json'),
    JSON.stringify({ updatedAt: '2026-03-26T00:00:00.000Z', ports: { server: 53288 } }) + '\n',
    'utf8',
  );

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo ""',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "EXPO_PUBLIC_HAPPIER_SERVER_URL=${EXPO_PUBLIC_HAPPIER_SERVER_URL:-}" > "$out/env.txt"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATUS"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "info: $*"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /host server url: http:\/\/127\.0\.0\.1:53288/);
  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');
});

test('macos wsrepl lima matrix wrapper supports multiple VM args and writes per-VM diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-multi-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      // Minimal stub: wrapper calls daemon start/stop/status/logs as best-effort diagnostics.
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo ""',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards: []',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATUS"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "info: $*"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    # Simulate a reachable shell but no guest happier binary.',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl-1', 'happy-wsrepl-2'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'vms', 'happy-wsrepl-2', 'lima.info.txt')), true);

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl create --name happy-wsrepl-1/);
  assert.match(limactlOut, /limactl create --name happy-wsrepl-2/);
});

test('macos wsrepl lima matrix wrapper prefers WSREPL_QA_LARGE_REPO_PATH for HAPPIER_QA_SESSION_PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-large-repo-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');
  const largeRepoDir = join(root, 'large-repo');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(largeRepoDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo ""',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "HAPPIER_QA_SESSION_PATH=${HAPPIER_QA_SESSION_PATH:-}" > "$out/env.txt"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards: []',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    WSREPL_QA_LARGE_REPO_PATH: largeRepoDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const playwrightEnvPath = join(reportDir, 'playwright', 'attempt-01', 'env.txt');
  const runnerEnv = await readFile(playwrightEnvPath, 'utf8');
  assert.match(runnerEnv, new RegExp(`HAPPIER_QA_SESSION_PATH=${largeRepoDir.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 0);
  assert.equal(summary.sessionPath, largeRepoDir, 'expected wrapper summary to record the resolved sessionPath (large repo override)');
});

test('macos wsrepl lima matrix wrapper retries Playwright once when fatal.json reports daemon RPC unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-retry-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.log');
  const limactlLog = join(logDir, 'limactl.log');
  const attemptMarker = join(logDir, 'attempt-marker.txt');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
	      `stopped_marker=${JSON.stringify(join(homeDir, '.host-daemon-stopped'))}`,
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      `  if [[ ! -f ${JSON.stringify(attemptMarker)} ]]; then`,
      `    echo "attempt-1" > ${JSON.stringify(attemptMarker)}`,
      '    mkdir -p "$out"',
      '    printf "%s\\n" "{\\"uiHint\\":\\"Dialog Session handoff failed Daemon RPC is not available (RPC method not available).\\",\\"error\\":\\"stub\\"}" > "$out/fatal.json"',
      '    echo "stub fail" >&2',
      '    exit 1',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"ok\\":true}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\\nstdout:\\n${res.stdout}\\nstderr:\\n${res.stderr}`);

  const attempt1Dir = join(reportDir, 'playwright', 'attempt-01');
  const attempt2Dir = join(reportDir, 'playwright', 'attempt-02');
  assert.equal(await fileExists(join(attempt1Dir, 'fatal.json')), true);
  assert.equal(await fileExists(join(attempt2Dir, 'meta.json')), true);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 0);
  assert.equal(await realpath(summary.playwrightOutDir), await realpath(attempt2Dir));

  const happierOut = await readFile(happierLog, 'utf8');
  assert.ok(
    happierOut.split('\n').filter((line) => line.includes('daemon start')).length >= 2,
    `expected daemon to be restarted before retry (got happier log: ${happierOut})`,
  );
});

test('macos wsrepl lima matrix wrapper prefers the stack runtime CLI inferred from the UI url (no worktree yarn self-heal)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-runtime-cli-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const runtimeCliLog = join(logDir, 'runtime-cli.log');
  const yarnLog = join(logDir, 'yarn.log');
  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const python3Path = join(binDir, 'python3');
  await writeFile(python3Path, ['#!/usr/bin/env bash', 'exec /usr/bin/python3 "$@"'].join('\n') + '\n', 'utf8');
  await chmod(python3Path, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      // The wrapper invokes the Playwright harness via `node <repo>/.project/scripts/...`.
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "yarn $*" >> ${JSON.stringify(yarnLog)}`,
      'exit 9',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(yarnPath, 0o755);

  const stackName = 'stack-from-ui';
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  const runtimeCliPath = join(stackRoot, 'runtime', 'current', 'cli', 'happier');
  const runtimeCliDir = join(stackRoot, 'runtime', 'current', 'cli');
  const runtimeJsonPath = join(stackRoot, 'stack.runtime.json');
  const accessKeyPath = join(stackRoot, 'cli', 'servers', 'server_test', 'access.key');
  const daemonLogPath = join(homeDir, 'daemon.log');

  await mkdir(runtimeCliDir, { recursive: true });
  await mkdir(resolve(accessKeyPath, '..'), { recursive: true });
  await writeFile(accessKeyPath, 'test-access-key\n', 'utf8');
  await writeFile(
    runtimeJsonPath,
    JSON.stringify({ ports: { server: 53288 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(daemonLogPath, 'daemon-log\n', 'utf8');

	  await writeFile(
	    runtimeCliPath,
	    buildStopAwareDaemonScript({
	      includeCommandEcho: true,
	      commandEchoPath: runtimeCliLog,
	      commandEchoPrefix: 'runtime-cli',
	      stoppedMarker: join(homeDir, '.host-daemon-stopped'),
	      daemonLogPath,
	      startExtraLines: ['echo "Cannot find module \'/tmp/apps/cli/dist/index.mjs\'" >&2'],
	      startSuccessLines: [],
	    }),
	    'utf8',
	  );
  await chmod(runtimeCliPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_2',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_2', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_2',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_2',
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const runtimeOut = await readFile(runtimeCliLog, 'utf8');
  assert.match(runtimeOut, /runtime-cli daemon start/);

  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.cli.build.txt')), false, 'did not expect worktree CLI build to run');
  assert.equal(await fileExists(yarnLog), false, 'did not expect yarn to be invoked');
});

test('macos wsrepl lima matrix wrapper restarts the guest daemon with HAPPIER_SERVER_URL rewritten for Lima (host.lima.internal)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-guest-server-url-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const guestEnvLog = join(logDir, 'guest-env.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'sub="${2:-}"',
	      'if [[ "$cmd" == "daemon" && "$sub" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  echo "HAPPIER_SERVER_URL=${HAPPIER_SERVER_URL-}" >> ' + JSON.stringify(guestEnvLog),
	      '  exit 0',
	      'fi',
	      'if [[ "$cmd" == "daemon" && "$sub" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "$cmd" == "daemon" && "$sub" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "$cmd" == "daemon" && "$sub" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "$cmd" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'exit 0',
	    ].join('\n') + '\n',
	    'utf8',
	  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      log_path="${HOME}/daemon.log"',
      '      printf "%s\\n" "stub daemon log" > "$log_path"',
      '      echo "$log_path"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_HOME_REL: '',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const logged = await readFile(guestEnvLog, 'utf8').catch(() => '');
  assert.ok(
    logged.includes('HAPPIER_SERVER_URL=http://host.lima.internal:53288'),
    `expected guest daemon to be restarted with host.lima.internal server url; got:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper uses stack CLI home dir + active server id for host daemon when stack credentials are discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-stack-home-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostEnvLog = join(logDir, 'host-env.log');

  // Seed a stack runtime + CLI access.key under this test HOME so the wrapper can discover it.
  const stackName = 'host-home-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'), JSON.stringify({ token: 'tok_test' }) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  // Force wrapper host CLI calls to use $HOME/.happier/bin/happier so we can observe env.
  const happierBinDir = join(homeDir, '.happier', 'bin');
  await mkdir(happierBinDir, { recursive: true });
  const happierPath = join(happierBinDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      stoppedMarker: join(homeDir, '.host-daemon-stopped'),
      startExtraLines: [
        'echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(hostEnvLog),
        'echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(hostEnvLog),
      ],
      startSuccessLines: [],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const logged = await readFile(hostEnvLog, 'utf8').catch(() => '');
  assert.ok(
    logged.includes(`HAPPIER_HOME_DIR=${join(stackRoot, 'cli')}`),
    `expected wrapper to run host daemon with stack cli home dir; got:\n${logged}`,
  );
  assert.ok(
    logged.includes(`HAPPIER_ACTIVE_SERVER_ID=${stackServerId}`),
    `expected wrapper to run host daemon with stack active server id; got:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper prefers server-scoped stack credentials over a newer legacy cli access key when deriving host daemon auth scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-stack-home-server-scoped-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostEnvLog = join(logDir, 'host-env.log');

  const stackName = 'host-home-prefers-server-scoped-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const serverScopedAccessKeyPath = join(stackRoot, 'cli', 'servers', stackServerId, 'access.key');
  const legacyAccessKeyPath = join(stackRoot, 'cli', 'access.key');
  await writeFile(serverScopedAccessKeyPath, JSON.stringify({ token: 'tok_scoped' }) + '\n', 'utf8');
  await writeFile(legacyAccessKeyPath, JSON.stringify({ token: 'tok_legacy' }) + '\n', 'utf8');
  const older = new Date('2026-03-28T10:00:00.000Z');
  const newer = new Date('2026-03-28T10:00:05.000Z');
  await utimes(serverScopedAccessKeyPath, older, older);
  await utimes(legacyAccessKeyPath, newer, newer);

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierBinDir = join(homeDir, '.happier', 'bin');
  await mkdir(happierBinDir, { recursive: true });
  const happierPath = join(happierBinDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      stoppedMarker: join(homeDir, '.host-daemon-stopped'),
      startExtraLines: [
        'echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(hostEnvLog),
        'echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(hostEnvLog),
      ],
      startSuccessLines: [],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const logged = await readFile(hostEnvLog, 'utf8').catch(() => '');
  assert.ok(
    logged.includes(`HAPPIER_HOME_DIR=${join(stackRoot, 'cli')}`),
    `expected wrapper to keep using stack cli home dir even when legacy cli/access.key is newer; got:\n${logged}`,
  );
  assert.ok(
    logged.includes(`HAPPIER_ACTIVE_SERVER_ID=${stackServerId}`),
    `expected wrapper to keep using the server-scoped active server id even when legacy cli/access.key is newer; got:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper still uses stack CLI home dir + active server id for host daemon when the access key path is missing but the active server dir is known', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-stack-home-active-server-dir-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostEnvLog = join(logDir, 'host-env.log');
  const stackName = 'host-home-active-server-dir-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const missingAccessKeyPath = join(stackRoot, 'cli', 'servers', stackServerId, 'access.key');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierBinDir = join(homeDir, '.happier', 'bin');
  await mkdir(happierBinDir, { recursive: true });
  const happierPath = join(happierBinDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      stoppedMarker: join(homeDir, '.host-daemon-stopped'),
      startExtraLines: [
        'echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(hostEnvLog),
        'echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(hostEnvLog),
      ],
      startSuccessLines: [],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: missingAccessKeyPath,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const logged = await readFile(hostEnvLog, 'utf8').catch(() => '');
  assert.ok(
    logged.includes(`HAPPIER_HOME_DIR=${join(stackRoot, 'cli')}`),
    `expected wrapper to keep using stack cli home dir when only the active server dir is known; got:\n${logged}`,
  );
  assert.ok(
    logged.includes(`HAPPIER_ACTIVE_SERVER_ID=${stackServerId}`),
    `expected wrapper to keep using stack active server id when only the active server dir is known; got:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper seeds host daemon access.key from stack credentials when daemon is waiting for auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-seed-host-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  // Seed a stack runtime + CLI access.key under this test HOME so the wrapper can discover it.
  const stackName = 'seed-host-stack';
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli'), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const accessKeyPayload = { token: 'tok_test', secret: 'sec_test' };
  const accessKeyPath = join(stackRoot, 'cli', 'access.key');
  await writeFile(accessKeyPath, JSON.stringify(accessKeyPayload) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(logDir, 'daemon.log');
  const expectedDaemonAccessKeyPath = join(homeDir, '.happier', 'servers', 'env_test', 'access.key');

  const happierPath = join(binDir, 'happier');
  await writeScript(
    happierPath,
    buildStopAwareDaemonScript({
      daemonLogPath,
      startExtraLines: [
        `      if [[ ! -f ${JSON.stringify(expectedDaemonAccessKeyPath)} ]]; then`,
        `        mkdir -p ${JSON.stringify(logDir)}`,
        `        printf "%s\\n" ${JSON.stringify(
          `[DAEMON RUN] Waiting for credentials at ${expectedDaemonAccessKeyPath}...`,
        )} > ${JSON.stringify(daemonLogPath)}`,
        '        echo "Failed to start daemon" >&2',
        '        exit 1',
        '      fi',
      ],
      statusExtraLines: [
        `      if [[ -f ${JSON.stringify(expectedDaemonAccessKeyPath)} ]]; then`,
        '        echo "Daemon is running"',
        '        exit 0',
        '      fi',
        '      echo "Daemon is not running"',
        '      exit 0',
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
  );

  const nodePath = join(binDir, 'node');
  await writeScript(nodePath, buildPlaywrightHarnessNodeScript({ passthroughMode: 'silent' }));

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    # Guest does not have happier installed in this test; wrapper should skip guest daemon restart.',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: accessKeyPath,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(await fileExists(expectedDaemonAccessKeyPath), true, 'expected wrapper to seed host daemon access.key');
});

test('macos wsrepl lima matrix wrapper preserves the canonical host machine id when WSREPL_QA_HOST_HOME_REL seeds an isolated host home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-home-isolated-machine-id-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const stackName = 'isolated-host-home-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackAccountId = 'cmn7wkmq5000itrk3ajbwgo26';
  const canonicalMachineId = '5ddb9a7e-bbb3-4a00-890e-1ec5771f8d00';
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(stackRoot, 'cli', 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'cloud',
        machineIdByServerId: {
          [stackServerId]: canonicalMachineId,
        },
        machineIdByServerIdByAccountId: {
          [stackServerId]: {
            [stackAccountId]: canonicalMachineId,
          },
        },
        lastTokenSubByServerId: {
          [stackServerId]: stackAccountId,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'), JSON.stringify({ token: 'tok_test' }) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const hostEnvLog = join(logDir, 'host-env.log');
  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      startExtraLines: [
        'echo "daemon started"',
        `echo "HAPPIER_HOME_DIR=${'${HAPPIER_HOME_DIR:-}'}" >> ${JSON.stringify(hostEnvLog)}`,
        `echo "HAPPIER_ACTIVE_SERVER_ID=${'${HAPPIER_ACTIVE_SERVER_ID:-}'}" >> ${JSON.stringify(hostEnvLog)}`,
      ],
      statusRunningLines: [
        'echo "🤖 Daemon Status"',
        'echo "✓ Daemon is running"',
        'echo "📄 Daemon State:"',
        'settings_path="${HAPPIER_HOME_DIR:-$HOME}/settings.json"',
        'if [[ -f "$settings_path" ]]; then',
        '  machine_id="$(python3 - "$settings_path" "${HAPPIER_ACTIVE_SERVER_ID:-}" <<\'PY\'',
        'import json',
        'import sys',
        'from pathlib import Path',
        'settings = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))',
        'server_id = (sys.argv[2] or "").strip()',
        'account_id = ""',
        'if isinstance(settings, dict):',
        '  last_token_sub_by_server_id = settings.get("lastTokenSubByServerId") if isinstance(settings.get("lastTokenSubByServerId"), dict) else {}',
        '  if server_id in last_token_sub_by_server_id and isinstance(last_token_sub_by_server_id.get(server_id), str):',
        '    account_id = str(last_token_sub_by_server_id.get(server_id) or "").strip()',
        '  machine_id_by_server_id_by_account_id = settings.get("machineIdByServerIdByAccountId") if isinstance(settings.get("machineIdByServerIdByAccountId"), dict) else {}',
        '  if server_id in machine_id_by_server_id_by_account_id and isinstance(machine_id_by_server_id_by_account_id.get(server_id), dict):',
        '    server_account_map = machine_id_by_server_id_by_account_id.get(server_id) or {}',
        '    if account_id and isinstance(server_account_map.get(account_id), str):',
        '      print(str(server_account_map.get(account_id)).strip())',
        '      raise SystemExit(0)',
        '  machine_id_by_server_id = settings.get("machineIdByServerId") if isinstance(settings.get("machineIdByServerId"), dict) else {}',
        '  if server_id in machine_id_by_server_id and isinstance(machine_id_by_server_id.get(server_id), str):',
        '    print(str(machine_id_by_server_id.get(server_id)).strip())',
        '    raise SystemExit(0)',
        'print("")',
        'PY',
        '  )"',
        'else',
        '  machine_id="machine_host_isolated"',
        'fi',
        'echo "{\\"pid\\":123,\\"httpPort\\":1,\\"startedAt\\":0,\\"startedWithCliVersion\\":\\"0.1.0\\",\\"machineId\\":\\"${machine_id}\\"}"',
        'exit 0',
      ],
      startSuccessLines: ['exit 0'],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      passthroughMode: 'silent',
      playwrightScriptLines: [
        '  out="${HAPPIER_QA_OUTDIR:-}"',
        '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
        '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
        '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
        '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
        '  mkdir -p "$out/steps/step-01"',
        '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
        '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
        '  echo "stub ok"',
        '  exit 0',
      ],
    }),
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const hostHomeRel = 'isolated-host-home';
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'),
    WSREPL_QA_HOST_HOME_REL: hostHomeRel,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const isolatedSettingsPath = join(homeDir, hostHomeRel, 'settings.json');
  assert.equal(await fileExists(isolatedSettingsPath), true, 'expected wrapper to seed settings.json into the isolated host home');
  const isolatedSettings = JSON.parse(await readFile(isolatedSettingsPath, 'utf8'));
  assert.equal(
    isolatedSettings.machineIdByServerId?.[stackServerId],
    canonicalMachineId,
    'expected isolated host home settings to preserve the canonical host machine id by server id',
  );
  assert.equal(
    isolatedSettings.machineIdByServerIdByAccountId?.[stackServerId]?.[stackAccountId],
    canonicalMachineId,
    'expected isolated host home settings to preserve the canonical host machine id by server/account id',
  );

  const meta = await readPlaywrightMetaFromReportRoot(reportDir);
  assert.equal(meta.sourceMachineId, canonicalMachineId, 'expected wrapper to export the canonical host machine id to Playwright');

  const hostEnv = await readFile(hostEnvLog, 'utf8').catch(() => '');
  assert.ok(
    hostEnv.includes(`HAPPIER_HOME_DIR=${join(homeDir, hostHomeRel)}`),
    `expected wrapper to run host daemon in the isolated home; got:\n${hostEnv}`,
  );
});

test('macos wsrepl lima matrix wrapper fails closed when WSREPL_QA_HOST_HOME_REL is set but stack scope cannot be resolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-home-scope-missing-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostEnvLog = join(logDir, 'host-env.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      startExtraLines: [
        `echo "daemon start invoked" >> ${JSON.stringify(hostEnvLog)}`,
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_HOME_REL: 'isolated-host-home',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected non-zero exit when isolated host home cannot be resolved\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /isolated host home/i);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.failureStage, 'host_daemon');
  assert.equal(summary.failureReason, 'host_daemon_scope_resolution_failed');

  assert.equal(await fileExists(hostEnvLog), false, 'expected wrapper to fail closed before invoking happier daemon start');

  const scopePath = join(reportDir, 'daemon', 'host.daemon.scope.json');
  assert.equal(await fileExists(scopePath), true, 'expected scope diagnostics to be written');
  const scope = JSON.parse(await readFile(scopePath, 'utf8'));
  assert.equal(scope.hostHomeRel, 'isolated-host-home');
  assert.equal(scope.canonicalStackCliRoot, null);
  assert.equal(scope.canonicalStackActiveServerId, null);
  assert.equal(scope.stackAccessKeySource, null);
  assert.equal(scope.effectiveHostDaemonHome, null);
  assert.equal(scope.usedIsolatedHostHome, false);
});

test('macos wsrepl lima matrix wrapper advances the host direct-peer bind port when the requested port is already occupied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-bind-port-occupied-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const stackName = 'bind-port-occupied-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'), JSON.stringify({ token: 'tok_test' }) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const hostEnvLog = join(logDir, 'host-env.log');
  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      startExtraLines: [
        `echo "PATH=${'${PATH}'}" >> ${JSON.stringify(hostEnvLog)}`,
        `echo "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=${'${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}'}" >> ${JSON.stringify(hostEnvLog)}`,
      ],
      statusRunningLines: [
        'echo "🤖 Daemon Status"',
        'echo "✓ Daemon is running"',
        'echo "📄 Daemon State:"',
        'echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":"machine_host_canonical"}\'',
        'exit 0',
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      passthroughMode: 'silent',
      playwrightScriptLines: [
        '  out="${HAPPIER_QA_OUTDIR:-}"',
        '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
        '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
        '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
        '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
        '  mkdir -p "$out/steps/step-01"',
        '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
        '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
        '  exit 0',
      ],
    }),
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(
    lsofPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if printf "%s\\n" "$*" | grep -q "TCP:13381"; then',
      '  echo "node 492 leeroy 16u IPv4 0xdeadbeef 0t0 TCP *:13381 (LISTEN)"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(lsofPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'),
    WSREPL_QA_HOST_HOME_REL: 'occupied-host-home',
    WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT: '13381',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const hostEnv = await readFile(hostEnvLog, 'utf8').catch(() => '');
  assert.ok(
    hostEnv.includes('PATH=/usr/sbin:/sbin:'),
    `expected wrapper to prepend system bins so lsof is discoverable even when PATH omits them; got:\n${hostEnv}`,
  );
  const bindPortMatch = hostEnv.match(/HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=(\d+)/);
  assert.ok(bindPortMatch, `expected wrapper to log the resolved host direct-peer port; got:\n${hostEnv}`);
  assert.notEqual(bindPortMatch?.[1], '13381', `expected wrapper to skip the occupied host direct-peer port; got:\n${hostEnv}`);
  assert.ok(Number(bindPortMatch?.[1] ?? 0) > 13381, `expected wrapper to advance past the occupied host direct-peer port; got:\n${hostEnv}`);
});

test('macos wsrepl lima matrix wrapper prefers the wrapper-selected host direct-peer bind port over stale ambient env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-bind-port-env-precedence-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const stackName = 'bind-port-env-precedence-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'), JSON.stringify({ token: 'tok_test' }) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const hostEnvLog = join(logDir, 'host-env.log');
  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      startExtraLines: [
        `echo "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=${'${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}'}" >> ${JSON.stringify(hostEnvLog)}`,
      ],
      statusRunningLines: [
        'echo "🤖 Daemon Status"',
        'echo "✓ Daemon is running"',
        'echo "📄 Daemon State:"',
        'echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":"machine_host_canonical"}\'',
        'exit 0',
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      passthroughMode: 'silent',
      playwrightScriptLines: [
        '  out="${HAPPIER_QA_OUTDIR:-}"',
        '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
        '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
        '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
        '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
        '  mkdir -p "$out/steps/step-01"',
        '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
        '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
        '  exit 0',
      ],
    }),
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(
    lsofPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(lsofPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(
    ncPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n',
    'utf8',
  );
  await chmod(ncPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'),
    WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT: '49381',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT: '49382',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const hostEnv = await readFile(hostEnvLog, 'utf8').catch(() => '');
  const bindPortMatch = hostEnv.match(/HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=(\d+)/);
  assert.ok(bindPortMatch, `expected wrapper to log the effective host direct-peer bind port; got:\n${hostEnv}`);
  assert.equal(
    bindPortMatch?.[1],
    '49381',
    `expected wrapper-selected host direct-peer bind port to override stale ambient env; got:\n${hostEnv}`,
  );
});

test('macos wsrepl lima matrix wrapper advances the host direct-peer bind port when lsof is unavailable but nc can probe occupancy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-bind-port-nc-fallback-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const stackName = 'bind-port-nc-fallback-stack';
  const stackServerId = `stack_${stackName}__id_default`;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', stackServerId), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'), JSON.stringify({ token: 'tok_test' }) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const hostEnvLog = join(logDir, 'host-env.log');
  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    buildStopAwareDaemonScript({
      startExtraLines: [
        `echo "HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=${'${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}'}" >> ${JSON.stringify(hostEnvLog)}`,
      ],
      statusRunningLines: [
        'echo "🤖 Daemon Status"',
        'echo "✓ Daemon is running"',
        'echo "📄 Daemon State:"',
        'echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":"machine_host_canonical"}\'',
        'exit 0',
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      passthroughMode: 'silent',
      playwrightScriptLines: [
        '  out="${HAPPIER_QA_OUTDIR:-}"',
        '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
        '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
        '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
        '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
        '  mkdir -p "$out/steps/step-01"',
        '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
        '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
        '  exit 0',
      ],
    }),
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    exit 0',
      '    ;;',
      '  start|stop|info|list|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(
    ncPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if printf "%s\\n" "$*" | grep -q "13381"; then',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(ncPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_STACK_NAME: stackName,
    HAPPIER_QA_ACCESS_KEY_PATH: join(stackRoot, 'cli', 'servers', stackServerId, 'access.key'),
    WSREPL_QA_HOST_HOME_REL: 'occupied-host-home',
    WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT: '13381',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const hostEnv = await readFile(hostEnvLog, 'utf8').catch(() => '');
  const bindPortMatch = hostEnv.match(/HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=(\d+)/);
  assert.ok(bindPortMatch, `expected wrapper to log the resolved host direct-peer port; got:\n${hostEnv}`);
  assert.notEqual(bindPortMatch?.[1], '13381', `expected wrapper to skip the occupied host direct-peer port without lsof in PATH; got:\n${hostEnv}`);
  assert.ok(Number(bindPortMatch?.[1] ?? 0) > 13381, `expected wrapper to advance past the occupied host direct-peer port without lsof in PATH; got:\n${hostEnv}`);
});

test('macos wsrepl lima matrix wrapper surfaces playwright fatal hint in summary.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-fatal-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo ""',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      '  printf "%s\\n" "{\\"ok\\":false,\\"error\\":\\"fatal error from stub\\",\\"uiHint\\":\\"missing_handoff_metadata_v2\\"}" > "$out/fatal.json"',
      '  echo "stub fatal" >&2',
      '  exit 1',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  list)',
      '    echo "NAME STATE" && echo "stub Running"',
      '    exit 0',
      '    ;;',
      '  info)',
      '    echo "stub info"',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    # Always succeed for diagnostics + version probing.',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'stack_runtime',
    HAPPIER_QA_SESSION_ID: 'sess_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 1, `expected exit 1\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');
  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 1);
  assert.equal(summary.failureStage, 'playwright');
  assert.match(String(summary.failureReason ?? ''), /missing_handoff_metadata_v2/);
});

test('macos wsrepl lima matrix wrapper does not require a source machine id for create-session (Playwright can auto-resolve via picker route)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-missing-source-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
      '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
      '  printf "%s\\n" "{\\"kind\\\":\\"stub\\\",\\\"stepsJson\\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\\"sourceMachineId\\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\\"sessionId\\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\\"sessionPath\\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
	    LIMA_HOME: limaHome,
	    PATH: `${binDir}:${process.env.PATH ?? ''}`,
	    WSREPL_QA_OUTPUT_DIR: reportDir,
	    HAPPIER_QA_STACK_NAME: 'stack-test',
	    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
	    HAPPIER_QA_SESSION_PATH: root,
	    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
	    // Intentionally omit WSREPL_QA_HOST_MACHINE_ID + HAPPIER_QA_SOURCE_MACHINE_ID.
	    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const meta = await readPlaywrightMetaFromReportRoot(reportDir);
  assert.equal(meta.sourceMachineId, '');
});

test('macos wsrepl lima matrix wrapper polls daemon status until host machine id is available and exports it as source machine id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-poll-host-machine-id-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(homeDir, 'daemon.log');
  await writeFile(daemonLogPath, 'stub daemon log\n', 'utf8');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  --version)',
      '    echo "0.1.0"',
      '    exit 0',
      '    ;;',
      '  install)',
      '    # Wrapper ensures a provider cli is installed; keep this non-fatal in tests.',
      '    exit 0',
      '    ;;',
	      '  daemon)',
	      '    sub="${1:-}"',
	      '    shift || true',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '        exit 0',
	      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      `        count_file=${JSON.stringify(join(homeDir, 'daemon-status-count.txt'))}`,
	      '        count="0"',
      '        if [[ -f "$count_file" ]]; then',
      '          count="$(cat "$count_file" 2>/dev/null || echo 0)"',
      '        fi',
      '        count="$((count + 1))"',
      '        printf "%s" "$count" > "$count_file"',
      "        echo \"🤖 Daemon Status\"",
      "        echo \"✓ Daemon is running\"",
      "        echo \"📄 Daemon State:\"",
      '        if [[ "$count" -ge 2 ]]; then',
      '          echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0","machineId":"machine_host_derived"}\'',
      '        else',
      '          # First status call: daemon state exists but machineId is not populated yet.',
      '          echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0"}\'',
      '        fi',
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
      '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
	    LIMA_HOME: limaHome,
	    PATH: `${binDir}:${process.env.PATH ?? ''}`,
	    WSREPL_QA_OUTPUT_DIR: reportDir,
	    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
	    HAPPIER_QA_SESSION_PATH: root,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    // Intentionally omit WSREPL_QA_HOST_MACHINE_ID + HAPPIER_QA_SOURCE_MACHINE_ID; wrapper must poll and export.
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_MACHINE_ID_POLL_RETRIES: '3',
    WSREPL_QA_MACHINE_ID_POLL_DELAY_MS: '0',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const meta = await readPlaywrightMetaFromReportRoot(reportDir);
  assert.equal(meta.sourceMachineId, 'machine_host_derived');
});

test('macos wsrepl lima matrix wrapper skips host machineId polling when WSREPL_QA_HOST_MACHINE_ID is already provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-skip-host-poll-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(homeDir, 'daemon.log');
  await writeFile(daemonLogPath, 'stub daemon log\n', 'utf8');

  const statusCountPath = join(homeDir, 'daemon-status-count.txt');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  --version)',
      '    echo "0.1.0"',
      '    exit 0',
      '    ;;',
      '  install)',
      '    exit 0',
      '    ;;',
	      '  daemon)',
	      '    sub="${1:-}"',
	      '    shift || true',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '        exit 0',
	      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      `        count_file=${JSON.stringify(statusCountPath)}`,
	      '        count="0"',
      '        if [[ -f "$count_file" ]]; then',
      '          count="$(cat "$count_file" 2>/dev/null || echo 0)"',
      '        fi',
      '        count="$((count + 1))"',
      '        printf "%s" "$count" > "$count_file"',
      "        echo \"🤖 Daemon Status\"",
      "        echo \"✓ Daemon is running\"",
      "        echo \"📄 Daemon State:\"",
      '        echo \'{"pid":123,"httpPort":1,"startedAt":0,"startedWithCliVersion":"0.1.0"}\'',
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  sid="${HAPPIER_QA_SESSION_ID:-sess_created_1}"',
      '  spath="${HAPPIER_QA_SESSION_PATH:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\"),\\"sessionId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$sid\"),\\"sessionPath\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$spath\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_PATH: root,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_MACHINE_ID_POLL_RETRIES: '3',
    WSREPL_QA_MACHINE_ID_POLL_DELAY_MS: '0',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const countRaw = await readFile(statusCountPath, 'utf8');
  const count = Number(String(countRaw).trim());
  assert.ok(Number.isFinite(count), `expected daemon status count to be a finite number (got: ${JSON.stringify(countRaw)})`);
  assert.ok(
    count <= 2,
    `expected wrapper to avoid machineId polling when host machine id is already provided (expected <=2 daemon status calls, got ${count})`,
  );
});

test('macos wsrepl lima matrix wrapper can discover stack credentials from the most-recent stack.runtime.json when HAPPIER_QA_STACK_NAME and HAPPIER_UI_URL are unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-seed-host-auto-stack-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  // Seed a stack runtime + CLI access.key under this test HOME so the wrapper can discover it.
  const stackName = 'autodetect-stack';
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli'), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const accessKeyPayload = { token: 'tok_test_auto', secret: 'sec_test_auto' };
  const accessKeyPath = join(stackRoot, 'cli', 'access.key');
  await writeFile(accessKeyPath, JSON.stringify(accessKeyPayload) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(logDir, 'daemon.log');
  const expectedDaemonAccessKeyPath = join(homeDir, '.happier', 'servers', 'env_test', 'access.key');

  const happierPath = join(binDir, 'happier');
  await writeScript(
    happierPath,
    buildStopAwareDaemonScript({
      daemonLogPath,
      startExtraLines: [
        `      if [[ ! -f ${JSON.stringify(expectedDaemonAccessKeyPath)} ]]; then`,
        '        echo "Failed to start daemon"',
        `        echo ${JSON.stringify(`Latest daemon log: ${daemonLogPath}`)}`,
        '        exit 1',
        '      fi',
      ],
      statusExtraLines: [
        `      if [[ -f ${JSON.stringify(expectedDaemonAccessKeyPath)} ]]; then`,
        '        echo "Daemon is running"',
        '        exit 0',
        '      fi',
        '      echo "Daemon is not running"',
        '      exit 0',
      ],
      startSuccessLines: ['echo "daemon started"', 'exit 0'],
    }),
  );

  await writeFile(
    daemonLogPath,
    [
      '[00:00:00.000] [DAEMON RUN] Waiting for credentials at ' + expectedDaemonAccessKeyPath + '...',
    ].join('\n') + '\n',
    'utf8',
  );

  const nodePath = join(binDir, 'node');
  await writeScript(nodePath, buildPlaywrightHarnessNodeScript({ passthroughMode: 'silent' }));

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    // Intentionally omit HAPPIER_QA_STACK_NAME and HAPPIER_UI_URL.
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(await fileExists(expectedDaemonAccessKeyPath), true, 'expected wrapper to seed host daemon access.key via autodetected stack credentials');
});

test('macos wsrepl lima matrix wrapper derives host server url from the most-recent stack.runtime.json when HAPPIER_UI_URL is unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-server-url-autodetect-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const stackName = 'autodetect-stack';
  const serverPort = 41234;
  const stackRoot = join(homeDir, '.happier', 'stacks', stackName);
  await mkdir(join(stackRoot, 'cli', 'servers', `stack_${stackName}__id_default`), { recursive: true });
  const accessKeyPath = join(stackRoot, 'cli', 'access.key');
  await writeFile(accessKeyPath, JSON.stringify({ token: 'tok_test_server_url' }) + '\n', 'utf8');
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: serverPort }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const envLog = join(logDir, 'host-env.log');
  const daemonLogPath = join(logDir, 'daemon.log');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '        echo "HAPPIER_SERVER_URL=${HAPPIER_SERVER_URL-}" >> ' + JSON.stringify(envLog),
	      '        echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(envLog),
	      '        echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(envLog),
      '        echo "daemon started"',
	      '        exit 0',
	      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      '        echo "Daemon is running"',
	      '        exit 0',
	      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  await writeFile(daemonLogPath, ['[00:00:00.000] daemon log'].join('\n') + '\n', 'utf8');

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    HAPPIER_QA_ACCESS_KEY_PATH: accessKeyPath,
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    // Intentionally omit HAPPIER_UI_URL and HAPPIER_SERVER_URL.
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const logged = await readFile(envLog, 'utf8');
  assert.ok(
    logged.includes(`HAPPIER_SERVER_URL=http://127.0.0.1:${serverPort}`),
    `expected host HAPPIER_SERVER_URL derived from stack.runtime.json\nlogged:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper resolves stack cli home from explicit HAPPIER_SERVER_URL even when the newest stack is unrelated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-server-url-stack-home-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const desiredStackName = 'desired-stack';
  const desiredServerPort = 53288;
  const desiredServerId = `stack_${desiredStackName}__id_default`;
  const desiredStackRoot = join(homeDir, '.happier', 'stacks', desiredStackName);
  await mkdir(join(desiredStackRoot, 'cli', 'servers', desiredServerId), { recursive: true });
  await writeFile(
    join(desiredStackRoot, 'stack.runtime.json'),
    JSON.stringify(
      { version: 1, ports: { server: desiredServerPort }, expo: { webPort: 19000 }, updatedAt: new Date(1_710_000_000_000).toISOString() },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(join(desiredStackRoot, 'cli', 'servers', desiredServerId, 'access.key'), JSON.stringify({ token: 'tok_desired' }) + '\n', 'utf8');

  const distractingStackName = 'newer-but-unrelated-stack';
  const distractingStackRoot = join(homeDir, '.happier', 'stacks', distractingStackName);
  await mkdir(distractingStackRoot, { recursive: true });
  await writeFile(
    join(distractingStackRoot, 'stack.runtime.json'),
    JSON.stringify(
      { version: 1, ports: { server: 61234 }, expo: { webPort: 19001 }, updatedAt: new Date(1_720_000_000_000).toISOString() },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const envLog = join(logDir, 'host-env.log');
  const daemonLogPath = join(logDir, 'daemon.log');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        printf "1" > "$stopped_marker"',
      '        exit 0',
      '        ;;',
      '      start|start-sync)',
      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '        echo "HAPPIER_SERVER_URL=${HAPPIER_SERVER_URL-}" >> ' + JSON.stringify(envLog),
      '        echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(envLog),
      '        echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(envLog),
      '        echo "daemon started"',
      '        exit 0',
      '        ;;',
      '      status)',
      '        if [[ -f "$stopped_marker" ]]; then',
      '          echo "Daemon is not running"',
      '          exit 0',
      '        fi',
      '        echo "Daemon is running"',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  await writeFile(daemonLogPath, ['[00:00:00.000] daemon log'].join('\n') + '\n', 'utf8');

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    echo "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_SERVER_URL: `http://127.0.0.1:${desiredServerPort}`,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const logged = await readFile(envLog, 'utf8');
  assert.ok(
    logged.includes(`HAPPIER_SERVER_URL=http://127.0.0.1:${desiredServerPort}`),
    `expected wrapper to preserve explicit HAPPIER_SERVER_URL\nlogged:\n${logged}`,
  );
  assert.ok(
    logged.includes(`HAPPIER_HOME_DIR=${join(desiredStackRoot, 'cli')}`),
    `expected wrapper to resolve the desired stack cli home from HAPPIER_SERVER_URL\nlogged:\n${logged}`,
  );
  assert.ok(
    logged.includes(`HAPPIER_ACTIVE_SERVER_ID=${desiredServerId}`),
    `expected wrapper to resolve the desired active server id from HAPPIER_SERVER_URL\nlogged:\n${logged}`,
  );
});

test('macos wsrepl lima matrix wrapper enforces a hard timeout for the playwright runner and still writes summary.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-timeout-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      nodeLogPath: nodeLog,
      includeDaemonControl: true,
      playwrightScriptLines: [
        '  mkdir -p "$out"',
        '  sleep 0.25',
        '  exit 0',
      ],
    }),
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|copy)',
      '    exit 0',
      '    ;;',
      '  list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_timeout_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    HAPPIER_QA_TIMEOUT_MS: '50',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 124, `expected exit 124\\nstdout:\\n${res.stdout}\\nstderr:\\n${res.stderr}`);
  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');
  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 124);
  assert.equal(summary.failureStage, 'playwright');
  assert.match(String(summary.failureReason ?? ''), /timeout/i);
});

test('macos wsrepl lima matrix wrapper runs the autoupdate payload builder from the repo root (stable node resolution)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-cwd-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '  echo "Daemon started successfully"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo "/tmp/daemon.log"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" ]]; then',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      `echo "pwd=$(pwd)" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      // Autoupdate payload builder (`node --input-type=module - ...`).
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
      'fi',
      // Playwright harness.
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"sessionId\\":\\"sess_autoupdate_cwd_1\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  start|stop|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_autoupdate_cwd_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
    WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK: '0',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const repoRoot = resolve(join(__dirname, '..', '..', '..'));
  const nodeOut = await readFile(nodeLog, 'utf8');
  const lines = nodeOut.split('\n').filter((line) => line.length > 0);
  const payloadBuilderIndex = lines.findIndex((line) => line.includes('bun-linux-arm64'));
  assert.ok(payloadBuilderIndex >= 0, `expected node log to include bun target invocation; got:\n${nodeOut}`);
  assert.equal(
    lines[payloadBuilderIndex + 1],
    `pwd=${repoRoot}`,
    `expected autoupdate payload builder to run from the repo root; got:\n${nodeOut}`,
  );
});

test('macos wsrepl lima matrix wrapper fails closed when guest wsrepl build marker is missing (require mode)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-mismatch-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0-preview-old"',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  start|stop|info|list)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'require',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0);
  assert.match(`${res.stdout}\n${res.stderr}`, /wsrepl build marker|wsrepl-build\.json/i);
});

test('macos wsrepl lima matrix wrapper can autoupdate guest happier to match the worktree (autoupdate mode)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  # Before autoupdate, the guest has a preview build installed.',
      '  if [[ -L "${HOME}/.happier/bin/happier" ]]; then',
      '    target="$(readlink "${HOME}/.happier/bin/happier" || true)"',
      '    if [[ "$target" == "${HOME}/.happier/wsrepl-dev/payload/happier" ]]; then',
      '      echo "0.1.0"',
      '      exit 0',
      '    fi',
      '  fi',
	      '  echo "0.1.0-preview-old"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" ]]; then',
	      '  exit 0',
	      'fi',
	      'exit 0',
	    ].join('\n') + '\n',
	    'utf8',
	  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    cat >/dev/null || true',
      '    exit 0',
      '  fi',
      `  echo "===stdin-begin===" >> ${JSON.stringify(join(logDir, 'node.stdin.log'))}`,
      `  cat >> ${JSON.stringify(join(logDir, 'node.stdin.log'))} || true`,
      `  echo "\\n===stdin-end===\\n" >> ${JSON.stringify(join(logDir, 'node.stdin.log'))}`,
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]; then echo "unexpected daemon start-sync" >&2; exit 12; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
    'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    # target is formatted like <vm>:/abs/path (for this test we treat it as local fs)',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_auto',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl copy/);
});

test('macos wsrepl lima matrix writes vm-happier build log when guest autoupdate build fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-build-fail-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  --version)',
      '    echo "0.1.0"',
      '    exit 0',
      '    ;;',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      start)',
      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '        exit 0',
      '        ;;',
      '      stop)',
      '        printf "1" > "$stopped_marker"',
      '        exit 0',
      '        ;;',
      '      status)',
      '        if [[ -f "$stopped_marker" ]]; then',
      '          echo "Daemon is not running"',
      '          exit 0',
      '        fi',
      '        echo "Daemon is running"',
      '        exit 0',
      '        ;;',
      '      logs)',
      '        echo ""',
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const lsofPath = join(binDir, 'lsof');
  await writeFile(lsofPath, ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n', 'utf8');
  await chmod(lsofPath, 0o755);

  const ncPath = join(binDir, 'nc');
  await writeFile(ncPath, ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 1'].join('\n') + '\n', 'utf8');
  await chmod(ncPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ -n "${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}" ]]; then',
      '  echo "stub build blew up" >&2',
      '  exit 33',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_test_autoupdate_build_fail',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 2, `expected exit 2\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.failureStage, 'guest_version_check');
  assert.equal(summary.failureReason, 'guest_autoupdate_failed');

  const buildLogPath = join(reportDir, 'vm-happier', 'build.log');
  assert.equal(await fileExists(buildLogPath), true, `expected build log at ${buildLogPath}`);
  const buildLog = await readFile(buildLogPath, 'utf8');
  assert.match(buildLog, /stub build blew up/);
});

test('macos wsrepl lima matrix wrapper keeps the host daemon alive while autoupdating the guest before Playwright starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-watchdog-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostLog = join(logDir, 'host.log');
  const daemonLogPath = join(logDir, 'daemon.log');
  const buildMarker = join(logDir, 'guest-autoupdate-marker');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(hostLog)}`,
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
	      'shift || true',
      'case "$cmd" in',
      '  --version)',
      '    echo "0.1.0"',
      '    exit 0',
      '    ;;',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      `        if [[ -f ${JSON.stringify(buildMarker)} && ! -f ${JSON.stringify(join(logDir, 'host-watchdog-failed-once'))} ]]; then`,
	      `          printf "%s" "1" > ${JSON.stringify(join(logDir, 'host-watchdog-failed-once'))}`,
	      '          exit 1',
      '        fi',
      '        echo "Daemon is running"',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '        echo "daemon started"',
	      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(join(logDir, 'node.log'))}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      `  printf "%s" "1" > ${JSON.stringify(buildMarker)}`,
      '  sleep 0.25',
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]; then echo "unexpected daemon start-sync" >&2; exit 12; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      '  sleep 0.25',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [48888, 48888]',
      '    hostPortRange:  [48888, 48888]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_autoupdate_watchdog_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
    WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK: '0',
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT: '48888',
    WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(
    await fileExists(join(logDir, 'host-watchdog-failed-once')),
    true,
    'expected the watchdog to observe the transient autoupdate-era daemon-status failure',
  );

  const hostOut = await readFile(hostLog, 'utf8');
  const startCount = hostOut.split('\n').filter((line) => line.includes('happier daemon start')).length;
  assert.equal(
    startCount,
    1,
    `expected the watchdog to tolerate a single transient failure without restarting the host daemon; log:\n${hostOut}`,
  );
  const firstStartIndex = hostOut.indexOf('happier daemon start');
  const playWrightPhaseHostOut = firstStartIndex >= 0 ? hostOut.slice(firstStartIndex + 1) : hostOut;
  assert.equal(
    playWrightPhaseHostOut.includes('happier daemon stop'),
    false,
    `expected watchdog to avoid stopping the host daemon during Playwright; log:\n${hostOut}`,
  );
});

test('macos wsrepl lima matrix watchdog restarts the host daemon when status reports a dead PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-watchdog-dead-pid-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostLog = join(logDir, 'host.log');
  const daemonLogPath = join(logDir, 'daemon.log');
  const buildMarker = join(logDir, 'guest-autoupdate-marker');
  const deadPidMarker = join(logDir, 'host-watchdog-dead-pid-once');
  const daemonStartedMarker = join(logDir, 'host-daemon-started-once');
  const daemonRestartedMarker = join(logDir, 'host-daemon-restarted-after-dead-pid');
  const playwrightRunningMarker = join(homeDir, '.playwright-running');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "happier $*" >> ${JSON.stringify(hostLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  --version)',
      '    echo "0.1.0"',
      '    exit 0',
      '    ;;',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        printf "1" > "$stopped_marker"',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      status)',
      '        if [[ -f "$stopped_marker" ]]; then',
      '          echo "Daemon is not running"',
      '          exit 0',
      '        fi',
      `        if [[ ( -f ${JSON.stringify(buildMarker)} || -f ${JSON.stringify(playwrightRunningMarker)} ) && -f ${JSON.stringify(daemonStartedMarker)} && ! -f ${JSON.stringify(daemonRestartedMarker)} ]]; then`,
      `          printf "%s" "1" > ${JSON.stringify(deadPidMarker)}`,
      '          echo "Daemon is running"',
      '          echo "  PID: 99999999"',
      '          exit 0',
      '        fi',
      '        echo "Daemon is running"',
      '        exit 0',
      '        ;;',
      '      start|start-sync)',
      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      `        if [[ -f ${JSON.stringify(daemonStartedMarker)} ]]; then`,
      `          printf "%s" "1" > ${JSON.stringify(daemonRestartedMarker)}`,
      '        else',
      `          printf "%s" "1" > ${JSON.stringify(daemonStartedMarker)}`,
      '        fi',
      '        echo "daemon started"',
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(join(logDir, 'node.log'))}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      `  printf "%s" "1" > ${JSON.stringify(buildMarker)}`,
      '  for _attempt in $(seq 1 40); do',
      `    if [[ -f ${JSON.stringify(daemonRestartedMarker)} ]]; then`,
      '      break',
      '    fi',
      '    sleep 0.05',
      '  done',
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]; then echo "unexpected daemon start-sync" >&2; exit 12; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      `  printf "%s" "1" > ${JSON.stringify(playwrightRunningMarker)}`,
      '  for _attempt in $(seq 1 40); do',
      `    if [[ -f ${JSON.stringify(deadPidMarker)} ]]; then`,
      '      break',
      '    fi',
      '    sleep 0.05',
      '  done',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [48888, 48888]',
      '    hostPortRange:  [48888, 48888]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_watchdog_dead_pid_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT: '48888',
    WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const hostOut = await readFile(hostLog, 'utf8');
  const startCount = hostOut.split('\n').filter((line) => line.includes('happier daemon start')).length;
  assert.equal(startCount, 2, `expected watchdog to restart when daemon status reports a dead PID; log:\n${hostOut}`);
});

test('macos wsrepl lima matrix wrapper autoupdate mode does not fail closed when guest daemon status is waiting for credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-wait-auth-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');
  const stdinLog = join(logDir, 'node.stdin.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0-preview-old"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" ]]; then',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
  '  esac',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      `  echo "===stdin-begin===" >> ${JSON.stringify(stdinLog)}`,
      `  cat >> ${JSON.stringify(stdinLog)} || true`,
      `  echo "\\n===stdin-end===\\n" >> ${JSON.stringify(stdinLog)}`,
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \\',
      "    '#!/usr/bin/env bash' \\",
      "    'set -euo pipefail' \\",
      "    'if [[ \"${1:-}\" == \"--version\" ]]; then echo 0.1.0; exit 0; fi' \\",
      "    'if [[ \"${1:-}\" == \"daemon\" && \"${2:-}\" == \"status\" ]]; then echo \"Waiting for credentials\"; exit 1; fi' \\",
      "    'if [[ \"${1:-}\" == \"daemon\" ]]; then exit 0; fi' \\",
      "    'exit 0' \\",
      '    > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\"}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  start|stop|info|list)',
      '    exit 0',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: `explicit:${happierPath}`,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
});

test('macos wsrepl lima matrix wrapper autoupdate mode installs even when guest version matches (dev worktree safety)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-always-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const stdinLog = join(logDir, 'node.stdin.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  # Guest reports the same semantic version as the worktree, but may be a different commit/build.',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" ]]; then',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" || ( "${1:-}" == "--input-type=module" && "${2:-}" == "-" ) || ( "${1:-}" == "--input-type" && "${2:-}" == "module" && "${3:-}" == "-" ) ]]; then',
      `  echo "===stdin-begin===" >> ${JSON.stringify(join(logDir, 'node.stdin.log'))}`,
      `  cat >> ${JSON.stringify(join(logDir, 'node.stdin.log'))} || true`,
      `  echo "\\n===stdin-end===\\n" >> ${JSON.stringify(join(logDir, 'node.stdin.log'))}`,
      '  payload="${WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR:-}"',
      '  if [[ -z "$payload" ]]; then',
      '    echo "missing WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR" >&2',
      '    exit 2',
      '  fi',
      '  mkdir -p "$payload"',
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]; then echo "unexpected daemon start-sync" >&2; exit 12; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
      '  chmod +x "$payload/happier"',
      '  exit 0',
    'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_auto_always',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(
    await fileExists(join(homeDir, '.happier', 'wsrepl-dev', 'payload', 'wsrepl-build.json')),
    true,
    'expected autoupdate to install a wsrepl build marker into the guest payload',
  );

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl copy/, 'expected autoupdate to copy a payload into the VM even if versions match');

  const stdin = await readFile(stdinLog, 'utf8');
  assert.ok(stdin.includes('===stdin-begin==='), 'expected wrapper to run at least one node stdin helper');
});

test('macos wsrepl lima matrix wrapper autoupdate mode does not require a preinstalled guest happier on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-no-happier-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  // Intentionally do NOT create a `happier` stub in PATH. Autoupdate should still install and validate.

  const nodePath = join(binDir, 'node');
  await writeScript(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      nodeLogPath: nodeLog,
      includeDaemonControl: true,
      includeVmPayloadBuilder: true,
      vmPayloadHappierVersion: '0.1.0',
      passthroughMode: 'silent',
    }),
  );

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_auto_no_happier',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl copy/);
});

test('macos wsrepl lima matrix wrapper autoupdate mode installs the current payload for every VM in scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-autoupdate-multi-vm-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');
  const primaryVm = 'happy-wsrepl';
  const extraVm = 'happy-wsrepl-2';

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeScript(
    nodePath,
    buildPlaywrightHarnessNodeScript({
      nodeLogPath: nodeLog,
      includeDaemonControl: true,
      includeVmPayloadBuilder: true,
      vmPayloadHappierVersion: '0.1.0',
      passthroughMode: 'silent',
    }),
  );

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    instance="${1:-}"',
      '    shift || true',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    guest_home="${HOME}/guest-homes/${instance}"',
      '    mkdir -p "$guest_home"',
      '    exec env HOME="$guest_home" LIMA_INSTANCE="$instance" "$@"',
      '    ;;',
      '  copy)',
      '    recursive=0',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -r|--recursive) recursive=1; shift ;;',
      '        --backend=*) shift ;;',
      '        --backend) shift 2 ;;',
      '        -v|--verbose) shift ;;',
      '        *) break ;;',
      '      esac',
      '    done',
      '    if [[ $# -lt 2 ]]; then exit 2; fi',
      '    src="$1"; dst="$2";',
      '    dst="${dst#*:}"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      mkdir -p "$dst"',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      mkdir -p "$(dirname "$dst")"',
      '      cp -a "$src" "$dst"',
      '    fi',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_auto_multi_vm',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'autoupdate',
    WSREPL_QA_VM_BUN_TARGET: 'bun-linux-arm64',
  };

  const res = spawnSync('bash', [scriptPath, primaryVm, extraVm], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(
    await fileExists(join(homeDir, 'guest-homes', primaryVm, '.happier', 'wsrepl-dev', 'payload', 'wsrepl-build.json')),
    true,
    'expected autoupdate payload for primary VM',
  );
  assert.equal(
    await fileExists(join(homeDir, 'guest-homes', extraVm, '.happier', 'wsrepl-dev', 'payload', 'wsrepl-build.json')),
    true,
    'expected autoupdate payload for extra VM',
  );

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, new RegExp(`limactl copy .* ${primaryVm}:`));
  assert.match(limactlOut, new RegExp(`limactl copy .* ${extraVm}:`));
});

test('macos wsrepl lima matrix wrapper can derive HAPPIER_QA_STEPS_JSON from host/vm machine ids when omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-steps-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      log_path="${HOME}/daemon.log"',
      '      printf "%s\\n" "stub daemon log" > "$log_path"',
      '      echo "$log_path"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  src="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\"),\\"sourceMachineId\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$src\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_2',
    // Intentionally omit HAPPIER_QA_STEPS_JSON; wrapper should derive it from these ids.
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    // Name-based selection is supported (via explicit HAPPIER_QA_STEPS_JSON), but the wrapper's
    // derived default must be deterministic: prefer explicit ids to avoid ambiguous glob matches
    // when multiple VMs are registered in the same account.
    WSREPL_QA_HOST_MACHINE_NAME_PATTERN: 'host-machine-name-1',
    WSREPL_QA_VM_MACHINE_NAME_PATTERN: 'vm-machine-name-1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const meta = await readPlaywrightMetaFromReportRoot(reportDir);
  const stepsJson = JSON.parse(meta.stepsJson);
  assert.deepEqual(stepsJson, [
    { targetMachineId: 'machine_vm_1', strategy: 'transfer_snapshot' },
    { targetMachineId: 'machine_host_1', strategy: 'transfer_snapshot' },
    { targetMachineId: 'machine_vm_1', strategy: 'sync_changes' },
  ]);
  assert.equal(meta.sourceMachineId, 'machine_host_1');

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.parameters.targetMachineIds, ['machine_vm_1', 'machine_host_1', 'machine_vm_1']);
  assert.deepEqual(summary.parameters.targetMachineNamePatterns, []);
});

test('macos wsrepl lima matrix wrapper default vm machine name pattern is substring-friendly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-steps-default-vm-pattern-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const nodeLog = join(logDir, 'node.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeScript(
    nodePath,
    buildPlaywrightHarnessNodeScript({ nodeLogPath: nodeLog, includeDaemonControl: true, passthroughMode: 'silent' }),
  );

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_3',
    // Intentionally omit WSREPL_QA_VM_MACHINE_NAME_PATTERN; wrapper should derive it from VM name.
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_MACHINE_NAME_PATTERN: 'host-machine-name-1',
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const meta = await readPlaywrightMetaFromReportRoot(reportDir);
  const stepsJson = JSON.parse(meta.stepsJson);
  assert.deepEqual(stepsJson, [
    { targetMachineId: 'machine_vm_1', strategy: 'transfer_snapshot' },
    { targetMachineId: 'machine_host_1', strategy: 'transfer_snapshot' },
    { targetMachineId: 'machine_vm_1', strategy: 'sync_changes' },
  ]);
});

test('macos wsrepl lima matrix wrapper retries host daemon start on transient failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-daemon-retries-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostLog = join(logDir, 'host.log');
  const daemonLogPath = join(logDir, 'daemon.log');
  await writeFile(daemonLogPath, '[00:00:00.000] daemon log\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      `echo "happier $*" >> ${JSON.stringify(hostLog)}`,
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      `        count_path=${JSON.stringify(join(logDir, 'start-count.txt'))}`,
      '        count="0"',
      '        if [[ -f "$count_path" ]]; then count="$(cat "$count_path" 2>/dev/null || echo 0)"; fi',
      '        if [[ "$count" -lt 2 ]]; then',
      '          echo "Daemon is not running"',
      '        else',
      '          echo "Daemon is running"',
      '        fi',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      // Fail the first start attempt and succeed on the second. This simulates transient flake.
      `        count_path=${JSON.stringify(join(logDir, 'start-count.txt'))}`,
      '        count="0"',
      '        if [[ -f "$count_path" ]]; then count="$(cat "$count_path" 2>/dev/null || echo 0)"; fi',
      '        count="$((count + 1))"',
      '        echo "$count" > "$count_path"',
      '        if [[ "$count" -lt 2 ]]; then',
      '          echo "EADDRINUSE: address already in use" >&2',
      '          exit 1',
      '        fi',
      '        echo "daemon started"',
      '        exit 0',
      '        ;;',
      '      *)',
      '        exit 0',
      '        ;;',
      '    esac',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then echo "v99.0.0-test"; exit 0; fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell|start|stop|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_host_retry_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_DAEMON_START_RETRIES: '2',
    WSREPL_QA_DAEMON_START_RETRY_DELAY_MS: '1',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const logged = await readFile(hostLog, 'utf8').catch(() => '');
  const starts = logged.split('\n').filter((line) => line.includes('happier daemon start')).length;
  assert.equal(starts, 2, `expected wrapper to retry host daemon start; log:\n${logged}`);
});

test('macos wsrepl lima matrix wrapper rebuilds the CLI when host daemon status reports a missing package-dist entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-missing-dist-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const hostLog = join(logDir, 'host.log');
  const yarnLog = join(logDir, 'yarn.log');
  const buildMarker = join(logDir, 'cli-built.marker');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(hostLog)}`,
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "$script" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  cmd="${1:-}"',
      '  shift || true',
      '  case "$cmd" in',
      '    --version)',
      '      echo "0.1.0"',
      '      exit 0',
      '      ;;',
      '    daemon)',
      '      sub="${1:-}"',
      '      shift || true',
      '      case "$sub" in',
      '        stop)',
      '          printf "1" > "$stopped_marker"',
      '          exit 0',
      '          ;;',
      '        start|start-sync)',
      '          rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '          echo "start-env direct-peer-enabled=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-}" >> ' +
        JSON.stringify(hostLog),
      '          echo "start-env direct-peer-bind-port=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}" >> ' +
        JSON.stringify(hostLog),
      '          echo "start-env direct-peer-hosts=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-}" >> ' +
        JSON.stringify(hostLog),
      '          echo "start-env direct-peer-server=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}" >> ' +
        JSON.stringify(hostLog),
      '          echo "start-env cli-subprocess-tsx-fallback=${HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK:-}" >> ' +
        JSON.stringify(hostLog),
      '          exit 0',
      '          ;;',
      '        status)',
      '          if [[ -f "$stopped_marker" ]]; then',
      '            echo "Daemon is not running"',
      '            exit 0',
      '          fi',
      `          if [[ -f ${JSON.stringify(buildMarker)} ]]; then`,
      '            cat <<EOF',
      '🩺 Happier CLI Doctor',
      '',
      '🤖 Daemon Status',
      '✓ Daemon is running',
      '  Machine ID: machine_host_1',
      '',
      '📄 Daemon State:',
      'Location: /tmp/daemon.state.json',
      '{',
      '  "machineId": "machine_host_1"',
      '}',
      '',
      '✅ Doctor diagnosis complete!',
      'EOF',
      '          else',
      "            echo \"Error: Daemon packaged entrypoint is missing: /Users/leeroy/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs\"",
      '          fi',
      '          exit 0',
      '          ;;',
      '        logs)',
      '          echo "/tmp/daemon.log"',
      '          exit 0',
      '          ;;',
      '        *)',
      '          exit 0',
      '          ;;',
      '      esac',
      '      ;;',
      '    install)',
      '      exit 0',
      '      ;;',
      '    *)',
      '      exit 0',
      '      ;;',
      '  esac',
      'fi',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\\":\\"stub\\"}" > "$out/meta.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "yarn $*" >> ${JSON.stringify(yarnLog)}`,
      'if [[ "${1:-}" == "workspace" && "${2:-}" == "@happier-dev/cli" && "${3:-}" == "build" ]]; then',
      `  printf 'built\\n' > ${JSON.stringify(buildMarker)}`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(yarnPath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|shell|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
	  const env = {
	    ...process.env,
	    HOME: homeDir,
	    LIMA_HOME: limaHome,
	    // Ensure we exercise the wrapper's `worktree_node` fallback (no real `happier` on PATH),
	    // while still providing core system tools like `python3`.
	    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_missing_dist_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    WSREPL_QA_VM_DIRECT_PEER_BIND_PORT: '13377',
    WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const yarnOut = await readFile(yarnLog, 'utf8');
  assert.match(yarnOut, /yarn workspace @happier-dev\/cli build/);

  const hostOut = await readFile(hostLog, 'utf8');
  assert.match(hostOut, /happier\.mjs.*daemon status/);
  assert.match(hostOut, /start-env direct-peer-enabled=true/);
  const bindPortMatches = hostOut.match(/start-env direct-peer-bind-port=(\d+)/g) ?? [];
  assert.equal(bindPortMatches.length, 2, hostOut);
  assert.equal(bindPortMatches[0], bindPortMatches[1], hostOut);
  assert.match(hostOut, /start-env direct-peer-hosts=.*host\.lima\.internal/);
  assert.match(hostOut, /start-env cli-subprocess-tsx-fallback=1/);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 0);
  assert.equal(summary.parameters.hostMachineId, 'machine_host_1');
  assert.equal(summary.parameters.vmMachineId, 'machine_vm_1');
});

test('macos wsrepl lima matrix wrapper fails closed when host daemon status stays on a missing package-dist entrypoint after rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-missing-dist-hardfail-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const yarnLog = join(logDir, 'yarn.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "$script" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  cmd="${1:-}"',
      '  shift || true',
      '  case "$cmd" in',
      '    --version)',
      '      echo "0.1.0"',
      '      exit 0',
      '      ;;',
      '    daemon)',
      '      sub="${1:-}"',
      '      shift || true',
      '      case "$sub" in',
      '        stop)',
      '          printf "1" > "$stopped_marker"',
      '          exit 0',
      '          ;;',
      '        start|start-sync)',
      '          rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      "          echo \"Error: Daemon packaged entrypoint is missing: /Users/leeroy/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs\" >&2",
      '          exit 1',
      '          ;;',
      '        status)',
      '          if [[ -f "$stopped_marker" ]]; then',
      '            echo "Daemon is not running"',
      '            exit 0',
      '          fi',
      "          echo \"Error: Daemon packaged entrypoint is missing: /Users/leeroy/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs\"",
      '          exit 0',
      '          ;;',
      '        logs)',
      '          echo "/tmp/daemon.log"',
      '          exit 0',
      '          ;;',
      '        *)',
      '          exit 0',
      '          ;;',
      '      esac',
      '      ;;',
      '    install)',
      '      exit 0',
      '      ;;',
      '    *)',
      '      exit 0',
      '      ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "yarn $*" >> ${JSON.stringify(yarnLog)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(yarnPath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|shell|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected nonzero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.notEqual(summary.status, 0, `expected nonzero summary.status (got ${summary.status})`);

  const yarnOut = await readFile(yarnLog, 'utf8').catch(() => '');
  assert.match(yarnOut, /yarn workspace @happier-dev\/cli build/);
});

test('macos wsrepl lima matrix wrapper seeds server-routed max-bytes env for the host daemon from server /v1/features when unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-seed-max-bytes-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const curlPath = join(binDir, 'curl');
  await writeFile(
    curlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'args=("$@")',
      'for arg in "${args[@]}"; do',
      '  if [[ "$arg" == *"/v1/features"* ]]; then',
      '    echo \'{"capabilities":{"machines":{"transfer":{"serverRouted":{"maxBytes":4096}}}}}\'',
      '    exit 0',
      '  fi',
      'done',
      'echo "unexpected curl args: $*" >&2',
      'exit 2',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(curlPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "$script" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  cmd="${1:-}"',
      '  shift || true',
      '  case "$cmd" in',
      '    --version)',
      '      echo "0.1.0"',
      '      exit 0',
      '      ;;',
      '    daemon)',
      '      sub="${1:-}"',
      '      shift || true',
      '      case "$sub" in',
      '        start|start-sync)',
      '          echo "MAX_BYTES=${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-}"',
      '          echo "DIRECT_PEER_SERVER_ENABLED=${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-}"',
      '          echo "DIRECT_PEER_FEATURE_ENABLED=${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-}"',
      '          echo "Daemon is not running" >&2',
      '          exit 1',
      '          ;;',
      '        status)',
      '          echo "Daemon is not running"',
      '          exit 0',
      '          ;;',
      '        logs)',
      '          echo "/tmp/daemon.log"',
      '          exit 0',
      '          ;;',
      '        stop)',
      '          exit 0',
      '          ;;',
      '        *)',
      '          exit 0',
      '          ;;',
      '      esac',
      '      ;;',
      '    install)',
      '      exit 0',
      '      ;;',
      '    *)',
      '      exit 0',
      '      ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info|shell|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:/usr/bin:/bin`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, `expected nonzero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  const reportRoot = typeof summary.reportRoot === 'string' && summary.reportRoot.length > 0 ? summary.reportRoot : reportDir;
  const startOut = await readFile(join(reportRoot, 'daemon', 'host.daemon.start.txt'), 'utf8');
  assert.match(startOut, /MAX_BYTES=4096/);
  assert.match(startOut, /DIRECT_PEER_SERVER_ENABLED=true/);
  assert.match(startOut, /DIRECT_PEER_FEATURE_ENABLED=true/);
});

test('macos wsrepl lima matrix wrapper fails closed when guest wsrepl build marker mismatches the worktree (require mode)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-marker-mismatch-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  await mkdir(join(homeDir, '.happier', 'wsrepl-dev', 'payload'), { recursive: true });
  await writeFile(join(homeDir, '.happier', 'wsrepl-dev', 'payload', 'wsrepl-build.gitrev'), 'deadbeef\n', 'utf8');
  await writeFile(join(homeDir, '.happier', 'wsrepl-dev', 'payload', 'wsrepl-build.version'), '0.1.0\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" ]]; then',
	      '  exit 0',
	      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(nodePath, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf8');
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      '# --- happier port forwards (managed) ---',
      'portForwards:',
      '  - guestPortRange: [13000, 13001]',
      '    hostPortRange:  [13000, 13001]',
      '# --- /happier port forwards ---',
      'EOF',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec "$@"',
      '    ;;',
      '  start|stop|list|info|copy)',
      '    exit 0',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'auto',
    HAPPIER_QA_SESSION_ID: 'sess_marker_mismatch_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'require',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0);
  assert.match(`${res.stdout}\n${res.stderr}`, /build marker does not match|guest wsrepl build marker/i);
});

test('macos wsrepl lima matrix wrapper fails fast when HAPPIER_QA_SESSION_PATH is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-missing-path-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(nodePath, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf8');
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(limactlPath, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf8');
  await chmod(limactlPath, 0o755);

  const missingPath = join(root, 'does-not-exist');
  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_3',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_SESSION_PATH: missingPath,
    HAPPIER_QA_HEADLESS: '1',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 2, `expected exit 2\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /HAPPIER_QA_SESSION_PATH/i);
  assert.match(res.stderr, /does not exist/i);
});

test('macos wsrepl lima matrix wrapper prefers default large-repo fixture under HOME when session path is unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-default-large-repo-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const safeLargeRepoPath = join(homeDir, 'wsrepl-qa-fixtures', 'large-repo-k8s');
  await mkdir(safeLargeRepoPath, { recursive: true });

  // Keep the legacy fixture location present as well to ensure the wrapper prefers the safe path
  // (Lima guests can fail to traverse host `chmod 700` parents like `.happier`).
  const legacyLargeRepoPath = join(homeDir, '.happier', 'wsrepl-qa-fixtures', 'large-repo-k8s');
  await mkdir(legacyLargeRepoPath, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');
  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "happier $*" >> ${JSON.stringify(happierLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "daemon" ]]; then',
      '  sub="${3:-}"',
      '  case "$sub" in',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "Daemon started successfully"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "HAPPIER_QA_SESSION_PATH=${HAPPIER_QA_SESSION_PATH:-}" > "$out/env.txt"',
      '  printf "%s\\n" "stub ok" > "$out/runner.log"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\")}" > "$out/meta.json"',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const envTxt = await readFile(join(reportDir, 'playwright', 'attempt-01', 'env.txt'), 'utf8');
  assert.ok(
    envTxt.includes(`HAPPIER_QA_SESSION_PATH=${safeLargeRepoPath}`),
    `expected wrapper to default HAPPIER_QA_SESSION_PATH to ${safeLargeRepoPath} (got: ${envTxt})`,
  );
});

test('macos wsrepl lima matrix wrapper writes a nonzero summary status when terminated mid-playwright', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-sigterm-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

	  const happierPath = join(binDir, 'happier');
	  await writeFile(
	    happierPath,
	    [
	      '#!/usr/bin/env bash',
	      'set -euo pipefail',
	      'stopped_marker="${HOME}/.host-daemon-stopped"',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
	      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
	      '  printf "1" > "$stopped_marker"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
	      '  if [[ -f "$stopped_marker" ]]; then',
	      '    echo "Daemon is not running"',
	      '    exit 0',
	      '  fi',
	      '  echo "Daemon is running"',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
	      '  echo ""',
	      '  exit 0',
	      'fi',
	      'if [[ "${1:-}" == "--version" ]]; then',
	      '  echo "0.1.0"',
	      '  exit 0',
	      'fi',
	      'echo "Daemon is running"',
	      'exit 0',
	    ].join('\n') + '\n',
	    'utf8',
	  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\\":\\"[]\\"}" > "$out/meta.json"',
      '  # Keep the process alive so the wrapper receives SIGTERM mid-run.',
      '  sleep 5',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_DAEMON_WATCHDOG: '1',
    WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS: '50',
  };

  const child = spawn('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  child.kill('SIGTERM');

  const exitCode = await new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise(code ?? (signal ? 128 : null)));
  });

  // On POSIX shells, SIGTERM typically yields 143 (128 + 15).
  assert.ok(exitCode !== 0, `expected nonzero exit (got ${exitCode})`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.notEqual(summary.status, 0, `expected nonzero summary.status (got ${summary.status})`);
});

test('macos wsrepl lima matrix wrapper leaves a top-level summary.json even when SIGKILLed mid-playwright', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-sigkill-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const sessionDir = join(root, 'session');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "stop" ]]; then',
      '  printf "1" > "$stopped_marker"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  if [[ -f "$stopped_marker" ]]; then',
      '    echo "Daemon is not running"',
      '    exit 0',
      '  fi',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      '  echo ""',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'echo "Daemon is running"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"sessionId\\":\\"sess_created_1\\",\\"sessionPath\\":\\"${HAPPIER_QA_SESSION_PATH:-}\\",\\"stepsJson\\\":\\"[]\\"}" > "$out/meta.json"',
      '  # Keep the process alive so the wrapper can be SIGKILLed mid-run (untrappable).',
      '  sleep 2',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_QA_SESSION_PATH: sessionDir,
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
  };

  const child = spawn('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  assert.equal(child.exitCode, null, 'expected wrapper to still be running before SIGKILL');

  child.kill('SIGKILL');

  const exitCode = await new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise(code ?? (signal ? 128 : null)));
  });
  assert.ok(exitCode !== 0, `expected nonzero exit (got ${exitCode})`);

  const summaryPath = join(reportDir, 'summary.json');
  assert.equal(await fileExists(summaryPath), true, 'expected wrapper to leave summary.json even when SIGKILLed');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.notEqual(summary.status, 0, `expected nonzero summary.status (got ${summary.status})`);
});

test('macos wsrepl lima matrix wrapper records early-abort failure metadata before preflight setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-early-abort-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const datePath = join(binDir, 'date');
  await writeFile(
    datePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `state_file=${JSON.stringify(join(binDir, '.date-call-count'))}`,
      'count=0',
      'if [[ -f "$state_file" ]]; then',
      '  count="$(cat "$state_file")"',
      'fi',
      'count="$((count + 1))"',
      'printf "%s\\n" "$count" > "$state_file"',
      'if [[ "$count" == "2" ]]; then',
        '  echo "cho: command not found" >&2',
        '  exit 127',
      'fi',
      'echo "2026-03-27T15:15:00Z"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(datePath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 127, `expected early abort exit 127\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 127);
  assert.equal(summary.failureStage, 'early_abort');
  assert.equal(summary.failureReason, 'command_not_found');
});

test('macos wsrepl lima matrix wrapper can force host happier source to worktree_node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-source-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const runtimeLog = join(logDir, 'happier.runtime.log');
  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.path.log');
  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "path-happier $*" >> ${JSON.stringify(happierLog)}`,
      'echo "path stub ok"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
	      'if [[ "$script" == *"/apps/cli/bin/happier.mjs" ]]; then',
	      '  cmd="${1:-}"',
	      '  sub="${2:-}"',
	      '  stopped_marker="${HOME}/.host-daemon-stopped"',
	      '  if [[ "$cmd" == "--version" ]]; then',
	      '    echo "0.1.0"',
	      '    exit 0',
	      '  fi',
      '  if [[ "$cmd" == "install" ]]; then',
      '    exit 0',
      '  fi',
	      '  if [[ "$cmd" == "daemon" ]]; then',
	      '    case "$sub" in',
	      '      stop)',
	      '        printf "1" > "$stopped_marker"',
	      '        exit 0',
	      '        ;;',
	      '      start|start-sync)',
	      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
	      '        echo "Daemon started successfully"',
	      '        exit 0',
	      '        ;;',
	      '      status)',
	      '        if [[ -f "$stopped_marker" ]]; then',
	      '          echo "Daemon is not running"',
	      '          exit 0',
	      '        fi',
	      '        echo "Waiting for credentials"',
	      '        exit 1',
      '        ;;',
      '      logs)',
      '        log_path="${HOME}/daemon.log"',
      '        printf "%s\\n" "stub daemon log" > "$log_path"',
      '        echo "$log_path"',
      '        exit 0',
      '        ;;',
      '    esac',
      '  fi',
      '  exit 0',
      'fi',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  sid="sess_created_1"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  python3 - "$out" "$steps" "${HAPPIER_QA_SESSION_PATH:-}" "$sid" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, steps, session_path, sid = sys.argv[1:]',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": sid.strip() or None,',
      '  "sessionPath": session_path,',
      '  "stepsJson": steps,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == --name=* ]]; then',
      '        name="${1#--name=}"',
      '        shift',
      '        continue',
      '      fi',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    if [[ -z "$name" ]]; then',
      '      name="happy-wsrepl"',
      '    fi',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL: '1',
    WSREPL_QA_HOST_HAPPIER_SOURCE: 'worktree_node',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.happier.resolve.json')), true);

  const resolvePayload = JSON.parse(await readFile(join(reportDir, 'daemon', 'host.happier.resolve.json'), 'utf8'));
  assert.equal(resolvePayload.kind, 'wsrepl_host_happier_resolution');
  assert.equal(resolvePayload.source, 'worktree_node');
  assert.equal(resolvePayload.hostHappierKind, 'worktree_node');
  assert.ok(
    Array.isArray(resolvePayload.invocation) && resolvePayload.invocation.join(' ').includes('apps/cli/bin/happier.mjs'),
    `expected invocation to mention apps/cli/bin/happier.mjs (got ${JSON.stringify(resolvePayload.invocation)})`,
  );

  const nodeInvocations = await readFile(nodeLog, 'utf8');
  assert.ok(
    nodeInvocations.includes('apps/cli/bin/happier.mjs daemon'),
    `expected node to be used for host daemon (got ${nodeInvocations})`,
  );

  assert.equal(await fileExists(runtimeLog), false, 'expected stack runtime happier not to be invoked');
  assert.equal(await fileExists(happierLog), false, 'expected PATH happier not to be invoked');
});

test('macos wsrepl lima matrix wrapper defaults host happier source to PATH when no stack runtime is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-host-default-source-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const reportDir = join(root, 'reports');
  const logDir = join(root, 'logs');
  const limaHome = join(homeDir, '.lima');

  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const runtimeLog = join(logDir, 'happier.runtime.log');
  const nodeLog = join(logDir, 'node.log');
  const happierLog = join(logDir, 'happier.path.log');
  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "path-happier $*" >> ${JSON.stringify(happierLog)}`,
      'stopped_marker="${HOME}/.host-daemon-stopped"',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" ]]; then',
      '  sub="${2:-}"',
      '  case "$sub" in',
      '    start|start-sync)',
      '      rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '      echo "daemon started"',
      '      exit 0',
      '      ;;',
      '    stop)',
      '      printf "1" > "$stopped_marker"',
      '      exit 0',
      '      ;;',
      '    status)',
      '      if [[ -f "$stopped_marker" ]]; then',
      '        echo "Daemon is not running"',
      '        exit 0',
      '      fi',
      '      echo "Daemon is running"',
      '      exit 0',
      '      ;;',
      '    logs)',
      '      echo "/tmp/daemon.log"',
      '      exit 0',
      '      ;;',
      '  esac',
      '  exit 0',
      'fi',
      'echo "path stub ok"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *"/apps/cli/bin/happier.mjs" ]]; then',
      '  cmd="${1:-}"',
      '  sub="${2:-}"',
      '  stopped_marker="${HOME}/.host-daemon-stopped"',
      '  if [[ "$cmd" == "--version" ]]; then',
      '    echo "0.1.0"',
      '    exit 0',
      '  fi',
      '  if [[ "$cmd" == "install" ]]; then',
      '    exit 0',
      '  fi',
      '  if [[ "$cmd" == "daemon" ]]; then',
      '    case "$sub" in',
      '      stop)',
      '        printf "1" > "$stopped_marker"',
      '        exit 0',
      '        ;;',
      '      start|start-sync)',
      '        rm -f "$stopped_marker" >/dev/null 2>&1 || true',
      '        echo "Daemon started successfully"',
      '        exit 0',
      '        ;;',
      '      status)',
      '        if [[ -f "$stopped_marker" ]]; then',
      '          echo "Daemon is not running"',
      '          exit 0',
      '        fi',
      '        echo "Waiting for credentials"',
      '        exit 1',
      '        ;;',
      '      logs)',
      '        log_path="${HOME}/daemon.log"',
      '        printf "%s\\n" "stub daemon log" > "$log_path"',
      '        echo "$log_path"',
      '        exit 0',
      '        ;;',
      '    esac',
      '  fi',
      '  exit 0',
      'fi',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  if [[ -z "$out" ]]; then',
      '    echo "missing HAPPIER_QA_OUTDIR" >&2',
      '    exit 2',
      '  fi',
      '  steps="${HAPPIER_QA_STEPS_JSON:-}"',
      '  if [[ -z "$steps" ]]; then',
      '    echo "missing HAPPIER_QA_STEPS_JSON" >&2',
      '    exit 3',
      '  fi',
      '  sid="sess_created_1"',
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  python3 - "$out" "$steps" "${HAPPIER_QA_SESSION_PATH:-}" "$sid" <<\'PY\'',
      'import json',
      'import sys',
      'from pathlib import Path',
      '',
      'out_dir, steps, session_path, sid = sys.argv[1:]',
      'payload = {',
      '  "kind": "stub",',
      '  "outDir": out_dir,',
      '  "sessionId": sid.strip() or None,',
      '  "sessionPath": session_path,',
      '  "stepsJson": steps,',
      '}',
      'Path(out_dir, "meta.json").write_text(json.dumps(payload), encoding="utf-8")',
      'PY',
      '  echo "stub ok"',
      '  exit 0',
      'fi',
      'echo "stub node passthrough"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(nodePath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  create)',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      if [[ "$1" == --name=* ]]; then',
      '        name="${1#--name=}"',
      '        shift',
      '        continue',
      '      fi',
      '      if [[ "$1" == "--name" ]]; then',
      '        name="$2"',
      '        shift 2',
      '        continue',
      '      fi',
      '      shift || true',
      '    done',
      '    if [[ -z "$name" ]]; then',
      '      name="happy-wsrepl"',
      '    fi',
      '    mkdir -p "${LIMA_HOME:-$HOME/.lima}/${name}"',
      '    cat > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml" <<EOF',
      'memory: "4GiB"',
      'EOF',
      '    exit 0',
      '    ;;',
      '  stop|start|list|info)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then shift; fi',
      '    exec env PATH=/usr/bin:/bin "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'wsrepl-lima-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STACK_NAME: 'stack-test',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'skip',
    WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL: '1',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-wsrepl'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.equal(await fileExists(join(reportDir, 'daemon', 'host.happier.resolve.json')), true);

  const resolvePayload = JSON.parse(await readFile(join(reportDir, 'daemon', 'host.happier.resolve.json'), 'utf8'));
  assert.equal(resolvePayload.kind, 'wsrepl_host_happier_resolution');
  assert.ok(
    resolvePayload.source === 'auto' || resolvePayload.source === 'path',
    `expected source to be auto/path (got ${JSON.stringify(resolvePayload.source)})`,
  );
  assert.equal(resolvePayload.hostHappierKind, 'path');

  const nodeInvocations = await readFile(nodeLog, 'utf8');
  assert.equal(nodeInvocations.includes('apps/cli/bin/happier.mjs daemon'), false, `expected node not to be used for host daemon (got ${nodeInvocations})`);

  assert.equal(await fileExists(runtimeLog), false, 'expected stack runtime happier not to be invoked');
  const pathInvocations = await readFile(happierLog, 'utf8');
  assert.ok(pathInvocations.includes('path-happier daemon start'), `expected PATH happier to be invoked (got ${pathInvocations})`);
});
