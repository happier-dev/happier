import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { startDevReloadCoordinator } from '../../utils/dev/devReloadCoordinator.mjs';
import { namesCommit, parseBoardPosts } from '../../perf/break-attribution.mjs';
import { redactFailureDiagnostic } from '../../utils/proc/proc.mjs';
import { resolveHeadReflogPath, resolveSourceRevisionIdentity } from '../../build/source_revision.mjs';
import { recordStackRuntimeUpdate } from '../../utils/stack/runtime_state.mjs';

const execFileAsync = promisify(execFile);
const short = sha => String(sha ?? 'none').slice(0, 11);

async function git(repoDir, args) {
  // Lock-free reads: the shared checkout's index belongs to its writers.
  return (await execFileAsync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 1 << 22,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
}

export async function readCommittedHead(repoDir) {
  return (await resolveSourceRevisionIdentity({ repoDir })).revision;
}

/**
 * Follows `repoDir`'s HEAD and calls `advance(head)` after commits. Only HEAD's reflog
 * triggers it (native file events, no poll). The existing reload coordinator
 * coalesces: one advance runs at a time, and commits that land meanwhile produce
 * exactly one trailing advance to the then-newest HEAD. A refused advance leaves
 * the loaded revision in place; the first refusal after a success is reported, and
 * the next commit retries.
 */
export async function startCommittedHeadFollower({ repoDir, loadedRevision, advance, report = async () => {},
  onState = async () => {}, isShuttingDown, logger = console, stackName = '' }) {
  let loaded = loadedRevision;
  let refused = false;
  const label = stackName ? `[committed:${stackName}]` : '[committed]';
  const executor = {
    target: 'source-runtime',
    async build() {
      const head = await readCommittedHead(repoDir);
      if (head === loaded) return { skipped: true };
      logger.log(`${label} HEAD ${short(loaded)} -> ${short(head)}`);
      await onState({ phase: 'advancing', loaded, head });
      try {
        await advance(head);
      } catch (error) {
        logger.error(`${label} advance to ${short(head)} refused; ${short(loaded)} stays loaded; the next commit retries`);
        await onState({ phase: 'refused', loaded, head, error });
        if (!refused) {
          refused = true;
          await report({ loaded, head, error }).catch(reportError =>
            logger.error(`${label} refusal report failed: ${reportError?.message ?? reportError}`));
        }
        throw error;
      }
      loaded = head;
      refused = false;
      await onState({ phase: 'following', loaded, head });
      return { skipped: true };
    },
  };
  const watcher = startDevReloadCoordinator({
    descriptors: [{ id: 'committed-head', target: 'source-runtime', paths: [await resolveHeadReflogPath(repoDir)] }],
    executors: [executor], debounceMs: 500, pollIntervalMs: 0, recursive: false, isShuttingDown, logger,
  });
  // Commits that landed while the Stack started move it on at once.
  void watcher.requestReload('source-runtime');
  return watcher;
}

/** One URGENT to Systemic (it runs repo-dev) and to the lanes that posted the
 * commits since the incumbent, through the canonical board writer. */
export async function postCommittedAdvanceRefusal({ repoDir, board, stackName, loaded, head, error, env = process.env,
  now = new Date(), postEntry }) {
  const range = loaded ? `${loaded}..${head}` : head;
  const commits = (await git(repoDir, ['log', '--format=%H %s', range]).catch(() => '')).split('\n').filter(Boolean);
  let posts = [];
  try { posts = parseBoardPosts(await readFile(board, 'utf8')); } catch { posts = []; }
  const lanes = new Set();
  for (const line of commits) {
    // The board is newest first: the earliest mention is normally the committing lane.
    const post = posts.filter(item => namesCommit(item.text, line.slice(0, 40))).at(-1);
    if (post) lanes.add(post.from);
  }
  lanes.delete('Systemic');
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);
  const code = error?.code ? ` (${error.code})` : '';
  const message = redactFailureDiagnostic(String(error?.message ?? error).split('\n')[0], env);
  const entry = [
    `### ${stamp} UTC — ${stackName} committed mode → ${['Systemic', ...lanes].join(', ')} — URGENT — ${stackName} could not advance to HEAD ${short(head)}; ${short(loaded)} stays loaded`,
    `- act: advancing the committed checkout was refused${code}: ${message}`,
    `- ${stackName} keeps ${short(loaded)} and retries on the next commit.`,
    ...(error?.logPath ? [`- Log: ${error.logPath}`] : []),
    `- Commits since ${short(loaded)}: ${commits.map(line => `${line.slice(0, 11)} ${line.slice(41)}`).join('; ') || 'none listed'}`,
    '',
  ].join('\n');
  if (postEntry) return await postEntry(entry);
  const temporary = await mkdtemp(join(tmpdir(), 'hstack-committed-refusal-'));
  try {
    const file = join(temporary, 'entry.md');
    await writeFile(file, entry, { mode: 0o600 });
    const { postBoardEntry } = await import(new URL('../../../../../scripts/board/postBoardEntry.mjs', import.meta.url).href);
    await postBoardEntry(board, file);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** The primary checkout a committed worktree follows (its repository's main worktree).
 * A checkout that is not a linked worktree is refused, so committed mode never runs
 * or moves the shared checkout itself. */
export async function resolveCommittedSource(worktreeDir) {
  const gitDir = resolve(worktreeDir, await git(worktreeDir, ['rev-parse', '--git-dir']));
  const commonDir = resolve(worktreeDir, await git(worktreeDir, ['rev-parse', '--git-common-dir']));
  if (gitDir === commonDir) {
    throw Object.assign(new Error(`[committed] ${worktreeDir} is not a linked worktree; create one with \`git worktree add --detach <path> HEAD\` and point HAPPIER_STACK_REPO_DIR at it`),
      { code: 'committed_checkout_not_worktree' });
  }
  return { sourceRepoDir: dirname(commonDir) };
}

/** Git rewrites only the files the commits changed; the live watchers (Metro, server,
 * daemon, dependencies) then react exactly as they do to an edit. */
async function fastForwardWorktree(worktreeDir, rev) {
  try {
    await execFileAsync('git', ['-C', worktreeDir, 'checkout', '--detach', '--quiet', rev], { encoding: 'utf8' });
  } catch (error) {
    throw Object.assign(new Error(`[committed] checkout --detach ${short(rev)} refused: ${String(error.stderr || error.message).trim().split('\n')[0]}`),
      { code: 'committed_checkout_refused' });
  }
}

/** dev.mjs wiring for committed mode: live mode rooted at a committed worktree
 * (`HAPPIER_STACK_REPO_DIR`), fast-forwarded to its primary checkout's newest HEAD.
 * Status: `committedHead` in the runtime state (stack info `runtime.committedHead`);
 * board: the Stack env `HAPPIER_STACK_BOARD` (relative to the primary checkout). */
export async function startCommittedStackFollower({ worktreeDir, stackName, runtimeStatePath, env = process.env,
  isShuttingDown, logger = console }) {
  const { sourceRepoDir } = await resolveCommittedSource(worktreeDir);
  const loadedRevision = await readCommittedHead(worktreeDir);
  const boardPath = String(env.HAPPIER_STACK_BOARD ?? '').trim();
  const board = boardPath ? resolve(sourceRepoDir, boardPath) : null;
  const record = state => runtimeStatePath ? recordStackRuntimeUpdate(runtimeStatePath, { committedHead: { phase: state.phase,
    loaded: state.loaded ?? null, head: state.head ?? null, at: new Date().toISOString(),
    refusal: state.error ? { code: state.error.code ?? null } : null } }) : Promise.resolve();
  await record({ phase: 'following', loaded: loadedRevision, head: loadedRevision });
  logger.log(`[committed:${stackName}] live mode on ${worktreeDir} at ${short(loadedRevision)}, following ${sourceRepoDir}`);
  return await startCommittedHeadFollower({ repoDir: sourceRepoDir, loadedRevision, stackName, isShuttingDown, logger,
    onState: record,
    report: refusal => board ? postCommittedReloadRefusal({ repoDir: sourceRepoDir, board, stackName, env, ...refusal }) : Promise.resolve(),
    advance: rev => fastForwardWorktree(worktreeDir, rev),
  });
}
