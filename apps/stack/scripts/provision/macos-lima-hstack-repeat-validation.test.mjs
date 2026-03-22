import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function fileExists(path) {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

test('macos lima repeat-validation wrapper records per-run artifacts for repeated smoke runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-repeat-'));
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
  const curlLog = join(logDir, 'curl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(unamePath, ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n', 'utf8');
  await chmod(unamePath, 0o755);

  const curlPath = join(binDir, 'curl');
  await writeFile(
    curlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "curl $*" >> ${JSON.stringify(curlLog)}`,
      'out=""',
      'url=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    -o)',
      '      out="$2"',
      '      shift 2',
      '      continue',
      '      ;;',
      '    -f|-fs|-fsS|-fsSL|-s|-S|-L)',
      '      shift',
      '      continue',
      '      ;;',
      '    *)',
      '      url="$1"',
      '      shift',
      '      continue',
      '      ;;',
      '  esac',
      'done',
      'if [[ -z "$out" ]]; then',
      '  echo "missing -o output path" >&2',
      '  exit 2',
      'fi',
      'case "$url" in',
      '  *linux-ubuntu-provision.sh)',
      '    cat >"$out" <<\'EOF\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "provision $* profile=${1:-}"',
      'EOF',
      '    ;;',
      '  *linux-ubuntu-hstack-smoke.sh)',
      '    cat >"$out" <<\'EOF\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'mkdir -p "${HSTACK_SMOKE_DIR:?}"',
      'printf "%s\\n" "${HSTACK_SMOKE_DIR}" >> "${HSTACK_SMOKE_DIR}/guest-smoke-dir.log"',
      'printf "%s\\n" "${HSTACK_SMOKE_KEEP:-}" >> "${HSTACK_SMOKE_DIR}/guest-smoke-keep.log"',
      'printf "%s\\n" "${HSTACK_VERSION:-}" >> "${HSTACK_SMOKE_DIR}/guest-version.log"',
      'touch "${HSTACK_SMOKE_DIR}/smoke-ok"',
      'echo "smoke ok: ${HSTACK_SMOKE_DIR}"',
      'EOF',
      '    ;;',
      '  *)',
      '    echo "unexpected url: $url" >&2',
      '    exit 3',
      '    ;;',
      'esac',
      'chmod +x "$out"',
      'exit 0',
    ].join('\n') + '\n',
    'utf8'
  );
  await chmod(curlPath, 0o755);

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
      '    printf "%s\\n" "memory: \\"4GiB\\"" > "${LIMA_HOME:-$HOME/.lima}/${name}/lima.yaml"',
      '    exit 0',
      '    ;;',
      '  stop|start)',
      '    exit 0',
      '    ;;',
      '  shell)',
      '    while [[ $# -gt 0 && "$1" != "--" ]]; do',
      '      shift',
      '    done',
      '    if [[ "${1:-}" == "--" ]]; then',
      '      shift',
      '    fi',
      '    if [[ "${1:-}" == "env" ]]; then',
      '      shift',
      '      while [[ $# -gt 0 && "$1" == *=* ]]; do',
      '        export "$1"',
      '        shift',
      '      done',
      '      if [[ "${1:-}" == "bash" && "${2:-}" == "-lc" ]]; then',
      '        shift 2',
      '        exec bash -c "${1:-}"',
      '      fi',
      '    fi',
      '    exec "$@"',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
    ].join('\n') + '\n',
    'utf8'
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = join(__dirname, 'macos-lima-hstack-repeat-validation.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: limaHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HSTACK_RAW_BASE: 'https://example.test/apps/stack',
    HSTACK_VERSION: '0.9.0-test',
    HSTACK_REPEAT_COUNT: '2',
    HSTACK_REPEAT_OUTPUT_DIR: reportDir,
    HSTACK_PROVISION_PROFILE: 'happier',
  };

  const res = spawnSync('bash', [scriptPath, 'happy-repeat'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const summaryPath = join(reportDir, 'summary.json');
  assert.equal(await fileExists(summaryPath), true, 'expected summary.json to be written');

  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.equal(summary.vmName, 'happy-repeat');
  assert.equal(summary.repeatCount, 2);
  assert.equal(summary.runs.length, 2);
  assert.notEqual(summary.runs[0].guestSmokeDir, summary.runs[1].guestSmokeDir);

  for (const run of summary.runs) {
    assert.equal(await fileExists(run.logPath), true, `expected guest log at ${run.logPath}`);
    assert.equal(await fileExists(run.metaPath), true, `expected run metadata at ${run.metaPath}`);
    const meta = JSON.parse(await readFile(run.metaPath, 'utf8'));
    assert.equal(meta.status, 0);
    assert.equal(await fileExists(join(run.guestSmokeDir, 'smoke-ok')), true, 'expected smoke marker in preserved guest dir');
  }

  const limactlOut = await readFile(limactlLog, 'utf8');
  assert.match(limactlOut, /limactl create --name happy-repeat/);
  assert.equal((limactlOut.match(/limactl shell/g) ?? []).length, 2, 'expected two guest shell invocations');
});
