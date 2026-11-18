import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../utils/fs/json.mjs';

/**
 * The QA green pointer (owner 2026-11-18, "QA train approved"): the newest commit whose QA reload
 * proved valid end to end on the green checker bed. Its revision tree was prepared on the execution
 * hosts (the build), its server and daemon loaded from that tree (Protocol included), and one fake
 * Agent started (`--verify` on a QA bed, whose Claude is the fake Claude). Plain QA reloads select it
 * instead of HEAD (prepareSourceRuntimeReload), so committed code that does not load never reaches an
 * acceptance Stack. The rolling HEAD job kicks it after every commit; one check runs at a time and
 * always takes the newest HEAD, so commits that land during a check coalesce into the next one.
 * The base trees a check prepares are the shared per-revision bases acceptance reloads adopt.
 */
const self = fileURLToPath(import.meta.url);
const REVISION = /^[0-9a-f]{40,64}$/;
/** The bed the green check reloads; `stack qa-bed create` makes it once (fake Claude, own database). */
export const DEFAULT_QA_GREEN_STACK = 'agent-qa-p03-qa-green-bed';

const runGit = promisify(execFile);
async function git(repoDir, args) {
  const env = { ...process.env };
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[name];
  return (await runGit('git', ['-C', repoDir, ...args], { env, maxBuffer: 1 << 20 })).stdout.trim();
}

async function isAncestor(repoDir, ancestor, descendant) {
  try { await git(repoDir, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

/** One place per repository, beside its repository dev stack's dev-targets.json. Derived from the repository and the
 * machine's stack storage only: a committer's env that selects another stack must not split the pointer. */
export async function resolveQaGreenStateDir({ repoDir, env = process.env }) {
  const { resolveRepoStackIdentity, resolveStacksStorageRoot } = await import('../utils/stack/repo_stack_identity.mjs');
  const { stackBaseDir } = resolveRepoStackIdentity({ repoRoot: resolve(repoDir), stacksStorageRoot: resolveStacksStorageRoot(env) });
  return join(stackBaseDir, 'qa-green');
}

/** `{ revision, checkedAt, durationMs }`, or null when no commit has been proven yet. */
export async function readQaGreen({ stateDir }) {
  const record = await readJsonIfExists(join(stateDir, 'green.json')).catch(() => null);
  return REVISION.test(record?.revision ?? '') ? record : null;
}

/**
 * Check HEAD once. `check(revision)` returns the reload verdict (`status`, `check`, `durationMs`).
 * Every verdict is appended to checks.log; a READY one moves green forward (never backwards: a
 * rewound HEAD proven later is not newer than the green it descends from).
 */
export async function runQaGreenPass({ repoDir, stateDir, check, log = () => {} }) {
  const head = await git(repoDir, ['rev-parse', 'HEAD']);
  const last = await readJsonIfExists(join(stateDir, 'checked.json')).catch(() => null);
  if (last?.revision === head) return { revision: head, skipped: true };
  await mkdir(stateDir, { recursive: true });
  const startedAt = Date.now();
  const verdict = await check(head);
  const durationMs = verdict.durationMs ?? Date.now() - startedAt;
  const status = verdict.status === 'READY' ? 'READY' : verdict.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NOT_READY';
  await appendFile(join(stateDir, 'checks.log'), `${new Date().toISOString()} ${status} rev=${head}`
    + `${verdict.check ? ` check=${verdict.check}` : ''}${verdict.code ? ` code=${verdict.code}` : ''} ms=${durationMs}\n`);
  // An unavailable checker proved nothing about HEAD: the next kick checks it again.
  if (status === 'UNAVAILABLE') { log(`[qa-green] checker unavailable for ${head}: ${verdict.code ?? 'unknown'}`); return { revision: head, status }; }
  await writeJsonAtomic(join(stateDir, 'checked.json'), { revision: head, status, at: new Date().toISOString() });
  const green = await readQaGreen({ stateDir });
  if (status === 'READY' && (!green || await isAncestor(repoDir, green.revision, head))) {
    await writeJsonAtomic(join(stateDir, 'green.json'), { revision: head, checkedAt: new Date().toISOString(), durationMs });
    log(`[qa-green] green ${head}`);
  } else log(`[qa-green] ${status} ${head}${verdict.check ? ` (${verdict.check})` : ''}; green stays ${green?.revision ?? 'unset'}`);
  return { revision: head, status };
}

/** Reload the checker bed at `revision` with `--verify` and return its verdict line. The reload's own owners bound it
 * (admission owns preparation, the start's readiness budget bounds readiness and the verify probes); `signal` is the
 * checker's cancellation: it stops the reload's process group and reports a check that proved nothing. */
export async function checkRevisionOnBed({ repoDir, stackName, revision, env = process.env, signal }) {
  const { resolveStacksStorageRoot } = await import('../utils/stack/repo_stack_identity.mjs');
  const bedDir = join(resolveStacksStorageRoot(env), stackName);
  if (!existsSync(join(bedDir, 'env'))) return { status: 'UNAVAILABLE', code: 'checker_stack_missing' };
  // `stack qa-bed create` seeds and signs the bed in after its first start; a bed whose create stopped earlier can only
  // fail at sign-in, which says nothing about this revision.
  if (!existsSync(join(bedDir, 'qa-bed', 'seed.json'))) return { status: 'UNAVAILABLE', code: 'checker_bed_not_seeded' };
  // An uncommitted lockfile refuses every committed-revision reload; that says nothing about this revision.
  const { refuseWorkingLockfileDrift } = await import('../runtime/launch/reloadLockfilePreflight.mjs');
  try { await refuseWorkingLockfileDrift({ repoDir }); }
  catch (error) { if (error.code === 'working_lockfile_differs_from_head') return { status: 'UNAVAILABLE', code: error.code }; throw error; }
  // The bed's own env selects everything; a committer's stack selection (HAPPIER_STACK_*) must not leak in.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(GIT_(INDEX_FILE|DIR|WORK_TREE|COMMON_DIR)|HAPPIER_STACK_)/.test(name)
    || name === 'HAPPIER_STACK_STORAGE_DIR'));
  if (signal?.aborted) return { status: 'UNAVAILABLE', code: 'check_cancelled' };
  // Its own process group, so cancellation reaches the whole reload (remote transport included), not just its launcher.
  const child = spawn(process.execPath, [join(repoDir, 'apps/stack/scripts/repo_local.mjs'), 'stack', 'start', stackName,
    '--runtime=source', '--restart', '--verify', '--no-ui', `--rev=${revision}`], { cwd: repoDir, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; process.stdout.write(chunk); });
  const exited = new Promise(resolveExit => { child.once('error', () => resolveExit(null)); child.once('close', resolveExit); });
  const cancel = () => { void import('../utils/proc/proc.mjs').then(({ killProcessTree }) => killProcessTree(child, 'SIGTERM')); };
  signal?.addEventListener('abort', cancel, { once: true });
  const code = await exited.finally(() => signal?.removeEventListener('abort', cancel));
  if (signal?.aborted) return { status: 'UNAVAILABLE', code: 'check_cancelled' };
  let verdict = null;
  for (const line of out.split('\n')) {
    try { const parsed = JSON.parse(line); if (parsed?.status === 'READY' || parsed?.status === 'NOT_READY') verdict = parsed; } catch { /* reload log lines */ }
  }
  return verdict ?? { status: 'UNAVAILABLE', code: `verify_no_verdict_exit_${code}` };
}

/** The single rolling owner: checks the newest HEAD until it has been checked, then exits. */
export async function runQaGreenRolling({ repoDir, env = process.env, stackName = env.HAPPIER_STACK_QA_GREEN_STACK || DEFAULT_QA_GREEN_STACK,
  signal, check = revision => checkRevisionOnBed({ repoDir, stackName, revision, env, signal }), log = message => console.error(message) }) {
  const stateDir = await resolveQaGreenStateDir({ repoDir, env });
  for (;;) {
    let last;
    try {
      await withWorkspaceBundleLock(async () => {
        do last = await runQaGreenPass({ repoDir, stateDir, check, log });
        while (!last.skipped && last.status !== 'UNAVAILABLE');
      }, { lockPath: join(stateDir, 'check.lock'), timeoutMs: null, wait: false });
    } catch (error) {
      if (error?.code === WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) return 0; // the holder re-reads HEAD before it lets go
      throw error;
    }
    if (last?.status === 'UNAVAILABLE') return 1;
    // Closes the window between the holder's last HEAD read and its release.
    const checked = await readJsonIfExists(join(stateDir, 'checked.json')).catch(() => null);
    if (checked?.revision === await git(repoDir, ['rev-parse', 'HEAD'])) return 0;
  }
}

/** Commit paths call this through the rolling HEAD job's kick; it never waits. */
export async function kickQaGreenCheck({ repoDir, env = process.env }) {
  const stateDir = await resolveQaGreenStateDir({ repoDir, env });
  await mkdir(stateDir, { recursive: true });
  const descriptor = await open(join(stateDir, 'runs.log'), 'a');
  try {
    const childEnv = { ...env };
    for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete childEnv[name];
    spawn(process.execPath, [self, '--rolling', resolve(repoDir)], { cwd: repoDir, env: childEnv, detached: true,
      stdio: ['ignore', descriptor.fd, descriptor.fd] }).unref();
  } finally { await descriptor.close(); }
  return `QA green check kicked; verdicts in ${join(stateDir, 'checks.log')}`;
}

if (process.argv[1] === self) {
  const [command, repoArg] = process.argv.slice(2);
  const repoDir = resolve(repoArg ?? process.cwd());
  try {
    if (command === '--rolling') {
      // Stopping the checker (TERM/INT) cancels its check: the reload stops, nothing is proven, the lock is released.
      const cancellation = new AbortController();
      for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => cancellation.abort());
      process.exitCode = await runQaGreenRolling({ repoDir, signal: cancellation.signal });
    }
    else if (command === '--kick') console.log(await kickQaGreenCheck({ repoDir }));
    else if (command === '--show') console.log(JSON.stringify(await readQaGreen({ stateDir: await resolveQaGreenStateDir({ repoDir }) })));
    else { console.error('usage: qa_green.mjs --show | --kick | --rolling [repoDir]'); process.exitCode = 2; }
  } catch (error) {
    console.error(`[qa-green] ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}
