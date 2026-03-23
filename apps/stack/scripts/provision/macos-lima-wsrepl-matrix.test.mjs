import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
      '  mkdir -p "$out/steps/step-01"',
      '  printf "%s\\n" "{\\"ok\\":true}" > "$out/steps/step-01/result.json"',
      '  printf "%s\\n" "{\\"kind\\":\\"stub\\",\\"outDir\\":\\"$out\\",\\"stepsJson\\":$(python3 -c \"import json,sys; print(json.dumps(sys.argv[1]))\" \"$steps\")}" > "$out/meta.json"',
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
    HAPPIER_QA_SESSION_ID: 'sess_test_1',
    HAPPIER_QA_STEPS_JSON: JSON.stringify([{ targetMachineId: 'machine_target_1', strategy: 'sync_changes' }]),
    WSREPL_QA_HOST_MACHINE_ID: 'machine_host_1',
    WSREPL_QA_VM_MACHINE_ID: 'machine_vm_1',
    HAPPIER_UI_URL: 'http://localhost:19000/?server=http%3A%2F%2Flocalhost%3A53288',
    HAPPIER_QA_HEADLESS: '1',
    WSREPL_QA_VM_HAPPIER_MODE: 'require',
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

  const playwrightDir = join(reportDir, 'playwright');
  assert.equal(await fileExists(join(playwrightDir, 'runner.log')), true);
  assert.equal(await fileExists(join(playwrightDir, 'meta.json')), true, 'expected Playwright harness meta.json under report root');

  assert.equal(await fileExists(join(reportDir, 'summary.json')), true, 'expected summary.json to be written by wrapper');

  const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'wsrepl_lima_matrix_wrapper');
  assert.equal(summary.status, 0);
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

  const entries = await readdir(join(playwrightDir, 'steps'));
  assert.deepEqual(entries, ['step-01']);
});

test('macos wsrepl lima matrix wrapper fails closed when guest happier version does not match worktree (require mode)', async () => {
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
  assert.match(`${res.stdout}\n${res.stderr}`, /guest Happier CLI version does not match/i);
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
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
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
      '    mkdir -p "$dst"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      cp -a "$src" "$dst/"',
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
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'exit 0\' > "$payload/happier"',
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
      '    mkdir -p "$dst"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      cp -a "$src" "$dst/"',
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
      '  printf "%s\\n" \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'if [[ "${1:-}" == "--version" ]]; then echo 0.1.0; exit 0; fi\' \'if [[ "${1:-}" == "daemon" ]]; then exit 0; fi\' \'exit 0\' > "$payload/happier"',
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
      '    mkdir -p "$dst"',
      '    if [[ "$recursive" == "1" ]]; then',
      '      cp -a "$src" "$dst/"',
      '    else',
      '      cp -a "$src" "$dst/"',
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

  const meta = JSON.parse(await readFile(join(reportDir, 'playwright', 'meta.json'), 'utf8'));
  const stepsJson = JSON.parse(meta.stepsJson);
  assert.deepEqual(stepsJson, [
    { targetMachineId: 'machine_vm_1', strategy: 'transfer_snapshot' },
    { targetMachineId: 'machine_host_1', strategy: 'sync_changes' },
  ]);
  assert.equal(meta.sourceMachineId, 'machine_host_1', 'expected wrapper to set HAPPIER_QA_SOURCE_MACHINE_ID to host machine id when deriving steps');
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
