import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test('macos wsrepl lima matrix wrapper writes diagnostics and forwards playwight outdir to node harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-wsrepl-matrix-'));
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
      // Simulate a host daemon dying during the Playwright run: status checks should succeed
      // during initial wrapper setup, then fail once while Playwright is running so the watchdog
      // restarts the daemon.
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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
      '  sleep 0.25',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  const runnerEnv = await readFile(join(playwrightDir, 'env.txt'), 'utf8');
  assert.match(runnerEnv, /HAPPIER_QA_STACK_NAME=stack-test/);
  assert.match(runnerEnv, /EXPO_PUBLIC_HAPPY_STORAGE_SCOPE=stack-test/);
  assert.match(runnerEnv, /EXPO_PUBLIC_HAPPY_SERVER_CONTEXT=stack/);
  assert.ok(
    runnerEnv.includes('EXPO_PUBLIC_HAPPIER_SERVER_URL=http://localhost:53288'),
    `expected runner env to include EXPO_PUBLIC_HAPPIER_SERVER_URL (got: ${runnerEnv})`,
  );
  assert.ok(
    runnerEnv.includes('HAPPIER_QA_SESSION_PATH=/Users/leeroy/Documents/Development/happier/dev'),
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
  assert.equal(summary.sessionPath, '/Users/leeroy/Documents/Development/happier/dev');
  assert.equal(summary.parameters.hostMachineId, 'machine_host_1');
  assert.equal(summary.parameters.vmMachineId, 'machine_vm_1');
  assert.equal(summary.parameters.sourceMachineId, 'machine_host_1');
  assert.deepEqual(summary.parameters.targetMachineIds, ['machine_target_1']);

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl create --name happy-wsrepl/);
  assert.match(limactlOut, /limactl info happy-wsrepl/);
  assert.match(limactlOut, /limactl list/);

  const nodeOut = await readFile(nodeLog, 'utf8');
  assert.match(nodeOut, /playwright-session-handoff-wsrepl-matrix\.mjs/);

  const happierOut = await readFile(happierLog, 'utf8');
  assert.match(happierOut, /install provider claude/);
  assert.match(happierOut, /^happier daemon start$/m, `expected wrapper to start the host daemon\n${happierOut}`);

  const entries = await readdir(join(playwrightDir, 'steps'));
  assert.deepEqual(entries, ['step-01']);
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
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  assert.equal(res.status, 1, `expected exit 1 when sessionId is missing\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 1);
  assert.equal(summary.failureStage, 'playwright');
  assert.equal(summary.failureReason, 'missing_session_id');
  assert.equal(summary.sessionId, null);
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
      // When the daemon is managed under a stack-scoped HAPPIER_HOME_DIR, status probes must
      // use that same home and active server id. Otherwise the watchdog will see "not running"
      // and restart the daemon continuously, corrupting matrix results.
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
      // Simulate the common "daemon is restarting" race: status returns exit 0 but prints
      // "Daemon is not running" once while Playwright is booting. The watchdog should not
      // restart on a single transient probe.
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
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
  await writeFile(happierPath, ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo "Daemon is running"', 'exit 0'].join('\n') + '\n', 'utf8');
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
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
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
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
      // Minimal stub: wrapper calls daemon start/stop/status/logs as best-effort diagnostics.
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "runtime-cli $*" >> ${JSON.stringify(runtimeCliLog)}`,
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "logs" ]]; then',
      `  echo ${JSON.stringify(daemonLogPath)}`,
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
      '  echo "Daemon is running"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]]; then',
      '  echo "Cannot find module \'/tmp/apps/cli/dist/index.mjs\'" >&2',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(runtimeCliPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
      'cmd="${1:-}"',
      'sub="${2:-}"',
      'if [[ "$cmd" == "daemon" && "$sub" == "start" ]]; then',
      '  echo "HAPPIER_SERVER_URL=${HAPPIER_SERVER_URL-}" >> ' + JSON.stringify(guestEnvLog),
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'sub="${2:-}"',
      'if [[ "$cmd" == "daemon" && "$sub" == "start" ]]; then',
      '  echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(hostEnvLog),
      '  echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(hostEnvLog),
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
  await mkdir(join(stackRoot, 'cli', 'servers', `stack_${stackName}__id_default`), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const accessKeyPayload = { token: 'tok_test', secret: 'sec_test' };
  const accessKeyPath = join(stackRoot, 'cli', 'servers', `stack_${stackName}__id_default`, 'access.key');
  await writeFile(accessKeyPath, JSON.stringify(accessKeyPayload) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(logDir, 'daemon.log');
  const expectedDaemonAccessKeyPath = join(homeDir, '.happier', 'servers', 'env_test', 'access.key');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      start)',
      `        if [[ -f ${JSON.stringify(expectedDaemonAccessKeyPath)} ]]; then`,
      '          echo "daemon started"',
      '          exit 0',
      '        fi',
      `        mkdir -p ${JSON.stringify(join(logDir, ''))}`,
      `        printf "%s\\n" "[DAEMON RUN] Waiting for credentials at ${expectedDaemonAccessKeyPath}..." > ${JSON.stringify(daemonLogPath)}`,
      '        echo "Failed to start daemon" >&2',
      '        exit 1',
      '        ;;',
      '      status)',
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
      'if [[ "${1:-}" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    HAPPIER_UI_URL: 'http://127.0.0.1:19000/?server=http%3A%2F%2F127.0.0.1%3A53288',
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
  assert.equal(await fileExists(expectedDaemonAccessKeyPath), true, 'expected wrapper to seed host daemon access.key');
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
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
	    LIMA_HOME: limaHome,
	    PATH: `${binDir}:${process.env.PATH ?? ''}`,
	    WSREPL_QA_OUTPUT_DIR: reportDir,
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
  const meta = JSON.parse(await readFile(join(reportDir, 'playwright', 'attempt-01', 'meta.json'), 'utf8'));
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
      '      stop|start)',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      status)',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
  const meta = JSON.parse(await readFile(join(reportDir, 'playwright', 'attempt-01', 'meta.json'), 'utf8'));
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
      '      stop|start)',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      status)',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
  await mkdir(join(stackRoot, 'cli', 'servers', `stack_${stackName}__id_default`), { recursive: true });
  await writeFile(
    join(stackRoot, 'stack.runtime.json'),
    JSON.stringify({ version: 1, ports: { server: 53288 }, expo: { webPort: 19000 }, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const accessKeyPayload = { token: 'tok_test_auto', secret: 'sec_test_auto' };
  const accessKeyPath = join(stackRoot, 'cli', 'servers', `stack_${stackName}__id_default`, 'access.key');
  await writeFile(accessKeyPath, JSON.stringify(accessKeyPayload) + '\n', 'utf8');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const daemonLogPath = join(logDir, 'daemon.log');
  const expectedDaemonAccessKeyPath = join(homeDir, '.happier', 'servers', 'env_test', 'access.key');

  const happierPath = join(binDir, 'happier');
  await writeFile(
    happierPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        exit 0',
      '        ;;',
      '      start)',
      '        if [[ -f ' + JSON.stringify(expectedDaemonAccessKeyPath) + ' ]]; then',
      '          echo "daemon started"',
      '          exit 0',
      '        fi',
      '        echo "Failed to start daemon"',
      '        echo "Latest daemon log: ' + daemonLogPath + '"',
      '        exit 1',
      '        ;;',
      '      status)',
      '        if [[ -f ' + JSON.stringify(expectedDaemonAccessKeyPath) + ' ]]; then',
      '          echo "Daemon is running"',
      '          exit 0',
      '        fi',
      '        echo "Daemon is not running"',
      '        exit 0',
      '        ;;',
      '      logs)',
      '        echo ' + JSON.stringify(daemonLogPath),
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

  await writeFile(
    daemonLogPath,
    [
      '[00:00:00.000] [DAEMON RUN] Waiting for credentials at ' + expectedDaemonAccessKeyPath + '...',
    ].join('\n') + '\n',
    'utf8',
  );

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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
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
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        exit 0',
      '        ;;',
      '      start)',
      '        echo "HAPPIER_SERVER_URL=${HAPPIER_SERVER_URL-}" >> ' + JSON.stringify(envLog),
      '        echo "HAPPIER_HOME_DIR=${HAPPIER_HOME_DIR-}" >> ' + JSON.stringify(envLog),
      '        echo "HAPPIER_ACTIVE_SERVER_ID=${HAPPIER_ACTIVE_SERVER_ID-}" >> ' + JSON.stringify(envLog),
      '        echo "daemon started"',
      '        exit 0',
      '        ;;',
      '      status)',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'transfer_snapshot' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "node $*" >> ${JSON.stringify(nodeLog)}`,
      'script="${1:-}"',
      'shift || true',
      'if [[ "$script" == *playwright-session-handoff-wsrepl-matrix.mjs ]]; then',
      '  out="${HAPPIER_QA_OUTDIR:-}"',
      '  mkdir -p "$out"',
      '  # Simulate a hung runner: it would eventually exit, but wrapper should time it out first.',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_timeout_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
      '  echo "0.1.0-preview-old"',
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
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "v99.0.0-test"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-" ]]; then',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
      'if [[ "${1:-}" == "-" ]]; then',
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
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\")}" > "$out/meta.json"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_auto_no_happier',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  const meta = JSON.parse(await readFile(join(reportDir, 'playwright', 'attempt-01', 'meta.json'), 'utf8'));
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  const meta = JSON.parse(await readFile(join(reportDir, 'playwright', 'attempt-01', 'meta.json'), 'utf8'));
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
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  daemon)',
      '    sub="${1:-}"',
      '    shift || true',
      '    case "$sub" in',
      '      stop)',
      '        exit 0',
      '        ;;',
      '      logs)',
      `        echo ${JSON.stringify(daemonLogPath)}`,
      '        exit 0',
      '        ;;',
      '      status)',
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
      '      start)',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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

test('macos wsrepl lima matrix wrapper rebuilds the CLI when host daemon status reports a missing dist entrypoint', async () => {
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
      '        stop|start)',
      '          exit 0',
      '          ;;',
      '        status)',
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
      "            echo \"Error: Cannot find module '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs'\"",
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 0);
  assert.equal(summary.parameters.hostMachineId, 'machine_host_1');
  assert.equal(summary.parameters.vmMachineId, 'machine_vm_1');
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
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
  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WSREPL_QA_OUTPUT_DIR: reportDir,
    HAPPIER_QA_SESSION_ID: 'sess_test_3',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
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
      'if [[ "${1:-}" == "daemon" && "${2:-}" == "status" ]]; then',
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
      'if [[ "${1:-}" == *"/apps/cli/bin/happier.mjs" && "${2:-}" == "--version" ]]; then',
      '  echo "0.1.0"',
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

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo "Daemon is running"', 'exit 0'].join('\n') + '\n',
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
      'exit 0',
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = resolve(join(__dirname, 'macos-lima-wsrepl-matrix.sh'));
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
