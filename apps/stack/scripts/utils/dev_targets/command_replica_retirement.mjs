import { spawn } from 'node:child_process';
import { appendFile, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveMutagenRepositoryKey } from './mutagen_project.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';
import { posixQuote } from './remote_commands.mjs';
import { runDevTargetControlProcess } from './sync_project.mjs';

const COMMAND_STATE_PREFIX = 'commands-';

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Only a sibling replica created for this checkout name next to the worker's
// executor mirror is a candidate; Stack runtime targets keep their own repository.
function isSiblingReplicaTarget(target, name) {
  return (
    target?.platform === 'posix' &&
    typeof target.ssh === 'string' &&
    typeof target.repoDir === 'string' &&
    typeof target.executorRepoDir === 'string' &&
    posix.isAbsolute(target.repoDir) &&
    posix.basename(target.repoDir) === name &&
    posix.dirname(target.repoDir) === posix.dirname(target.executorRepoDir) &&
    target.repoDir !== target.executorRepoDir
  );
}

// The worker-side producer writes .happier/command-replica.json naming the
// replica root. A directory without that exact owner record is never deleted.
function buildRemoteCommandReplicaRemovalCommand(repoDirs) {
  return [
    'set -u',
    ...repoDirs.map((repoDir) => {
      const dir = posixQuote(repoDir);
      const owner = posixQuote(`"repoDir":${JSON.stringify(repoDir)}`);
      return (
        `if [ ! -e ${dir} ]; then :; elif grep -qF -- ${owner} ${posixQuote(`${repoDir}/.happier/command-replica.json`)} 2>/dev/null; ` +
        `then rm -rf -- ${dir} || exit 1; else printf '%s\\n' ${posixQuote(`unowned ${repoDir}`)} >&2; fi`
      );
    }),
  ].join('\n');
}

const RETIREMENT_STATE = 'retirement.v1.json';

// `git worktree remove` cannot reach the controller state, the one-way
// Mutagen sessions or the source+dependency replica a sibling dispatch left on
// every worker (about 5 GB each; mac2-linux filled twice, 2026-10-27/29).
// Workers cannot observe the checkout's absence, so the dispatching controller
// retires them. Each worker is retired once; one that cannot be reached keeps
// only its own share pending for a later pass.
export async function retireRemovedCommandRepositories(
  { stackDir, executorRepoRoot, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const executor = resolve(executorRepoRoot);
  const removed = [];
  for (const entry of await readdir(stackDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(COMMAND_STATE_PREFIX)) continue;
    const name = entry.name.slice(COMMAND_STATE_PREFIX.length);
    const sourceDir = join(dirname(executor), name);
    if (!name || sourceDir === executor || (await pathExists(sourceDir))) continue;
    const stateDir = join(stackDir, entry.name);
    const readJson = async file => JSON.parse(await readFile(join(stateDir, file), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    }));
    const config = await readJson('dev-targets.json');
    const doneTargets = new Set((await readJson(RETIREMENT_STATE))?.doneTargets ?? []);
    removed.push({ name, sourceDir, stateDir, doneTargets, failed: false,
      targets: (config?.targets ?? []).filter(target => isSiblingReplicaTarget(target, name) && !doneTargets.has(target.name)) });
  }
  if (removed.length === 0) return { retired: [], pending: {} };

  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: stackDir, env });
  const listed = await runProcess({ label: '', command: 'mutagen',
    args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: runtime.env });
  if (listed?.code !== 0) throw new Error('[dev-targets] Mutagen session inventory failed for removed sibling checkouts');
  const sessions = JSON.parse(listed.out || '[]');
  for (const repository of removed) {
    // Same ownership predicate as the project owner's orphan reconciliation.
    for (const session of sessions) {
      if (session.alpha?.protocol !== 'local' || resolve(session.alpha.path ?? '') !== repository.sourceDir
        || session.mode !== 'one-way-replica' || !session.labels?.['io.mutagen.project'] || !session.identifier) continue;
      const terminated = await runProcess({ label: 'sync', command: 'mutagen',
        args: ['sync', 'terminate', session.identifier], env: runtime.env });
      if (terminated?.code !== 0) repository.failed = true;
    }
  }

  // One SSH per worker covers every removed sibling it may hold.
  const byWorker = new Map();
  for (const repository of removed) {
    for (const target of repository.targets) {
      const key = `${target.sshConfigFile ?? ''}\0${target.ssh}`;
      if (!byWorker.has(key)) byWorker.set(key, { target, entries: [] });
      byWorker.get(key).entries.push({ repository, target });
    }
  }
  const pending = {};
  await Promise.all([...byWorker.values()].map(async ({ target, entries }) => {
    const result = await runProcess({ label: `remote:${target.name}`, command: 'ssh', args: [
      ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []), '-o', 'BatchMode=yes', target.ssh,
      buildRemoteCommandReplicaRemovalCommand(entries.map(entry => entry.target.repoDir)),
    ], env });
    if (result?.code === 0) for (const entry of entries) entry.repository.doneTargets.add(entry.target.name);
    else pending[target.name] = entries.length;
  }));

  const retired = [];
  for (const repository of removed) {
    const complete = !repository.failed && repository.targets.every(target => repository.doneTargets.has(target.name));
    if (!complete) {
      if (repository.doneTargets.size > 0) {
        const file = join(repository.stateDir, RETIREMENT_STATE);
        await writeFile(`${file}.${process.pid}.tmp`, `${JSON.stringify({ version: 1, doneTargets: [...repository.doneTargets].sort() })}\n`);
        await rename(`${file}.${process.pid}.tmp`, file);
      }
      continue;
    }
    await rm(join(runtime.mutagenDir, 'repositories', resolveMutagenRepositoryKey(repository.sourceDir)), { recursive: true, force: true });
    await rm(repository.stateDir, { recursive: true, force: true });
    retired.push(repository.name);
  }
  return { retired, pending };
}

// Retirement reaches every worker a removed sibling may hold, including ones
// that are down (some target configs wait 180 s to connect). It therefore runs
// detached from the dispatch it was observed in, one pass per Stack at a time.
export function startRemovedCommandRepositoryRetirement({ stackDir, executorRepoRoot, env = process.env }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), stackDir, executorRepoRoot],
    { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function main([stackDir, executorRepoRoot]) {
  const lock = join(stackDir, 'command-replica-retirement.lock');
  const holder = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
  if (Number.isSafeInteger(holder) && holder > 0 && processAlive(holder)) return;
  await rm(lock, { force: true });
  try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  let record = null;
  try {
    const { retired, pending } = await retireRemovedCommandRepositories({ stackDir, executorRepoRoot });
    if (retired.length > 0) record = { retired, pending };
  } catch (error) {
    record = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(lock, { force: true });
  }
  if (record) await appendFile(join(stackDir, 'command-replica-retirement.log'),
    `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
