// @ts-check
// Proves the launched desktop app runs a system task through its own Rust IPC. The app does this
// by itself at open: on the main window the Personal Home bootstrap reads this computer's facts
// before anyone signs in (`apps/ui/sources/components/personalHome/bootstrap/usePersonalHomeBootstrapRuntime.tsx`
// `readFacts`, through the daemon-control owner `useLocalDaemonControl`), which runs
// `daemon.service.status.v1` through `start_system_task`, which spawns the app's bundled hsetup.
// That read is read-only only when a CLI resolves without acquisition, so the smoke points the
// shipped `HAPPIER_BOOTSTRAP_CLI_PATH` override (provenance `override`, never approved unattended)
// at a stand-in `happier` that records who ran it and answers only read-only commands.
//
// Unlike 0.2's status-only warm-up, 0.3's bootstrap goes on to install this computer's Personal
// Home automatically. The smoke keeps that offline and off the runner with two more stand-ins on
// the same shipped seams: `HAPPIER_BOOTSTRAP_SELF_HOST_SERVER_PATH` (the server binary, so nothing
// is downloaded) and a `systemctl` first on PATH (so no user unit is ever registered). Both record
// and refuse; the smoke reports what the app attempted, and fails only if a refusal was bypassed.
// No hook is added to the app: the probe observes, from outside, what the release build already does.

import fs from 'node:fs';
import path from 'node:path';

/** Every command the status read may run; anything else means the smoke mutated the computer. */
const READ_ONLY_INVOCATIONS = [['--version'], ['daemon', 'status', '--json'], ['server', 'list', '--json']];
const STATUS_READ = ['daemon', 'status', '--json'];
const POLL_INTERVAL_MS = 250;

/** A recorded command outside the read-only set: final, no amount of waiting undoes it. */
class NonReadOnlyInvocationError extends Error {}

/** A fresh computer as `happier daemon status --json` reports it (DoctorSnapshotDaemonStatusSchema). */
const FRESH_COMPUTER_STATUS = {
  server: {
    activeServerId: 'cloud',
    serverUrl: 'https://api.happier.dev',
    localServerUrl: null,
    publicServerUrl: 'https://api.happier.dev',
    webappUrl: 'https://cloud.happier.dev',
    comparableKey: null,
  },
  daemon: { running: false, pid: null, httpPort: null },
  service: { installed: false, running: false },
  auth: { authenticated: false, machineRegistered: false, machineId: null, needsAuth: true, accountId: null },
};

/** A fresh computer's `happier server list --json`: only the built-in default, which is no Home. */
const FRESH_COMPUTER_SERVERS = { activeServerId: 'cloud', servers: [] };

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Write the stand-in CLI. Each run leaves one record directory under `recordDir`, renamed into
 * place only once complete: `argv` (one argument per line) and `ancestors` (`pid<TAB>exe` from its
 * parent up to init, read from /proc). POSIX sh only: the app's environment has no node.
 * @param {{ dir: string; recordDir: string }} params
 */
export function writeStubHappierCli({ dir, recordDir }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(recordDir, { recursive: true });
  const cliPath = path.join(dir, 'happier');
  const script = `#!/bin/sh
records=${shellQuote(recordDir)}
command_line="$*"
tmp="$records/.$$.tmp"
mkdir -p "$tmp"
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$tmp/argv"
: > "$tmp/ancestors"
pid=$PPID
while [ "$pid" -gt 1 ] 2>/dev/null; do
  printf '%s\\t%s\\n' "$pid" "$(readlink "/proc/$pid/exe" 2>/dev/null)" >> "$tmp/ancestors"
  stat=$(cat "/proc/$pid/stat" 2>/dev/null) || break
  # The comm field may hold spaces and parentheses; everything after its last ") " is fixed fields.
  set -- \${stat##*) }
  pid=$2
done
mv "$tmp" "$records/$$"
case "$command_line" in
  "--version") echo '0.2.99' ;;
  "daemon status --json") echo ${shellQuote(JSON.stringify(FRESH_COMPUTER_STATUS))} ;;
  "server list --json") echo ${shellQuote(JSON.stringify(FRESH_COMPUTER_SERVERS))} ;;
  *) echo "stand-in happier: refusing non-read-only command: $command_line" >&2; exit 64 ;;
esac
`;
  fs.writeFileSync(cliPath, script, { mode: 0o755 });
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

/**
 * A stand-in that records every call like the CLI stand-in and refuses all of them (exit 1, the way
 * a session without a user manager answers `systemctl --user`): `systemctl` and the Personal Home
 * server binary. Returns the command path.
 * @param {{ dir: string; name: string; recordDir: string }} params
 */
export function writeRefusingStandIn({ dir, name, recordDir }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(recordDir, { recursive: true });
  const commandPath = path.join(dir, name);
  const script = `#!/bin/sh
records=${shellQuote(recordDir)}
tmp="$records/.$$.tmp"
mkdir -p "$tmp"
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$tmp/argv"
: > "$tmp/ancestors"
mv "$tmp" "$records/$$"
echo "stand-in ${name}: refused: $*" >&2
exit 1
`;
  fs.writeFileSync(commandPath, script, { mode: 0o755 });
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

/**
 * @typedef {{ pid: number; exe: string }} StubAncestor
 * @typedef {{ id: string; argv: string[]; ancestors: StubAncestor[] }} StubInvocation
 */

/** @param {string} recordDir @returns {StubInvocation[]} */
export function readStubInvocations(recordDir) {
  if (!fs.existsSync(recordDir)) return [];
  return fs.readdirSync(recordDir).filter((name) => !name.startsWith('.')).sort().map((id) => {
    const read = (/** @type {string} */ file) => fs.readFileSync(path.join(recordDir, id, file), 'utf8');
    const argvText = read('argv');
    return {
      id,
      argv: argvText === '' ? [] : argvText.replace(/\n$/u, '').split('\n'),
      ancestors: read('ancestors').split('\n').filter(Boolean).map((line) => {
        const [pid, exe = ''] = line.split('\t');
        return { pid: Number(pid), exe };
      }),
    };
  });
}

/** @param {string[]} a @param {string[]} b */
function sameArgv(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The verdict: a status read whose direct parent is the app's bundled hsetup and which descends
 * from the launched app, and no invocation outside the read-only set.
 * @param {{ invocations: StubInvocation[]; appPid: number; isBundledHsetup: (exe: string) => boolean }} params
 */
export function evaluateAppIpcInvocations({ invocations, appPid, isBundledHsetup }) {
  const mutating = invocations.filter((invocation) => !READ_ONLY_INVOCATIONS.some((allowed) => sameArgv(invocation.argv, allowed)));
  if (mutating.length > 0) {
    throw new NonReadOnlyInvocationError(`the app ran a command that is not read-only: ${mutating.map((invocation) => JSON.stringify(invocation.argv)).join(', ')}`);
  }
  const statusRead = invocations.find((invocation) => sameArgv(invocation.argv, STATUS_READ)
    && invocation.ancestors.some((ancestor) => ancestor.pid === appPid)
    && isBundledHsetup(invocation.ancestors[0]?.exe ?? ''));
  if (!statusRead) {
    const seen = invocations.map((invocation) => `${JSON.stringify(invocation.argv)} via ${invocation.ancestors.map((ancestor) => `${ancestor.pid}:${ancestor.exe || '?'}`).join(' <- ')}`);
    throw new Error(`no \`daemon status --json\` from the app's bundled hsetup under app pid ${appPid}; recorded: ${seen.length ? seen.join('; ') : 'none'}`);
  }
  return { statusRead, hsetupExe: statusRead.ancestors[0]?.exe ?? '' };
}

/**
 * Wait for the app's status read, re-evaluating as records arrive. Fails at once when the app exits
 * or runs a command outside the read-only set, and after `timeoutMs` with what was recorded.
 * @param {{ recordDir: string; appPid: number; isBundledHsetup: (exe: string) => boolean; timeoutMs: number; appExited?: () => string | null }} params
 */
export async function waitForAppIpcStatusRead({ recordDir, appPid, isBundledHsetup, timeoutMs, appExited = () => null }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exited = appExited();
    if (exited) throw new Error(`the app exited before its system task ran: ${exited}`);
    const invocations = readStubInvocations(recordDir);
    try {
      return evaluateAppIpcInvocations({ invocations, appPid, isBundledHsetup });
    } catch (error) {
      if (error instanceof NonReadOnlyInvocationError) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} (waited ${timeoutMs}ms)`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Where the app found the hsetup it ran must be the artifact's packaged resource, never a
 * compile-time checkout path (`hsetup_path.rs` only consults `CARGO_MANIFEST_DIR/binaries` in debug
 * builds; RED on 0.3 until the 0.2 `hsetup_path.rs` packaged-first fix is ported). Linux bundles ship the resource as `.gz`, which the app materializes under its own cache
 * dir as `systemTasks/hsetup-materialized-<gz len>-<mtime>`; an uncompressed resource runs in place
 * from the mounted or extracted AppImage (`…/usr/lib/<product>/binaries/<name>`).
 * @param {{ hsetupExe: string; cacheHome: string; resource: string; resourceBytes: number }} params
 * @returns {'materialized-resource' | 'packaged-resource'}
 */
export function assertPackagedHsetupResolution({ hsetupExe, cacheHome, resource, resourceBytes }) {
  const cacheRoot = `${path.resolve(cacheHome)}${path.sep}`;
  const materialized = /^hsetup-materialized-(\d+)-\d+$/u.exec(path.basename(hsetupExe));
  if (hsetupExe.startsWith(cacheRoot)
    && path.basename(path.dirname(hsetupExe)) === 'systemTasks'
    && materialized
    && Number(materialized[1]) === resourceBytes) {
    return 'materialized-resource';
  }
  const inPlace = resource.replace(/\.gz$/u, '');
  if (hsetupExe.endsWith(`${path.sep}${inPlace}`) && /(^|\/)(\.mount_[^/]+|squashfs-root)\//u.test(hsetupExe)) {
    return 'packaged-resource';
  }
  throw new Error(`the app ran hsetup from ${hsetupExe}, not the packaged resource ${resource} (${resourceBytes} bytes) or its materialized copy under ${cacheRoot}`);
}
