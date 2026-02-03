import './utils/env/env.mjs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { happyMonorepoSubdirForComponent, isHappyMonorepoRoot } from './utils/paths/paths.mjs';
import { parseGithubPullRequest } from './utils/git/refs.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { bold, cyan, dim, green, red, yellow } from './utils/ui/ansi.mjs';
import { clipboardAvailable, copyTextToClipboard } from './utils/ui/clipboard.mjs';
import { detectInstalledLlmTools } from './utils/llm/tools.mjs';
import { launchLlmAssistant } from './utils/llm/assist.mjs';
import { buildhstackRunnerShellSnippet } from './utils/llm/hstack_runner.mjs';

function usage() {
  return [
    '[monorepo] usage:',
    '  hstack monorepo port --target=/abs/path/to/monorepo [--clone-target] [--target-repo=<git-url>] [--branch=port/<name>] [--base=<ref>] [--onto-current] [--dry-run] [--3way] [--skip-applied] [--continue-on-failure] [--json]',
    '  hstack monorepo port guide [--target=/abs/path/to/monorepo] [--clone-target] [--target-repo=<git-url>] [--json]',
    '  hstack monorepo port preflight --target=/abs/path/to/monorepo [--base=<ref>] [--3way] [--json]',
    '  hstack monorepo port status [--target=/abs/path/to/monorepo] [--json]',
    '  hstack monorepo port continue [--target=/abs/path/to/monorepo] [--json]',
    '  hstack monorepo port llm --target=/abs/path/to/monorepo [--copy] [--launch] [--json]',
    '    [--from-happy=/abs/path/to/old-happy --from-happy-base=<ref> --from-happy-ref=<ref>]',
    '    [--from-happy-cli=/abs/path/to/old-happy-cli --from-happy-cli-base=<ref> --from-happy-cli-ref=<ref>]',
    '    [--from-happy-server=/abs/path/to/old-happy-server --from-happy-server-base=<ref> --from-happy-server-ref=<ref>]',
    '',
    'what it does:',
    '- Best-effort ports commits from split repos into the Happier monorepo layout by applying patches into:',
    '  - old happy (UI)        -> apps/ui/ (or legacy: expo-app/)',
    '  - old happy-cli (CLI)   -> apps/cli/ (or legacy: cli/)',
    '  - old happy-server      -> apps/server/ (or legacy: server/)',
    '',
    'notes:',
    '- This preserves commit messages/authors (via `git format-patch` + `git am`).',
    '- The target monorepo should already contain the "base" version of each subtree (typically a clean checkout of upstream/main).',
    '- Already-applied patches are auto-skipped when detected (exact-match via reverse apply-check).',
    '- Identical \"new file\" patches are auto-skipped when the target already contains the same file content.',
    '- Conflicts may require manual resolution. If `git am` stops, fix conflicts then run:',
    '    git am --continue',
    '  or abort with:',
    '    git am --abort',
    '',
    'LLM tip:',
    '- If you want an LLM to help resolve conflicts, run:',
    '    hstack monorepo port llm --target=/abs/path/to/monorepo --launch',
    '  or, if you prefer copy/paste:',
    '    hstack monorepo port llm --target=/abs/path/to/monorepo --copy',
    '  then paste the copied prompt into your LLM.',
  ].join('\n');
}

async function git(cwd, args, options = {}) {
  return await runCapture('git', args, { cwd, ...options });
}

async function gitOk(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function withTempDetachedWorktree({ repoRoot, ref, label }, fn) {
  const root = await resolveGitRoot(repoRoot);
  if (!root) throw new Error('[monorepo] failed to resolve git root for worktree');
  const safeLabel = String(label ?? 'worktree')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tmp = await mkdtemp(join(tmpdir(), `happy-stacks-${safeLabel}-`));
  const dir = join(tmp, 'wt');
  const r = String(ref ?? '').trim();
  if (!r) throw new Error('[monorepo] missing worktree ref');
  try {
    await runCapture('git', ['worktree', 'add', '--detach', dir, r], { cwd: root });
    return await fn(dir);
  } finally {
    try {
      await runCapture('git', ['worktree', 'remove', '--force', dir], { cwd: root });
      await runCapture('git', ['worktree', 'prune'], { cwd: root });
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveGitRoot(dir) {
  const d = resolve(String(dir ?? '').trim());
  if (!d) return '';
  try {
    return (await git(d, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return '';
  }
}

async function ensureCleanGitWorktree(repoRoot) {
  const dirty = (await git(repoRoot, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new Error(`[monorepo] target repo is not clean: ${repoRoot}\n[monorepo] fix: commit/stash changes and re-run`);
  }
}

async function ensureNoGitAmInProgress(repoRoot) {
  try {
    const rel = (await git(repoRoot, ['rev-parse', '--git-path', 'rebase-apply'])).trim();
    if (!rel) return;
    const p = rel.startsWith('/') ? rel : join(repoRoot, rel);
    if (!(await pathExists(p))) return;
    if ((await pathExists(join(p, 'applying'))) || (await pathExists(join(p, 'patch')))) {
      throw new Error(
        [
          '[monorepo] a git am operation is already in progress in the target repo.',
          '[monorepo] fix: resolve it first, then re-run.',
          `- continue: git -C ${repoRoot} am --continue`,
          `- abort:    git -C ${repoRoot} am --abort`,
        ].join('\n')
      );
    }
  } catch (err) {
    // If git isn't happy with --git-path for some reason, fail open; the later git am will fail anyway.
    if (String(err?.message ?? '').includes('a git am operation is already in progress')) throw err;
  }
}

async function isGitAmInProgress(repoRoot) {
  try {
    const rel = (await git(repoRoot, ['rev-parse', '--git-path', 'rebase-apply'])).trim();
    if (!rel) return false;
    const p = rel.startsWith('/') ? rel : join(repoRoot, rel);
    if (!(await pathExists(p))) return false;
    if ((await pathExists(join(p, 'applying'))) || (await pathExists(join(p, 'patch')))) return true;
    return false;
  } catch {
    return false;
  }
}

async function ensureBranch(repoRoot, branch) {
  const b = String(branch ?? '').trim();
  if (!b) return;
  const exists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]);
  if (exists) {
    throw new Error(`[monorepo] target branch already exists: ${b}\n[monorepo] fix: pick a new --branch name`);
  }
  await git(repoRoot, ['checkout', '-b', b]);
}

async function resolveDefaultBaseRef(sourceRepoRoot) {
  const candidates = ['upstream/main', 'origin/main', 'main', 'master'];
  for (const c of candidates) {
    if (await gitOk(sourceRepoRoot, ['rev-parse', '--verify', '--quiet', c])) {
      return c;
    }
  }
  return '';
}

async function resolveDefaultTargetBaseRef(targetRepoRoot) {
  try {
    const sym = (await git(targetRepoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(sym);
    if (m?.[1]) {
      const ref = `origin/${m[1]}`;
      if (await gitOk(targetRepoRoot, ['rev-parse', '--verify', '--quiet', ref])) {
        return ref;
      }
    }
  } catch {
    // ignore
  }
  return await resolveDefaultBaseRef(targetRepoRoot);
}

async function resolveTargetRepoRootFromArgs({ kv }) {
  const target = (kv.get('--target') ?? '').trim();
  const targetHint = target || process.cwd();
  const repoRoot = await resolveGitRoot(targetHint);
  if (!repoRoot) {
    throw new Error(`[monorepo] target is not a git repo: ${targetHint}`);
  }
  if (!isHappyMonorepoRoot(repoRoot)) {
    throw new Error(
        `[monorepo] target does not look like a Happier monorepo root ` +
          `(missing apps/ui|apps/cli|apps/server or legacy expo-app/cli/server): ${repoRoot}`
      );
  }
  return repoRoot;
}

function looksLikeUrlSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return false;
  if (/^[a-z]+:\/\//i.test(s)) return true; // https://, file://, ssh://, etc
  if (/^git@[^:]+:/.test(s)) return true; // git@github.com:owner/repo.git
  if (/^github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(s)) return true;
  return false;
}

function looksLikeGithubPullUrl(spec) {
  const s = String(spec ?? '').trim();
  return s.includes('github.com/') && s.includes('/pull/');
}

function safeSlug(s, { maxLen = 80 } = {}) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen || 80);
}

async function isEmptyDir(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

function gitNonInteractiveEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function resolvePortScratchDir(targetRepoRoot, rel) {
  const p = await resolveGitPath(targetRepoRoot, rel);
  if (!p) return '';
  await mkdir(dirname(p), { recursive: true });
  return p;
}

async function ensureClonedHappyMonorepo({ targetPath, repoUrl }) {
  const dest = String(targetPath ?? '').trim();
  if (!dest) throw new Error('[monorepo] clone-target: missing --target=<dir>');
  const url = String(repoUrl ?? '').trim() || 'https://github.com/happier-dev/happier.git';

  const exists = await pathExists(dest);
  if (exists) {
    // `git clone` refuses to clone into an existing directory. Allow deleting if empty.
    if (!(await isEmptyDir(dest))) {
      throw new Error(`[monorepo] clone-target: target exists and is not empty: ${dest}`);
    }
    await rm(dest, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(dirname(dest), { recursive: true });

  await runCapture('git', ['clone', '--quiet', url, dest], { cwd: dirname(dest), env: gitNonInteractiveEnv() });
  return dest;
}

async function resolveOrCloneTargetRepoRoot({ targetInput, targetArg, flags, kv, progress } = {}) {
  const hint = String(targetInput ?? '').trim();
  if (!hint) throw new Error('[monorepo] missing target');

  const repoRoot = await resolveGitRoot(hint);
  if (repoRoot) {
    if (!isHappyMonorepoRoot(repoRoot)) {
      throw new Error(
        `[monorepo] target does not look like a Happier monorepo root ` +
          `(missing apps/ui|apps/cli|apps/server or legacy expo-app/cli/server): ${repoRoot}`
      );
    }
    return repoRoot;
  }

  // Not a git repo. If it doesn't exist and clone is requested, clone into it.
  const exists = await pathExists(hint);
  const wantsClone = flags?.has?.('--clone-target') || flags?.has?.('--clone');
  if (!exists) {
    if (!wantsClone) {
      throw new Error(
        `[monorepo] target does not exist: ${hint}\n` +
          `[monorepo] tip: create it (git clone) or re-run with: --clone-target --target-repo=<git-url>`
      );
    }
    if (!String(targetArg ?? '').trim()) {
      throw new Error('[monorepo] --clone-target requires an explicit --target=<dir>');
    }
    const targetRepo = String(kv?.get?.('--target-repo') ?? '').trim();
    const spin = progress?.spinner?.(`Cloning target monorepo into ${hint}`);
    const cloned = await ensureClonedHappyMonorepo({ targetPath: hint, repoUrl: targetRepo || 'https://github.com/happier-dev/happier.git' });
    spin?.succeed?.(`Cloned target monorepo (${hint})`);
    const clonedRoot = await resolveGitRoot(cloned);
    if (!clonedRoot || !isHappyMonorepoRoot(clonedRoot)) {
      throw new Error(`[monorepo] cloned target does not look like a Happier monorepo root: ${cloned}`);
    }
    return clonedRoot;
  }

  // Exists but isn't a git repo.
  throw new Error(`[monorepo] target is not a git repo: ${hint}`);
}

async function ensureRepoSpecCheckedOut({ targetRepoRoot, label, spec, desiredRef = '', progress } = {}) {
  const raw = String(spec ?? '').trim();
  if (!raw) return '';

  // Local path fast path.
  if (await pathExists(raw)) {
    return raw;
  }

  if (!looksLikeUrlSpec(raw)) {
    throw new Error(`[monorepo] ${label}: source path does not exist: ${raw}`);
  }

  const scratch = await resolvePortScratchDir(targetRepoRoot, 'happy-stacks/monorepo-port-sources');
  if (!scratch) throw new Error('[monorepo] failed to resolve port scratch dir');

  // GitHub PR URL: clone repo and fetch PR head into a detached checkout.
  if (looksLikeGithubPullUrl(raw)) {
    const pr = parseGithubPullRequest(raw);
    if (!pr?.number || !pr.owner || !pr.repo) {
      throw new Error(`[monorepo] ${label}: unable to parse GitHub PR URL: ${raw}`);
    }
    const repoUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
    const key = safeSlug(`gh-${pr.owner}-${pr.repo}-pr-${pr.number}`, { maxLen: 90 }) || `pr-${pr.number}`;
    const dir = join(scratch, `${label}-${key}`);

    if (!(await pathExists(dir))) {
      await mkdir(dirname(dir), { recursive: true });
      const spin = progress?.spinner?.(`Cloning ${label} PR repo (${pr.owner}/${pr.repo}#${pr.number})`);
      await runCapture('git', ['clone', '--quiet', repoUrl, dir], { cwd: dirname(dir), env: gitNonInteractiveEnv() });
      spin?.succeed?.(`Cloned ${label} PR repo (${pr.owner}/${pr.repo}#${pr.number})`);
    }

    const prRef = `refs/pull/${pr.number}/head`;
    const spinFetch = progress?.spinner?.(`Fetching ${label} PR head (${prRef})`);
    await runCapture('git', ['fetch', '--quiet', 'origin', prRef], { cwd: dir, env: gitNonInteractiveEnv() });
    await runCapture('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: dir, env: gitNonInteractiveEnv() });
    spinFetch?.succeed?.(`Checked out ${label} PR head`);
    return dir;
  }

  // Generic repo URL/path-like spec: clone it.
  const key = safeSlug(raw, { maxLen: 90 }) || `${label}-${Date.now()}`;
  const dir = join(scratch, `${label}-${key}`);
  if (!(await pathExists(dir))) {
    await mkdir(dirname(dir), { recursive: true });
    const spin = progress?.spinner?.(`Cloning ${label} source repo`);
    await runCapture('git', ['clone', '--quiet', raw, dir], { cwd: dirname(dir), env: gitNonInteractiveEnv() });
    spin?.succeed?.(`Cloned ${label} source repo`);
  }

  // Best-effort: ensure the desired ref exists (if provided).
  const ref = String(desiredRef ?? '').trim();
  if (ref) {
    const ok = await gitOk(dir, ['rev-parse', '--verify', '--quiet', ref]);
    if (!ok) {
      const spin = progress?.spinner?.(`Fetching ${label} ref (${ref})`);
      await git(dir, ['fetch', '--quiet', 'origin', ref]).catch(() => {});
      spin?.succeed?.(`Fetched ${label} ref (${ref})`);
    }
  }
  return dir;
}

async function resolveGitPath(repoRoot, relPath) {
  const rel = (await git(repoRoot, ['rev-parse', '--git-path', relPath])).trim();
  if (!rel) return '';
  return rel.startsWith('/') ? rel : join(repoRoot, rel);
}

function isTestTty() {
  return String(process.env.HAPPIER_STACK_TEST_TTY ?? '').trim() === '1';
}

function shouldShowProgress({ json, silent = false } = {}) {
  if (silent) return false;
  if (json) return false;
  return true;
}

function createProgressReporter({ enabled, label = '[monorepo]' } = {}) {
  const on = Boolean(enabled);
  const canSpin = on && isTty() && !isTestTty();
  const frames = ['|', '/', '-', '\\'];

  const line = (s) => {
    // eslint-disable-next-line no-console
    console.log(s);
  };

  const spinner = (text) => {
    const msg = String(text ?? '').trim();
    if (!on) {
      return {
        update: () => {},
        succeed: () => {},
        fail: () => {},
      };
    }

    if (!canSpin) {
      line(`${dim(label)} ${msg}`);
      return {
        update: () => {},
        succeed: (doneText) => {
          const done = String(doneText ?? '').trim();
          if (done) line(`${green('✓')} ${done}`);
        },
        fail: (failText) => {
          const fail = String(failText ?? '').trim();
          if (fail) line(`${yellow('!')} ${fail}`);
        },
      };
    }

    let idx = 0;
    let current = msg;
    let active = true;

    const render = () => {
      if (!active) return;
      const f = frames[idx % frames.length];
      idx += 1;
      try {
        process.stdout.write(`\r${dim(label)} ${current} ${dim(f)}   `);
      } catch {
        // ignore
      }
    };

    // Initial render + keepalive.
    render();
    const t = setInterval(render, 120);

    const stop = () => {
      active = false;
      try {
        clearInterval(t);
      } catch {
        // ignore
      }
      try {
        process.stdout.write('\r' + ' '.repeat(Math.min(140, current.length + String(label).length + 16)) + '\r');
      } catch {
        // ignore
      }
    };

    return {
      update: (nextText) => {
        current = String(nextText ?? '').trim() || current;
        render();
      },
      succeed: (doneText) => {
        stop();
        const done = String(doneText ?? '').trim();
        if (done) line(`${green('✓')} ${done}`);
      },
      fail: (failText) => {
        stop();
        const fail = String(failText ?? '').trim();
        if (fail) line(`${yellow('!')} ${fail}`);
      },
    };
  };

  return { spinner, line };
}

function section(title) {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold(title));
}

function noteLine(s) {
  // eslint-disable-next-line no-console
  console.log(dim(s));
}

function summarizePreflightFailures(preflight) {
  const fc = preflight?.firstConflict ?? null;
  if (fc?.currentPatch?.subject) {
    const files = Array.isArray(fc.currentPatch.files) ? fc.currentPatch.files : [];
    const conflictFiles = Array.isArray(fc.conflictedFiles) ? fc.conflictedFiles : [];
    const lines = [];
    lines.push(`- first failing patch: ${cyan(fc.currentPatch.subject)}`);
    if (files.length) {
      lines.push(`  - patch files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? dim(', ...') : ''}`);
    }
    if (conflictFiles.length) {
      lines.push(`  - conflicted files: ${conflictFiles.slice(0, 6).join(', ')}${conflictFiles.length > 6 ? dim(', ...') : ''}`);
    }
    return lines;
  }

  // Fallback (older shape): summarize per-source failures if present.
  const results = Array.isArray(preflight?.results) ? preflight.results : [];
  const lines = [];
  for (const r of results) {
    const failed = r?.report?.failed ?? [];
    if (!Array.isArray(failed) || failed.length === 0) continue;
    const label = String(r.label ?? '').trim() || 'source';
    const first = failed[0] ?? null;
    if (!first) continue;

    const subj = String(first.subject ?? '').replace(/^\[PATCH \d+\/\d+\]\s*/, '');
    const kind = first.kind ? ` (${first.kind})` : '';
    const paths = (first.paths ?? []).slice(0, 4).join(', ');

    lines.push(`- ${cyan(label)}: first failing patch`);
    lines.push(`  - ${subj || first.patch}${kind}${paths ? ` → ${paths}` : ''}`);
  }
  return lines;
}

async function resolvePortPlanPath(targetRepoRoot) {
  return await resolveGitPath(targetRepoRoot, 'happy-stacks/monorepo-port-plan.json');
}

async function writePortPlan(targetRepoRoot, plan) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return '';
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(plan ?? null, null, 2) + '\n', 'utf-8');
  return p;
}

async function readPortPlan(targetRepoRoot) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return { path: '', plan: null };
  if (!(await pathExists(p))) return { path: p, plan: null };
  try {
    const raw = await readFile(p, 'utf-8');
    return { path: p, plan: JSON.parse(raw) };
  } catch {
    return { path: p, plan: null };
  }
}

async function deletePortPlan(targetRepoRoot) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return;
  await rm(p, { force: true });
}

async function listConflictedFiles(repoRoot) {
  const out = (await git(repoRoot, ['status', '--porcelain'])).trim();
  if (!out) return [];
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    // Porcelain v1: XY <path>
    // Unmerged states include: UU, AA, DD, AU, UA, DU, UD
    const xy = line.slice(0, 2);
    const isUnmerged = xy.includes('U') || xy === 'AA' || xy === 'DD';
    if (!isUnmerged) continue;
    const path = line.slice(3).trim();
    if (path) files.push(path);
  }
  return Array.from(new Set(files)).sort();
}

function hasConflictMarkers(text) {
  const s = String(text ?? '');
  // Typical git conflict markers at the start of a line.
  return /^(<<<<<<< |>>>>>>> |\|\|\|\|\|\|\| )/m.test(s);
}

async function listFilesWithConflictMarkers(repoRoot, files) {
  const fs = Array.isArray(files) ? files : [];
  const hits = [];
  for (const f of fs) {
    const p = join(repoRoot, f);
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await readFile(p, 'utf-8');
      if (hasConflictMarkers(raw)) hits.push(f);
    } catch {
      // ignore unreadable files
    }
  }
  return hits;
}

async function readGitAmStatus(targetRepoRoot) {
  const inProgress = await isGitAmInProgress(targetRepoRoot);
  const conflictedFiles = await listConflictedFiles(targetRepoRoot);

  let currentPatch = null;
  if (inProgress) {
    try {
      const raw = await git(targetRepoRoot, ['am', '--show-current-patch']);
      const meta = parsePatchMeta(raw);
      const diffs = extractUnifiedDiffs(raw);
      const filesRaw = Array.from(new Set(diffs.map((d) => d.plusPath || d.bPath).filter(Boolean))).sort();
      const files = [];
      for (const f of filesRaw) {
        // `git am --directory <subdir>` applies patches under a directory, but `--show-current-patch`
        // still shows the original (unprefixed) paths. Best-effort map them to the monorepo layout.
        // eslint-disable-next-line no-await-in-loop
        if (await pathExists(join(targetRepoRoot, f))) {
          files.push(f);
          continue;
        }
        const candidates = [
          `apps/ui/${f}`,
          `apps/cli/${f}`,
          `apps/server/${f}`,
          `expo-app/${f}`,
          `cli/${f}`,
          `server/${f}`,
        ];
        let mapped = '';
        for (const c of candidates) {
          // eslint-disable-next-line no-await-in-loop
          if (await pathExists(join(targetRepoRoot, c))) {
            mapped = c;
            break;
          }
        }
        files.push(mapped || f);
      }
      currentPatch = { subject: meta.subject || '', fromSha: meta.fromSha || '', files, filesRaw };
    } catch {
      currentPatch = { subject: '', fromSha: '', files: [], filesRaw: [] };
    }
  }

  return { inProgress, currentPatch, conflictedFiles };
}

async function formatPatchesToDir({ sourceRepoRoot, base, head, outDir, progressLabel = '', progress } = {}) {
  const range = `${base}..${head}`;
  const spin = progress?.spinner?.(
    `Formatting patches${progressLabel ? ` (${progressLabel})` : ''} ${dim(`(${range})`)}`
  );
  await run('git', ['format-patch', '--quiet', '--output-directory', outDir, `${base}..${head}`], { cwd: sourceRepoRoot });
  spin?.succeed?.(`Formatted patches${progressLabel ? ` (${progressLabel})` : ''}`);
  const entries = await readdir(outDir, { withFileTypes: true });
  const patches = entries
    .filter((e) => e.isFile() && e.name.endsWith('.patch'))
    .map((e) => join(outDir, e.name))
    .sort();
  return patches;
}

function parsePatchMeta(patchText) {
  const lines = patchText.split(/\r?\n/);
  let fromSha = '';
  let subject = '';
  for (const line of lines) {
    if (!fromSha && line.startsWith('From ')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) fromSha = parts[1];
      continue;
    }
    if (!subject && line.startsWith('Subject:')) {
      subject = line.slice('Subject:'.length).trim();
      continue;
    }
    if (fromSha && subject) break;
  }
  return { fromSha, subject };
}

function parseApplyErrorPaths(errText) {
  const text = String(errText ?? '').trim();
  if (!text) return { kind: 'unknown', paths: [] };
  const paths = new Set();

  for (const m of text.matchAll(/error:\s+(\S+):\s+already exists in working directory/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+patch failed:\s+(\S+):\d+/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+(\S+):\s+does not exist in index/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+(\S+):\s+No such file or directory/g)) {
    if (m?.[1]) paths.add(m[1]);
  }

  const kind = text.includes('already exists in working directory')
    ? 'already_exists'
    : text.includes('patch does not apply') || text.includes('patch failed:')
      ? 'patch_failed'
      : text.includes('does not exist in index') || text.includes('No such file or directory')
        ? 'missing_path'
        : 'unknown';

  return { kind, paths: Array.from(paths) };
}

function extractUnifiedDiffs(patchText) {
  const lines = patchText.split(/\r?\n/);
  const diffs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('diff --git ')) {
      i += 1;
      continue;
    }

    const m = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line.trim());
    const bPath = m?.[2] ?? '';
    const diff = {
      bPath,
      plusPath: '',
      isNewFile: false,
      isDeletedFile: false,
      isBinary: false,
      noTrailingNewline: false,
      addedLines: [],
    };

    i += 1;
    let inHunk = false;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const l = lines[i];
      if (l.startsWith('new file mode')) diff.isNewFile = true;
      if (l.startsWith('deleted file mode')) diff.isDeletedFile = true;
      if (l.startsWith('GIT binary patch')) diff.isBinary = true;
      if (l.startsWith('--- /dev/null')) diff.isNewFile = true;
      if (l.startsWith('+++ /dev/null')) diff.isDeletedFile = true;
      if (l.startsWith('+++ b/')) diff.plusPath = l.slice('+++ b/'.length).trim();
      if (l.startsWith('@@ ')) inHunk = true;
      if (inHunk) {
        if (l === '\\ No newline at end of file') {
          diff.noTrailingNewline = true;
        } else if (l.startsWith('+') && !l.startsWith('+++ ')) {
          diff.addedLines.push(l.slice(1));
        }
      }
      i += 1;
    }

    diffs.push(diff);
  }
  return diffs;
}

async function checkPureNewFilesAlreadyExistIdentically({ targetRepoRoot, directory, patchText }) {
  const diffs = extractUnifiedDiffs(patchText);
  if (!diffs.length) return { ok: false, paths: [] };

  // Only safe to auto-skip if this patch contains *only* new files.
  if (diffs.some((d) => !d.isNewFile || d.isDeletedFile || d.isBinary)) {
    return { ok: false, paths: [] };
  }

  const prefix = directory ? `${directory}/` : '';
  const paths = [];
  for (const d of diffs) {
    const rel = d.plusPath || d.bPath;
    if (!rel) return { ok: false, paths: [] };

    let expected = '';
    if (d.addedLines.length > 0) {
      expected = d.addedLines.join('\n') + '\n';
      if (d.noTrailingNewline && expected.endsWith('\n')) {
        expected = expected.slice(0, -1);
      }
    }

    const full = join(targetRepoRoot, `${prefix}${rel}`);
    let actual = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      actual = await readFile(full, 'utf-8');
    } catch {
      return { ok: false, paths: [] };
    }
    if (actual !== expected) {
      return { ok: false, paths: [] };
    }
    paths.push(`${prefix}${rel}`);
  }

  return { ok: true, paths };
}

async function applyPatches({ targetRepoRoot, directory, patches, threeWay, skipApplied, continueOnFailure, quietGit, progress } = {}) {
  if (!patches.length) {
    return { applied: [], skippedAlreadyApplied: [], skippedAlreadyExistsIdentical: [], failed: [] };
  }
  const dirArgs = directory ? ['--directory', `${directory}/`] : [];
  const applied = [];
  const skippedAlreadyApplied = [];
  const skippedAlreadyExistsIdentical = [];
  const failed = [];
  const total = patches.length;
  const targetLabel = directory ? `${directory}/` : '.';
  const spin = progress?.spinner?.(`Applying patches into ${targetLabel} ${dim(`(0/${total})`)}`);
  let lastUpdateAt = 0;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (spin?.update) {
      const now = Date.now();
      // Avoid hammering the terminal. Update at most ~5x/sec.
      if (now - lastUpdateAt > 200) {
        lastUpdateAt = now;
        spin.update(`Applying patches into ${targetLabel} ${dim(`(${i + 1}/${total})`)}`);
      }
    }
    const patchFile = basename(patch);
    // eslint-disable-next-line no-await-in-loop
    const patchText = await readFile(patch, 'utf-8');
    const { fromSha, subject } = parsePatchMeta(patchText);
    const entry = { patch: patchFile, fromSha, subject };

    // Preflight check (fast-ish): is this patch clearly already present or a no-op?
    let applyCheckErr = '';
    let appliesCleanly = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runCapture('git', ['apply', '--check', ...dirArgs, patch], { cwd: targetRepoRoot });
      appliesCleanly = true;
    } catch (e) {
      appliesCleanly = false;
      applyCheckErr = String(e?.err ?? e?.message ?? e ?? '').trim();
    }

    if (!appliesCleanly) {
      // Auto-skip identical "new file" patches when the target already contains the same content.
      // This commonly happens when a commit was already folded into the monorepo history during migration.
      // eslint-disable-next-line no-await-in-loop
      const identical = await checkPureNewFilesAlreadyExistIdentically({ targetRepoRoot, directory, patchText });
      if (identical.ok) {
        skippedAlreadyExistsIdentical.push({ ...entry, paths: identical.paths });
        continue;
      }

      // If the reverse patch applies, the change is already present.
      //
      // This is safe (it requires an exact match of the patch content) and avoids stopping early
      // when the monorepo already includes some split-repo commits.
      //
      // `--skip-applied` is kept as a compatibility flag (and a hint to users), but the behavior is effectively always-on.
      let reverseApplies = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        await runCapture('git', ['apply', '-R', '--check', ...dirArgs, patch], { cwd: targetRepoRoot });
        reverseApplies = true;
      } catch {
        reverseApplies = false;
      }
      if (reverseApplies) {
        skippedAlreadyApplied.push(entry);
        continue;
      }
    }

    // Apply with full mailinfo/commit metadata. This may succeed even when `git apply --check` fails (e.g. with --3way).
    try {
      const tryAm = async ({ use3way }) => {
        const args = ['am', '--quiet', ...(use3way ? ['--3way'] : []), ...dirArgs, patch];
        if (quietGit) {
          // eslint-disable-next-line no-await-in-loop
          await runCapture('git', args, { cwd: targetRepoRoot });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await run('git', args, { cwd: targetRepoRoot });
        }
      };

      try {
        // eslint-disable-next-line no-await-in-loop
        await tryAm({ use3way: threeWay });
      } catch (amErr) {
        const amText = String(amErr?.err ?? amErr?.message ?? amErr ?? '').trim();
        const ancestorFail =
          threeWay &&
          (amText.includes('could not build fake ancestor') || amText.includes('sha1 information is lacking or useless'));
        if (!ancestorFail) {
          throw amErr;
        }

        // `git am --3way` requires the blob(s) referenced by the patch to exist in the target repo's object database.
        // When porting into a minimal or mismatched target, those blobs may not exist, causing a hard failure.
        // Fall back to non-3way so users can resolve the patch manually.
        // eslint-disable-next-line no-await-in-loop
        await run('git', ['am', '--abort'], { cwd: targetRepoRoot, stdio: 'ignore' }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await tryAm({ use3way: false });
      }
      applied.push(entry);
    } catch (e) {
      const err = String(e?.err ?? e?.message ?? e ?? '').trim();
      const applyMeta = parseApplyErrorPaths(applyCheckErr || '');
      const amMeta = parseApplyErrorPaths(err || '');
      failed.push({
        ...entry,
        applyCheckErr,
        err,
        kind: applyMeta.kind === 'unknown' ? amMeta.kind : applyMeta.kind,
        paths: Array.from(new Set([...(applyMeta.paths ?? []), ...(amMeta.paths ?? [])])),
      });
      if (!continueOnFailure) {
        throw new Error(
          [
            `[monorepo] failed applying patch: ${subject || patchFile}`,
            fromSha ? `[monorepo] from: ${fromSha}` : '',
            applyCheckErr ? `[monorepo] apply --check:\n${applyCheckErr}` : '',
            err ? `[monorepo] git am:\n${err}` : '',
            '[monorepo] fix: resolve conflicts then run `git am --continue` (or abort with `git am --abort`)',
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      // Best-effort mode: abort and continue.
      // eslint-disable-next-line no-await-in-loop
      await run('git', ['am', '--abort'], { cwd: targetRepoRoot, stdio: 'ignore' }).catch(() => {});
    }
  }

  spin?.succeed?.(
    `Applied patches into ${targetLabel} ${dim(`(applied=${applied.length} skipped=${skippedAlreadyApplied.length + skippedAlreadyExistsIdentical.length} failed=${failed.length})`)}`
  );
  return {
    applied,
    skippedAlreadyApplied,
    skippedAlreadyExistsIdentical,
    failed,
  };
}

async function portOne({
  label,
  sourcePath,
  sourceRef,
  sourceBase,
  targetRepoRoot,
  targetSubdir,
  dryRun,
  threeWay,
  skipApplied,
  continueOnFailure,
  quietGit,
  progress,
}) {
  const sourceRepoRoot = await resolveGitRoot(sourcePath);
  if (!sourceRepoRoot) {
    throw new Error(`[monorepo] ${label}: not a git repo: ${sourcePath}`);
  }
  const sourceIsMonorepo = isHappyMonorepoRoot(sourceRepoRoot);
  // If the source is already a monorepo, its patches already contain `packages/happy-*/` (or legacy `expo-app/`, `cli/`, etc).
  // In that case, applying with `--directory <subdir>/` would double-prefix paths.
  const effectiveTargetSubdir = sourceIsMonorepo ? '' : targetSubdir;
  const head = (await git(sourceRepoRoot, ['rev-parse', '--verify', sourceRef || 'HEAD'])).trim();
  const baseRef = sourceBase || (await resolveDefaultBaseRef(sourceRepoRoot));
  if (!baseRef) {
    throw new Error(`[monorepo] ${label}: could not infer a base ref. Pass --${label}-base=<ref>.`);
  }
  const base = (await git(sourceRepoRoot, ['merge-base', baseRef, head])).trim();
  if (!base) {
    throw new Error(`[monorepo] ${label}: failed to compute merge-base for ${baseRef}..${head}`);
  }
  if (base === head) {
    return { label, sourceRepoRoot, baseRef, head, patches: 0, skipped: true, reason: 'no commits to port' };
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-port-'));
  try {
    const patches = await formatPatchesToDir({
      sourceRepoRoot,
      base,
      head,
      outDir: tmp,
      progressLabel: label,
      progress,
    });
    if (dryRun) {
      return {
        label,
        sourceRepoRoot,
        sourceIsMonorepo,
        baseRef,
        head,
        patches: patches.length,
        skipped: false,
        dryRun: true,
        targetSubdir: effectiveTargetSubdir || null,
      };
    }
    const res = await applyPatches({
      targetRepoRoot,
      directory: effectiveTargetSubdir,
      patches,
      threeWay,
      skipApplied,
      continueOnFailure,
      quietGit,
      progress,
    });
    return {
      label,
      sourceRepoRoot,
      sourceIsMonorepo,
      baseRef,
      head,
      patches: patches.length,
      appliedPatches: res.applied.length,
      skippedAlreadyApplied: res.skippedAlreadyApplied.length,
      skippedAlreadyExistsIdentical: res.skippedAlreadyExistsIdentical.length,
      failedPatches: res.failed.length,
      report: res,
      skipped: false,
      targetSubdir: effectiveTargetSubdir || null,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdPortRun({ argv, flags, kv, json, silent = false }) {
  const targetArg = (kv.get('--target') ?? '').trim();
  const targetHint = targetArg || process.cwd();
  const progress = createProgressReporter({ enabled: shouldShowProgress({ json, silent }) });
  const targetRepoRoot = await resolveOrCloneTargetRepoRoot({ targetInput: targetHint, targetArg, flags, kv, progress });

  // Prefer a clearer error message if the user is in the middle of conflict resolution.
  // (A git am session often makes the worktree dirty, which would otherwise trigger a generic "not clean" error.)
  await ensureNoGitAmInProgress(targetRepoRoot);
  await ensureCleanGitWorktree(targetRepoRoot);

  const ontoCurrent = flags.has('--onto-current');
  const branchOverride = (kv.get('--branch') ?? '').trim();
  const baseOverride = (kv.get('--base') ?? '').trim();
  const dryRun = flags.has('--dry-run');
  const threeWay = flags.has('--3way');
  const skipApplied = flags.has('--skip-applied');
  const continueOnFailure = flags.has('--continue-on-failure');
  const quietGit = json;
  let baseRefUsed = null;
  let branchLabel = null;
  if (!dryRun) {
    if (ontoCurrent) {
      if (branchOverride) {
        throw new Error('[monorepo] --onto-current cannot be combined with --branch (it applies onto the currently checked-out branch)');
      }
      if (baseOverride) {
        throw new Error('[monorepo] --onto-current cannot be combined with --base (it does not checkout a base ref)');
      }
      baseRefUsed = null;
      branchLabel = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
    } else {
      const baseRef = baseOverride || (await resolveDefaultTargetBaseRef(targetRepoRoot));
      if (!baseRef) {
        throw new Error('[monorepo] could not infer a target base ref. Pass --base=<ref>.');
      }
      baseRefUsed = baseRef;
      const branch = branchOverride || `port/${Date.now()}`;
      branchLabel = branch;
      // Always start the port branch from a stable base (usually origin/main), rather than whatever is currently checked out.
      await git(targetRepoRoot, ['checkout', '--quiet', baseRef]);
      await ensureBranch(targetRepoRoot, branch);
    }
  } else {
    branchLabel = ontoCurrent ? 'onto-current' : branchOverride || `port/${Date.now()}`;
  }

  const sources = [
    {
      label: 'from-happy',
      path: (kv.get('--from-happy') ?? '').trim(),
      ref: (kv.get('--from-happy-ref') ?? '').trim(),
      base: (kv.get('--from-happy-base') ?? '').trim(),
      subdir: happyMonorepoSubdirForComponent('happier-ui', { monorepoRoot: targetRepoRoot }) || 'apps/ui',
    },
    {
      label: 'from-happy-cli',
      path: (kv.get('--from-happy-cli') ?? '').trim(),
      ref: (kv.get('--from-happy-cli-ref') ?? '').trim(),
      base: (kv.get('--from-happy-cli-base') ?? '').trim(),
      subdir: happyMonorepoSubdirForComponent('happier-cli', { monorepoRoot: targetRepoRoot }) || 'apps/cli',
    },
    {
      label: 'from-happy-server',
      path: (kv.get('--from-happy-server') ?? '').trim(),
      ref: (kv.get('--from-happy-server-ref') ?? '').trim(),
      base: (kv.get('--from-happy-server-base') ?? '').trim(),
      subdir: happyMonorepoSubdirForComponent('happier-server', { monorepoRoot: targetRepoRoot }) || 'apps/server',
    },
  ].filter((s) => s.path);

  if (!sources.length) {
    throw new Error('[monorepo] nothing to port. Provide at least one of: --from-happy, --from-happy-cli, --from-happy-server');
  }

  // Already checked above (keep just one check so errors stay consistent).

  const results = [];
  for (const s of sources) {
    // Allow sources to be local paths OR URL/PR specs (cloned into target/.git scratch).
    // eslint-disable-next-line no-await-in-loop
    const resolvedPath = await ensureRepoSpecCheckedOut({
      targetRepoRoot,
      label: s.label,
      spec: s.path,
      desiredRef: s.ref,
      progress,
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await portOne({
      label: s.label,
      sourcePath: resolvedPath,
      sourceRef: s.ref,
      sourceBase: s.base,
      targetRepoRoot,
      targetSubdir: s.subdir,
      dryRun,
      threeWay,
      skipApplied,
      continueOnFailure,
      quietGit,
      progress,
    });
    results.push(r);
  }

  const ok = dryRun || results.every((r) => (r.failedPatches ?? 0) === 0);
  const summary = dryRun
    ? `[monorepo] dry run complete (${branchLabel})`
    : ok
      ? `[monorepo] port complete (${branchLabel})`
      : `[monorepo] port complete with failures (${branchLabel})`;
  const failureDetails = (() => {
    if (json || dryRun || ok) return '';
    const lines = [];
    for (const r of results) {
      const report = r.report;
      const failed = report?.failed ?? [];
      if (!failed.length) continue;
      lines.push('');
      lines.push(`[monorepo] ${r.label}: failed patches (${failed.length})`);
      for (const f of failed.slice(0, 12)) {
        const subj = String(f.subject ?? '').replace(/^\[PATCH \d+\/\d+\]\s*/, '');
        const kind = f.kind ? ` (${f.kind})` : '';
        const paths = (f.paths ?? []).slice(0, 3).join(', ');
        lines.push(`- ${subj || f.patch}${kind}${paths ? ` -> ${paths}` : ''}`);
      }
      if (failed.length > 12) {
        lines.push(`- ...and ${failed.length - 12} more`);
      }
    }
    return lines.join('\n');
  })();

  const hints = ok || json
    ? ''
    : [
        '',
        '[monorepo] next steps:',
        '- for a full machine-readable report: re-run with `--json`.',
        '- to resolve interactively (recommended): re-run without `--continue-on-failure` so it stops at the first conflict, then use `git am --continue`.',
      ].join('\n');

  const data = { ok, targetRepoRoot, branch: branchLabel, ontoCurrent, dryRun, base: baseRefUsed, results };
  if (!silent) {
    printResult({
      json,
      data,
      text: json ? '' : `${summary}${failureDetails}${hints}`,
    });
  }
  return data;
}

async function cmdPortStatus({ kv, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const { inProgress, currentPatch, conflictedFiles } = await readGitAmStatus(targetRepoRoot);
  const branch = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';

  const text = (() => {
    if (json) return '';
    const lines = [];
    const okMark = inProgress ? yellow('!') : green('✓');
    lines.push(`${bold('[monorepo]')} ${bold('port status')} ${dim(`(${branch})`)} ${okMark}`);
    lines.push(`${dim('target:')} ${targetRepoRoot}`);
    lines.push(`${dim('git am in progress:')} ${inProgress ? yellow('yes') : green('no')}`);
    if (inProgress && currentPatch?.subject) {
      lines.push(`${dim('current patch:')} ${cyan(currentPatch.subject)}`);
    }
    if (inProgress && currentPatch?.files?.length) {
      lines.push(
        `${dim('patch files:')} ${currentPatch.files.slice(0, 6).join(', ')}${currentPatch.files.length > 6 ? dim(', ...') : ''}`
      );
    }
    if (conflictedFiles.length) {
      lines.push(`${yellow('conflicted files:')} ${dim(`(${conflictedFiles.length})`)}`);
      for (const f of conflictedFiles.slice(0, 20)) lines.push(`  - ${f}`);
      if (conflictedFiles.length > 20) lines.push(`  - ...and ${conflictedFiles.length - 20} more`);
    }
    if (inProgress) {
      lines.push('');
      lines.push(bold('[monorepo] next steps:'));
      lines.push(`- ${dim('resolve + stage:')} git -C ${targetRepoRoot} add <files>`);
      lines.push(`- ${dim('continue:')}       git -C ${targetRepoRoot} am --continue`);
      lines.push(`- ${dim('skip patch:')}     git -C ${targetRepoRoot} am --skip`);
      lines.push(`- ${dim('abort:')}          git -C ${targetRepoRoot} am --abort`);
      lines.push(`- ${dim('helper:')}         hstack monorepo port continue --target=${targetRepoRoot}`);
    }
    return lines.join('\n');
  })();

  printResult({
    json,
    data: { ok: true, targetRepoRoot, branch, inProgress, currentPatch, conflictedFiles },
    text,
  });
}

function buildPortLlmPromptText({ targetRepoRoot }) {
  const hs = buildhstackRunnerShellSnippet();
  return [
    'You are an assistant helping the user port split-repo commits into the Happier monorepo.',
    '',
    hs,
    `Target monorepo root: ${targetRepoRoot}`,
    '',
    'How to run the port:',
    `- guided (recommended): hs monorepo port guide --target=${targetRepoRoot}`,
    `- machine-readable report: hs monorepo port --target=${targetRepoRoot} --json`,
    '',
    'If a conflict happens (git am in progress):',
    `- inspect state (JSON): hs monorepo port status --target=${targetRepoRoot} --json`,
    `- inspect state (text): hs monorepo port status --target=${targetRepoRoot}`,
    `- after fixing files:       git -C ${targetRepoRoot} am --continue`,
    `- or via wrapper:           hs monorepo port continue --target=${targetRepoRoot}`,
    `- to skip current patch:    git -C ${targetRepoRoot} am --skip`,
    `- to abort:                git -C ${targetRepoRoot} am --abort`,
    '',
    'Instructions:',
    '- Prefer minimal conflict resolutions that preserve intent.',
    '- Conflicts are resolved one patch at a time (git am stops at the first conflict).',
    '- Do not “pre-resolve” hypothetical future conflicts; re-check status after each continue.',
    '- Keep changes scoped to apps/ui/, apps/cli/, apps/server/ (or legacy expo-app/, cli/, server/).',
    '- After each continue, re-check status until port completes.',
  ].join('\n');
}

function buildPortGuideLlmPromptText({ targetRepoRoot, initialCommandArgs }) {
  const parts = Array.isArray(initialCommandArgs) ? initialCommandArgs : [];
  const cmd = ['hs', 'monorepo', ...parts.map((p) => String(p))].join(' ');
  return [
    'You are an assistant helping the user port split-repo commits into the Happier monorepo.',
    '',
    buildhstackRunnerShellSnippet(),
    `Target monorepo root: ${targetRepoRoot}`,
    '',
    'Goal:',
    '- Run the port command.',
    '- If conflicts occur, resolve them cleanly and continue until the port completes.',
    '',
    'Important:',
    '- The port may already be running and stopped on a conflict (git am in progress).',
    `- If running "${cmd}" fails with "git am already in progress", do NOT retry it; use status/continue below.`,
    '',
    'If the port is not started yet, start it (run exactly):',
    cmd,
    '',
    'If it stops with conflicts:',
    `- Inspect status (JSON): hs monorepo port status --target=${targetRepoRoot} --json`,
    `- Resolve conflicted files`,
    `- Stage:  git -C ${targetRepoRoot} add <files>`,
    `- Continue: hs monorepo port continue --target=${targetRepoRoot}`,
    '',
    'Notes:',
    '- Conflicts are resolved one patch at a time (git am stops at the first conflict).',
    '- It’s common for later patches to fail “on paper” until the first conflict is resolved; don’t over-edit.',
    '',
    'Repeat status/resolve/continue until it completes.',
  ].join('\n');
}

async function cmdPortContinue({ kv, flags, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const runAmContinue = async () => {
    const inProgressBefore = await isGitAmInProgress(targetRepoRoot);
    if (!inProgressBefore) return { ok: true, didRun: false };
    const stageWanted = flags?.has?.('--stage') === true || flags?.has?.('--stage-conflicts') === true;
    const { conflictedFiles, currentPatch } = await readGitAmStatus(targetRepoRoot);

    const stageCandidates = conflictedFiles.length
      ? conflictedFiles
      : Array.isArray(currentPatch?.files)
        ? currentPatch.files.filter(Boolean)
        : [];

    if (conflictedFiles.length) {
      if (!stageWanted) {
        const hint = [
          `${yellow('[monorepo]')} continue blocked: ${bold('files still need staging')}`,
          `[monorepo] git reports unmerged files (e.g. ${dim('UU')}). This usually means you resolved them in an editor but forgot ${bold('git add')}.`,
          `[monorepo] conflicted files: ${conflictedFiles.join(', ')}`,
          `[monorepo] next: git -C ${targetRepoRoot} add ${conflictedFiles.map((f) => JSON.stringify(f)).join(' ')}`,
          `[monorepo] then re-run: hstack monorepo port continue --target=${targetRepoRoot}`,
          `[monorepo] tip: you can also run: hstack monorepo port continue --target=${targetRepoRoot} --stage`,
        ].join('\n');
        printResult({
          json,
          data: { ok: false, targetRepoRoot, inProgress: true, conflictedFiles, needsStage: true, currentPatch },
          text: json ? '' : hint,
        });
        process.exitCode = 1;
        return { ok: false, didRun: false };
      }

      const markerHits = await listFilesWithConflictMarkers(targetRepoRoot, stageCandidates);
      if (markerHits.length) {
        const hint = [
          `${yellow('[monorepo]')} refusing to auto-stage: conflict markers still present`,
          `[monorepo] files: ${markerHits.join(', ')}`,
          `[monorepo] next: open the file(s), remove ${dim('<<<<<<< / ======= / >>>>>>>')} markers, then run:`,
          `  git -C ${targetRepoRoot} add ${markerHits.map((f) => JSON.stringify(f)).join(' ')}`,
          `  hstack monorepo port continue --target=${targetRepoRoot}`,
        ].join('\n');
        printResult({
          json,
          data: { ok: false, targetRepoRoot, inProgress: true, conflictedFiles, conflictMarkers: markerHits },
          text: json ? '' : hint,
        });
        process.exitCode = 1;
        return { ok: false, didRun: false };
      }

      await runCapture('git', ['add', '-A', '--', ...stageCandidates], { cwd: targetRepoRoot });
    } else if (stageWanted && stageCandidates.length) {
      const markerHits = await listFilesWithConflictMarkers(targetRepoRoot, stageCandidates);
      if (markerHits.length) {
        const hint = [
          `${yellow('[monorepo]')} refusing to auto-stage: conflict markers still present`,
          `[monorepo] files: ${markerHits.join(', ')}`,
          `[monorepo] next: open the file(s), remove ${dim('<<<<<<< / ======= / >>>>>>>')} markers, then run:`,
          `  git -C ${targetRepoRoot} add ${markerHits.map((f) => JSON.stringify(f)).join(' ')}`,
          `  hstack monorepo port continue --target=${targetRepoRoot}`,
        ].join('\n');
        printResult({
          json,
          data: { ok: false, targetRepoRoot, inProgress: true, conflictedFiles, conflictMarkers: markerHits },
          text: json ? '' : hint,
        });
        process.exitCode = 1;
        return { ok: false, didRun: false };
      }
      await runCapture('git', ['add', '-A', '--', ...stageCandidates], { cwd: targetRepoRoot });
    }
    try {
      await runCapture('git', ['am', '--continue'], { cwd: targetRepoRoot });
      return { ok: true, didRun: true };
    } catch (err) {
      const conflictedFiles = await listConflictedFiles(targetRepoRoot);
      const stderr = String(err?.err ?? err?.message ?? err ?? '').trim();
      const hint = [
        `${red('[monorepo]')} continue failed (still conflicted).`,
        conflictedFiles.length ? `[monorepo] conflicted files: ${conflictedFiles.join(', ')}` : '',
        stderr ? `[monorepo] git:\n${stderr}` : '',
        `[monorepo] next: resolve, stage (${bold('git add')}), then re-run: hstack monorepo port continue --target=${targetRepoRoot}`,
      ]
        .filter(Boolean)
        .join('\n');
      printResult({
        json,
        data: { ok: false, targetRepoRoot, inProgress: true, conflictedFiles },
        text: json ? '' : hint,
      });
      process.exitCode = 1;
      return { ok: false, didRun: true };
    }
  };

  // 1) If an am session is in progress, advance it.
  const amRes = await runAmContinue();
  if (!amRes.ok) return;

  // 2) If we're no longer in an am session, and a guide plan exists, resume the port onto the current branch.
  const inProgressAfter = await isGitAmInProgress(targetRepoRoot);
  const branch = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  if (!inProgressAfter) {
    const { plan } = await readPortPlan(targetRepoRoot);
    if (plan?.resumeArgv && Array.isArray(plan.resumeArgv)) {
      try {
        const resumeArgv = [...plan.resumeArgv];
        const { flags, kv } = parseArgs(resumeArgv);
        const jsonWanted = json || wantsJson(resumeArgv, { flags });
        await cmdPortRun({ argv: resumeArgv, flags, kv, json: jsonWanted, silent: json === true });
        await deletePortPlan(targetRepoRoot);
      } catch {
        // cmdPortRun prints its own conflict context; leave the plan file so the user can retry after resolving.
        process.exitCode = process.exitCode ?? 1;
      }
    }
  }

  const stillInProgress = await isGitAmInProgress(targetRepoRoot);
  printResult({
    json,
    data: { ok: !stillInProgress, targetRepoRoot, branch, inProgress: stillInProgress },
    text: json
      ? ''
      : stillInProgress
        ? `${yellow('[monorepo]')} continue paused (conflicts remain) ${dim(`(${branch})`)}`
        : `${green('[monorepo]')} continue complete ${dim(`(${branch})`)}`,
  });
}

async function runPortPreflightData({ targetRepoRoot, baseRef, threeWay, sources }) {
  const srcs = Array.isArray(sources) ? sources : [];
  if (!targetRepoRoot) throw new Error('[monorepo] preflight: missing targetRepoRoot');
  if (!baseRef) throw new Error('[monorepo] preflight: missing baseRef');
  if (!srcs.length) {
    throw new Error('[monorepo] preflight: nothing to port. Provide at least one source.');
  }

  return await withTempDetachedWorktree({ repoRoot: targetRepoRoot, ref: baseRef, label: 'monorepo-preflight' }, async (worktreeDir) => {
    const preflightArgv = [
      'port',
      `--target=${worktreeDir}`,
      '--onto-current',
      '--json',
      ...(threeWay ? ['--3way'] : []),
      ...srcs.flatMap((s) => [
        `--${s.label}=${s.path}`,
        ...(s.base ? [`--${s.label}-base=${s.base}`] : []),
        ...(s.ref ? [`--${s.label}-ref=${s.ref}`] : []),
      ]),
    ];
    const parsed = parseArgs(preflightArgv);
    try {
      // Run silently; we only care about the returned JSON data.
      const data = await cmdPortRun({ argv: preflightArgv, flags: parsed.flags, kv: parsed.kv, json: true, silent: true });
      return {
        ok: true,
        targetRepoRoot,
        base: baseRef,
        threeWay: Boolean(threeWay),
        failedPatches: 0,
        sourcesWithFailures: 0,
        results: data?.results ?? [],
        firstConflict: null,
      };
    } catch (e) {
      const { inProgress, currentPatch, conflictedFiles } = await readGitAmStatus(worktreeDir);
      if (!inProgress) throw e;
      return {
        ok: false,
        targetRepoRoot,
        base: baseRef,
        threeWay: Boolean(threeWay),
        failedPatches: 1,
        sourcesWithFailures: 1,
        results: [],
        firstConflict: {
          currentPatch,
          conflictedFiles,
        },
      };
    }
  });
}

async function cmdPortPreflight({ argv, flags, kv, json }) {
  const target = (kv.get('--target') ?? '').trim();
  if (!target) throw new Error('[monorepo] preflight: missing --target=/abs/path/to/monorepo');

  const targetRepoRoot = await resolveGitRoot(target);
  if (!targetRepoRoot) throw new Error(`[monorepo] preflight: target is not a git repo: ${target}`);
  if (!isHappyMonorepoRoot(targetRepoRoot)) {
      throw new Error(`[monorepo] preflight: target is not a Happier monorepo root: ${targetRepoRoot}`);
  }

  const threeWay = flags.has('--3way');
  const baseOverride = (kv.get('--base') ?? '').trim();
  const baseRef = baseOverride || (await resolveDefaultTargetBaseRef(targetRepoRoot));
  if (!baseRef) throw new Error('[monorepo] preflight: could not infer a target base ref. Pass --base=<ref>.');

  const sources = [
    {
      label: 'from-happy',
      path: (kv.get('--from-happy') ?? '').trim(),
      ref: (kv.get('--from-happy-ref') ?? '').trim(),
      base: (kv.get('--from-happy-base') ?? '').trim(),
    },
    {
      label: 'from-happy-cli',
      path: (kv.get('--from-happy-cli') ?? '').trim(),
      ref: (kv.get('--from-happy-cli-ref') ?? '').trim(),
      base: (kv.get('--from-happy-cli-base') ?? '').trim(),
    },
    {
      label: 'from-happy-server',
      path: (kv.get('--from-happy-server') ?? '').trim(),
      ref: (kv.get('--from-happy-server-ref') ?? '').trim(),
      base: (kv.get('--from-happy-server-base') ?? '').trim(),
    },
  ].filter((s) => s.path);

  if (!sources.length) {
    throw new Error('[monorepo] preflight: nothing to port. Provide at least one of: --from-happy, --from-happy-cli, --from-happy-server');
  }

  const out = await runPortPreflightData({ targetRepoRoot, baseRef, threeWay, sources });
  const summary = out.ok
    ? `${green('[monorepo]')} preflight: no conflicts detected`
    : `${yellow('[monorepo]')} preflight: conflicts detected ${dim(`(${out.sourcesWithFailures} source(s); may cascade)`)}`;

  printResult({
    json,
    data: out,
    text: json ? '' : summary,
  });
}

async function cmdPortGuide({ kv, flags, json }) {
  if (!isTty()) {
    throw new Error('[monorepo] port guide requires a TTY. Re-run in an interactive terminal.');
  }

  const targetDefault = (kv.get('--target') ?? '').trim() || process.cwd();
  await withRl(async (rl) => {
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        bold(`✨ ${cyan('hstack')} monorepo port ✨`),
        '',
        'This wizard ports commits from split repos into the Happy monorepo layout:',
        `- ${cyan('happy')} → apps/ui/ (or legacy expo-app/)`,
        `- ${cyan('happy-cli')} → apps/cli/ (or legacy cli/)`,
        `- ${cyan('happy-server')} → apps/server/ (or legacy server/)`,
        '',
        bold('Notes:'),
        `- Uses ${cyan('git format-patch')} + ${cyan('git am')} (preserves author + messages)`,
        `- Stops on conflicts so you can resolve and continue`,
        '',
      ].join('\n')
    );

    const targetArg = (kv.get('--target') ?? '').trim();
    const targetInput = targetArg || (await prompt(rl, 'Target monorepo path: ', { defaultValue: targetDefault })).trim();
    let targetRepoRoot = await resolveGitRoot(targetInput);
    if (!targetRepoRoot) {
      const wantsClone = flags?.has?.('--clone-target') || flags?.has?.('--clone');
      // If the target doesn't exist yet, default to cloning without asking (best UX for `--target=...`).
      const targetExists = await pathExists(targetInput);
      if (targetExists && !wantsClone) {
        const shouldClone =
          (await promptSelect(rl, {
            title:
              `${bold('Target directory is not a git repo')}\n` +
              `${dim('Do you want hstack to clone the monorepo into this directory?')}\n` +
              `${dim(targetInput)}`,
            options: [
              { label: `${green('yes (recommended)')} — clone the Happier monorepo into this directory`, value: true },
              { label: 'no — I will provide an existing monorepo checkout', value: false },
            ],
            defaultIndex: 0,
          })) === true;
        if (!shouldClone) {
          throw new Error(`[monorepo] invalid target (expected an existing Happier monorepo checkout): ${targetInput}`);
        }
      }
      const repoUrl = (kv.get('--target-repo') ?? '').trim() || 'https://github.com/happier-dev/happier.git';
      // eslint-disable-next-line no-console
      console.log(dim(`[monorepo] cloning target monorepo -> ${targetInput}`));
      await ensureClonedHappyMonorepo({ targetPath: targetInput, repoUrl });
      targetRepoRoot = await resolveGitRoot(targetInput);
    }
    if (!targetRepoRoot || !isHappyMonorepoRoot(targetRepoRoot)) {
      throw new Error(`[monorepo] invalid target (expected Happier monorepo root): ${targetInput}`);
    }
    const existingPlan = await readPortPlan(targetRepoRoot);
    if (existingPlan?.plan?.resumeArgv && Array.isArray(existingPlan.plan.resumeArgv)) {
      // Resume mode:
      // - do NOT require a clean worktree
      // - do NOT reject if git am is in progress
      // - do NOT re-prompt for options; use the stored plan
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(`${bold('[monorepo]')} guide: resuming existing port plan`);

      const plan = existingPlan.plan;
      const resumeArgv = [...plan.resumeArgv];
      const initialArgv = Array.isArray(plan.initialArgv) ? [...plan.initialArgv] : null;

      // Ensure we are on the intended branch if we can.
      try {
        const intended = String(plan.branch ?? '').trim();
        if (intended && intended !== 'HEAD') {
          const cur = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
          if (cur !== intended) {
            const exists = await gitOk(targetRepoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${intended}`]);
            if (exists) {
              await git(targetRepoRoot, ['checkout', '--quiet', intended]);
            }
          }
        }
      } catch {
        // ignore; we'll still rely on status/continue instructions
      }

      const attemptArgv = initialArgv && !(await gitOk(targetRepoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${String(plan.branch ?? '').trim()}`]))
        ? initialArgv
        : resumeArgv;

      // If git am is already in progress, jump directly to the conflict loop.
      const inProgress = await isGitAmInProgress(targetRepoRoot);
      const { flags: attemptFlags, kv: attemptKv } = parseArgs(resumeArgv);
      const allowAutoLlm = String(process.env.HAPPIER_STACK_DISABLE_LLM_AUTOEXEC ?? '').trim() !== '1';
      const canAutoLaunchLlm = allowAutoLlm && (await detectInstalledLlmTools({ onlyAutoExec: true })).length > 0;
      const preferredConflictMode = String(plan.preferredConflictMode ?? '').trim() || 'guided';

      if (inProgress) {
        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log(`${yellow('[monorepo]')} guide: conflict detected`);
        // eslint-disable-next-line no-console
        console.log(dim('[monorepo] guide: waiting for conflict resolution'));
        // Reuse the same action loop as the main guide path.
        // eslint-disable-next-line no-await-in-loop
        while (await isGitAmInProgress(targetRepoRoot)) {
          await cmdPortStatus({ kv: attemptKv, json: false });
          const action = await promptSelect(rl, {
            title: bold('Resolve conflicts, then choose an action:'),
            options: [
              { label: `${green('continue')} (git am --continue)`, value: 'continue' },
              { label: `${green('stage + continue')} ${dim('(git add conflicted files, then continue)')}`, value: 'stage-continue' },
              { label: `${cyan('show status again')}`, value: 'status' },
              ...(canAutoLaunchLlm
                ? [{ label: `${green('launch LLM now')} ${dim('(recommended)')}`, value: 'llm-launch' }]
                : []),
              { label: `${cyan('llm prompt')} ${dim('(copy/paste)')}`, value: 'llm' },
              { label: `${yellow('skip current patch')} (git am --skip)`, value: 'skip' },
              { label: `${red('abort')} (git am --abort)`, value: 'abort' },
              { label: `${dim('quit guide (leave state as-is)')}`, value: 'quit' },
            ],
            defaultIndex: 0,
          });
          if (action === 'status') continue;
          if (action === 'llm-launch') {
            const promptText = buildPortLlmPromptText({ targetRepoRoot });
            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(bold('[monorepo] launching LLM...'));
            const res = await launchLlmAssistant({
              rl,
              title: 'hstack port conflict',
              subtitle: 'Resolve current git am conflict',
              promptText,
              cwd: targetRepoRoot,
            });
            if (!res.ok) {
              // eslint-disable-next-line no-console
              console.log(`${yellow('!')} Could not auto-launch an LLM (${res.reason || 'unknown'}).`);
            }
            continue;
          }
          if (action === 'llm') {
            const llmFlags = new Set([...(attemptFlags ?? []), '--copy']);
            await cmdPortLlm({ kv: attemptKv, flags: llmFlags, json: false });
            continue;
          }
          if (action === 'abort') {
            await runCapture('git', ['am', '--abort'], { cwd: targetRepoRoot });
            await deletePortPlan(targetRepoRoot);
            throw new Error('[monorepo] guide aborted (git am --abort)');
          }
          if (action === 'skip') {
            await runCapture('git', ['am', '--skip'], { cwd: targetRepoRoot });
            continue;
          }
          if (action === 'quit') {
            throw new Error('[monorepo] guide stopped (git am still in progress). Run `hstack monorepo port status` / `... continue` to proceed.');
          }
          if (action === 'stage-continue') {
            const stageFlags = new Set([...(attemptFlags ?? []), '--stage']);
            await cmdPortContinue({ kv: attemptKv, flags: stageFlags, json: false });
            continue;
          }
          await cmdPortContinue({ kv: attemptKv, flags: attemptFlags, json: false });
        }
        // If am completed, fall through to resume remaining patches below.
      }

      // If we're not in a conflict, just resume applying the remaining patches onto the current branch.
      try {
        const { flags: rFlags, kv: rKv } = parseArgs(attemptArgv);
        const jsonWanted = wantsJson(attemptArgv, { flags: rFlags });
        await cmdPortRun({ argv: attemptArgv, flags: rFlags, kv: rKv, json: jsonWanted });
      } catch (e) {
        const inProgressAfter = await isGitAmInProgress(targetRepoRoot);
        if (!inProgressAfter) throw e;
        // Once the port is paused on conflicts, the conflict loop above will handle it on the next rerun.
        throw e;
      }

      await deletePortPlan(targetRepoRoot);
      // eslint-disable-next-line no-console
      console.log(`${green('[monorepo]')} guide complete`);
      return;
    }

    await ensureCleanGitWorktree(targetRepoRoot);
    await ensureNoGitAmInProgress(targetRepoRoot);

    const baseDefault = await resolveDefaultTargetBaseRef(targetRepoRoot);
    const baseArg = (kv.get('--base') ?? '').trim();
    // Don't prompt unless we truly can't infer.
    const base = baseArg || baseDefault || 'origin/main';
    if (!baseArg && !baseDefault) {
      throw new Error('[monorepo] could not infer a target base ref. Pass --base=<ref>.');
    }

    const branchArg = (kv.get('--branch') ?? '').trim();
    const branch = branchArg || (await prompt(rl, 'New branch name: ', { defaultValue: `port/${Date.now()}` })).trim();

    const use3wayArg = flags?.has?.('--3way') === true;
    const use3way = use3wayArg
      ? true
      : (await promptSelect(rl, {
          title: 'Use 3-way merge (recommended)?',
          options: [
            { label: 'yes (recommended)', value: true },
            { label: 'no', value: false },
          ],
          defaultIndex: 0,
        })) === true;

    const fromHappyArg = (kv.get('--from-happy') ?? '').trim();
    const fromHappyRef = (kv.get('--from-happy-ref') ?? '').trim();
    const fromHappyCliArg = (kv.get('--from-happy-cli') ?? '').trim();
    const fromHappyServerArg = (kv.get('--from-happy-server') ?? '').trim();
    const hasAnySourceArg = Boolean(fromHappyArg || fromHappyCliArg || fromHappyServerArg);

    const fromHappy =
      fromHappyArg ||
      (hasAnySourceArg
        ? ''
        : (await prompt(rl, 'Path or GitHub PR URL for old happy (UI) [optional]: ', { defaultValue: '' })).trim());
    const fromHappyBaseArg = (kv.get('--from-happy-base') ?? '').trim();
    let fromHappyBase = '';
    if (fromHappy) {
      if (fromHappyBaseArg) {
        fromHappyBase = fromHappyBaseArg;
      } else if (looksLikeUrlSpec(fromHappy)) {
        fromHappyBase = 'origin/main';
      } else {
        const root = await resolveGitRoot(fromHappy);
        fromHappyBase = (root && (await resolveDefaultBaseRef(root))) || '';
      }
      if (!fromHappyBase) {
        fromHappyBase = (await prompt(rl, 'old happy base ref: ', { defaultValue: 'upstream/main' })).trim();
      }
    }

    const fromHappyCliRef = (kv.get('--from-happy-cli-ref') ?? '').trim();
    const fromHappyCli =
      fromHappyCliArg ||
      (hasAnySourceArg
        ? ''
        : (await prompt(rl, 'Path or GitHub PR URL for old happy-cli [optional]: ', { defaultValue: '' })).trim());
    const fromHappyCliBaseArg = (kv.get('--from-happy-cli-base') ?? '').trim();
    let fromHappyCliBase = '';
    if (fromHappyCli) {
      if (fromHappyCliBaseArg) {
        fromHappyCliBase = fromHappyCliBaseArg;
      } else if (looksLikeUrlSpec(fromHappyCli)) {
        fromHappyCliBase = 'origin/main';
      } else {
        const root = await resolveGitRoot(fromHappyCli);
        fromHappyCliBase = (root && (await resolveDefaultBaseRef(root))) || '';
      }
      if (!fromHappyCliBase) {
        fromHappyCliBase = (await prompt(rl, 'old happy-cli base ref: ', { defaultValue: 'upstream/main' })).trim();
      }
    }

    const fromHappyServerRef = (kv.get('--from-happy-server-ref') ?? '').trim();
    const fromHappyServer =
      fromHappyServerArg ||
      (hasAnySourceArg
        ? ''
        : (await prompt(rl, 'Path or GitHub PR URL for old happy-server [optional]: ', { defaultValue: '' })).trim());
    const fromHappyServerBaseArg = (kv.get('--from-happy-server-base') ?? '').trim();
    let fromHappyServerBase = '';
    if (fromHappyServer) {
      if (fromHappyServerBaseArg) {
        fromHappyServerBase = fromHappyServerBaseArg;
      } else if (looksLikeUrlSpec(fromHappyServer)) {
        fromHappyServerBase = 'origin/main';
      } else {
        const root = await resolveGitRoot(fromHappyServer);
        fromHappyServerBase = (root && (await resolveDefaultBaseRef(root))) || '';
      }
      if (!fromHappyServerBase) {
        fromHappyServerBase = (await prompt(rl, 'old happy-server base ref: ', { defaultValue: 'upstream/main' })).trim();
      }
    }

    if (!fromHappy && !fromHappyCli && !fromHappyServer) {
      throw new Error('[monorepo] guide: nothing to port. Provide at least one source path.');
    }

    section('Plan');
    noteLine(`${dim('target:')} ${targetRepoRoot}`);
    noteLine(`${dim('base:')}   ${base}`);
    noteLine(`${dim('branch:')} ${branch}`);
    noteLine(`${dim('3-way:')}  ${use3way ? green('enabled') : yellow('disabled')}`);
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Sources:'));
    if (fromHappy) noteLine(`- ${cyan('happy')}      ${fromHappy} ${dim(`(base=${fromHappyBase})`)}`);
    if (fromHappyCli) noteLine(`- ${cyan('happy-cli')}  ${fromHappyCli} ${dim(`(base=${fromHappyCliBase})`)}`);
    if (fromHappyServer) noteLine(`- ${cyan('happy-server')} ${fromHappyServer} ${dim(`(base=${fromHappyServerBase})`)}`);

    const sources = [
      ...(fromHappy ? [{ label: 'from-happy', path: fromHappy, base: fromHappyBase, ref: fromHappyRef }] : []),
      ...(fromHappyCli ? [{ label: 'from-happy-cli', path: fromHappyCli, base: fromHappyCliBase, ref: fromHappyCliRef }] : []),
      ...(fromHappyServer
        ? [{ label: 'from-happy-server', path: fromHappyServer, base: fromHappyServerBase, ref: fromHappyServerRef }]
        : []),
    ];

    section('Preflight');
    const preflight = await runPortPreflightData({ targetRepoRoot, baseRef: base, threeWay: use3way, sources });
    // eslint-disable-next-line no-console
    console.log(
      preflight.ok
        ? `${green('[monorepo]')} preflight: no conflicts detected`
        : `${yellow('[monorepo]')} preflight: conflicts detected ${dim(`(${preflight.sourcesWithFailures} source(s); may cascade)`)}`
    );
    const previewLines = summarizePreflightFailures(preflight);
    if (previewLines.length) {
      section('First likely conflict (preview)');
      for (const l of previewLines) {
        // eslint-disable-next-line no-console
        console.log(l.startsWith('  ') ? dim(l) : l);
      }
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(
        dim(
          'Tip: If the first patch fails, many later patches can fail in preflight too (cascading). ' +
            'In the real port run, git am stops at the first conflict — resolve it first, then continue.'
        )
      );
    }

    const allowAutoLlm = String(process.env.HAPPIER_STACK_DISABLE_LLM_AUTOEXEC ?? '').trim() !== '1';
    const canAutoLaunchLlm = allowAutoLlm && (await detectInstalledLlmTools({ onlyAutoExec: true })).length > 0;
    let preferredConflictMode = 'guided';
    if (!preflight.ok) {
      preferredConflictMode = await promptSelect(rl, {
        title:
          `${bold('Preflight detected conflicts')}\n` +
          `${dim('How do you want to proceed? (You can still change your mind later in the conflict loop.)')}`,
        options: [
          ...(canAutoLaunchLlm
            ? [{ label: `${green('LLM (recommended)')} — run the port and resolve conflicts automatically`, value: 'llm' }]
            : []),
          { label: `${cyan('guided')} — resolve conflicts manually as they occur`, value: 'guided' },
          { label: `${dim('quit')} — exit without starting the port`, value: 'quit' },
        ],
        defaultIndex: canAutoLaunchLlm ? 0 : 0,
      });
    }
    if (preferredConflictMode === 'quit') {
      throw new Error('[monorepo] guide cancelled (no changes made).');
    }

    const baseSourceArgs = [
      ...(fromHappy ? [`--from-happy=${fromHappy}`, `--from-happy-base=${fromHappyBase}`, ...(fromHappyRef ? [`--from-happy-ref=${fromHappyRef}`] : [])] : []),
      ...(fromHappyCli
        ? [
            `--from-happy-cli=${fromHappyCli}`,
            `--from-happy-cli-base=${fromHappyCliBase}`,
            ...(fromHappyCliRef ? [`--from-happy-cli-ref=${fromHappyCliRef}`] : []),
          ]
        : []),
      ...(fromHappyServer
        ? [
            `--from-happy-server=${fromHappyServer}`,
            `--from-happy-server-base=${fromHappyServerBase}`,
            ...(fromHappyServerRef ? [`--from-happy-server-ref=${fromHappyServerRef}`] : []),
          ]
        : []),
    ];

    const initialArgv = [
      'port',
      `--target=${targetRepoRoot}`,
      `--branch=${branch}`,
      `--base=${base}`,
      ...(use3way ? ['--3way'] : []),
      ...baseSourceArgs,
      ...(json ? ['--json'] : []),
    ];

    const resumeArgv = [
      'port',
      `--target=${targetRepoRoot}`,
      '--onto-current',
      ...(use3way ? ['--3way'] : []),
      ...baseSourceArgs,
      ...(json ? ['--json'] : []),
    ];

    await writePortPlan(targetRepoRoot, {
      version: 2,
      createdAt: new Date().toISOString(),
      targetRepoRoot,
      base,
      branch,
      use3way,
      preferredConflictMode,
      sources,
      initialArgv,
      resumeArgv,
    });

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`${bold('[monorepo]')} guide: starting port ${dim(`(${branch})`)}`);

    let llmLaunched = false;
    let first = true;
    while (true) {
      const attemptArgv = first ? initialArgv : resumeArgv;
      first = false;
      const { flags: attemptFlags, kv: attemptKv } = parseArgs(attemptArgv);
      const jsonWanted = wantsJson(attemptArgv, { flags: attemptFlags });
      try {
        // eslint-disable-next-line no-await-in-loop
        await cmdPortRun({ argv: attemptArgv, flags: attemptFlags, kv: attemptKv, json: jsonWanted });
        break;
      } catch (e) {
        // If we stopped because of a git am conflict, drive an interactive resolution loop.
        // Otherwise, rethrow.
        // eslint-disable-next-line no-await-in-loop
        const inProgress = await isGitAmInProgress(targetRepoRoot);
        if (!inProgress) {
          throw e;
        }

        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log(`${yellow('[monorepo]')} guide: conflict detected`);
        // eslint-disable-next-line no-console
        console.log(dim('[monorepo] guide: waiting for conflict resolution'));

        while (await isGitAmInProgress(targetRepoRoot)) {
          // eslint-disable-next-line no-await-in-loop
          await cmdPortStatus({ kv: attemptKv, json: false });

          if (preferredConflictMode === 'llm' && canAutoLaunchLlm && !llmLaunched) {
            const promptText = buildPortGuideLlmPromptText({ targetRepoRoot, initialCommandArgs: initialArgv });
            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(bold('[monorepo] launching LLM to resolve conflicts...'));
            // eslint-disable-next-line no-await-in-loop
            const res = await launchLlmAssistant({
              rl,
              title: 'hstack monorepo port',
              subtitle: 'Resolve conflicts and complete the port',
              promptText,
              cwd: targetRepoRoot,
              allowRunHere: true,
              allowCopyOnly: true,
            });
            llmLaunched = true;

            if (!res.ok) {
              // eslint-disable-next-line no-console
              console.log(`${yellow('!')} Could not auto-launch an LLM (${res.reason || 'unknown'}).`);
            } else if (res.mode === 'new-terminal') {
              // eslint-disable-next-line no-console
              console.log('');
              // eslint-disable-next-line no-console
              console.log(`${bold('Press Enter')} once the LLM finishes to re-check status.`);
              // eslint-disable-next-line no-await-in-loop
              await prompt(rl, '', { defaultValue: '' });
            } else if (res.mode === 'copy') {
              // eslint-disable-next-line no-console
              console.log('');
              // eslint-disable-next-line no-console
              console.log(`${bold('Press Enter')} once you finish running the prompt to re-check status.`);
              // eslint-disable-next-line no-await-in-loop
              await prompt(rl, '', { defaultValue: '' });
            }
            continue;
          }

          const action = await promptSelect(rl, {
            title: bold('Resolve conflicts, then choose an action:'),
            options: [
              { label: `${green('continue')} (git am --continue)`, value: 'continue' },
              { label: `${green('stage + continue')} ${dim('(git add conflicted files, then continue)')}`, value: 'stage-continue' },
              { label: `${cyan('show status again')}`, value: 'status' },
              ...(canAutoLaunchLlm ? [{ label: `${green('launch LLM now')} ${dim('(recommended)')}`, value: 'llm-launch' }] : []),
              { label: `${cyan('llm prompt')} ${dim('(copy/paste)')}`, value: 'llm' },
              { label: `${yellow('skip current patch')} (git am --skip)`, value: 'skip' },
              { label: `${red('abort')} (git am --abort)`, value: 'abort' },
              { label: `${dim('quit guide (leave state as-is)')}`, value: 'quit' },
            ],
            defaultIndex: 0,
          });

          if (action === 'status') {
            continue;
          }
          if (action === 'llm-launch') {
            const promptText = buildPortLlmPromptText({ targetRepoRoot });
            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(bold('[monorepo] launching LLM...'));
            // eslint-disable-next-line no-await-in-loop
            const res = await launchLlmAssistant({
              rl,
              title: 'hstack port conflict',
              subtitle: 'Resolve current git am conflict',
              promptText,
              cwd: targetRepoRoot,
            });
            if (!res.ok) {
              // eslint-disable-next-line no-console
              console.log(`${yellow('!')} Could not auto-launch an LLM (${res.reason || 'unknown'}).`);
            }
            continue;
          }
          if (action === 'llm') {
            const llmFlags = new Set([...(attemptFlags ?? []), '--copy']);
            // eslint-disable-next-line no-await-in-loop
            await cmdPortLlm({ kv: attemptKv, flags: llmFlags, json: false });
            continue;
          }
          if (action === 'abort') {
            await runCapture('git', ['am', '--abort'], { cwd: targetRepoRoot });
            await deletePortPlan(targetRepoRoot);
            throw new Error('[monorepo] guide aborted (git am --abort)');
          }
          if (action === 'skip') {
            await runCapture('git', ['am', '--skip'], { cwd: targetRepoRoot });
            continue;
          }
          if (action === 'quit') {
            throw new Error('[monorepo] guide stopped (git am still in progress). Run `hstack monorepo port status` / `... continue` to proceed.');
          }

          if (action === 'stage-continue') {
            const stageFlags = new Set([...(attemptFlags ?? []), '--stage']);
            // eslint-disable-next-line no-await-in-loop
            await cmdPortContinue({ kv: attemptKv, flags: stageFlags, json: false });
            continue;
          }

          // continue
          // eslint-disable-next-line no-await-in-loop
          await cmdPortContinue({ kv: attemptKv, flags: attemptFlags, json: false });
        }
      }
    }

    await deletePortPlan(targetRepoRoot);
    // eslint-disable-next-line no-console
    console.log(`${green('[monorepo]')} guide complete`);
  });
}

async function cmdPortLlm({ kv, flags, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const promptText = buildPortLlmPromptText({ targetRepoRoot });
  const tools = await detectInstalledLlmTools();

  if (json) {
    printResult({ json, data: { targetRepoRoot, prompt: promptText, detectedTools: tools.map((t) => t.id) } });
    return;
  }

  const wantsLaunch = flags?.has?.('--launch') || process.argv.includes('--launch');
  if (wantsLaunch) {
    const launched = await launchLlmAssistant({
      title: 'hstack monorepo port (LLM)',
      subtitle: 'Runs the port + resolves conflicts (one patch at a time).',
      promptText,
      cwd: targetRepoRoot,
      env: process.env,
      allowRunHere: true,
      allowCopyOnly: true,
    });
    if (!launched.ok) {
      // eslint-disable-next-line no-console
      console.log(dim(`[monorepo] LLM launch unavailable: ${launched.reason || 'unknown'}`));
      // fall through to printing the prompt
    } else if (launched.launched) {
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('[monorepo] LLM prompt (copy/paste):'));
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(promptText);
  if (tools.length) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(dim(`[monorepo] detected LLM CLIs: ${tools.map((t) => t.id).join(', ')}`));
  }

  const wantsCopy = flags?.has?.('--copy') || process.argv.includes('--copy');
  if (wantsCopy && (await clipboardAvailable())) {
    const res = await copyTextToClipboard(promptText);
    // eslint-disable-next-line no-console
    console.log(res.ok ? green('✓ Copied to clipboard') : dim(`(Clipboard copy failed: ${res.reason || 'unknown'})`));
  } else if (wantsCopy) {
    // eslint-disable-next-line no-console
    console.log(dim('(Clipboard copy unavailable on this system)'));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags, kv } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });

  const positionals = helpScopeArgv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const cmd = positionals[0] || 'help';
  const sub = positionals[1] || '';
  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });

  const usageByPath = new Map([
    [
      'port',
      ['hstack monorepo port --target=/abs/path/to/monorepo [--clone-target] [--target-repo=<git-url>] [--branch=port/<name>] [--base=<ref>] [--onto-current] [--dry-run] [--3way] [--skip-applied] [--continue-on-failure] [--json]'],
    ],
    ['port guide', ['hstack monorepo port guide [--target=/abs/path/to/monorepo] [--clone-target] [--target-repo=<git-url>] [--json]']],
    ['port preflight', ['hstack monorepo port preflight --target=/abs/path/to/monorepo [--base=<ref>] [--3way] [--json]']],
    ['port status', ['hstack monorepo port status [--target=/abs/path/to/monorepo] [--json]']],
    ['port continue', ['hstack monorepo port continue [--target=/abs/path/to/monorepo] [--json]']],
    [
      'port llm',
      [
        'hstack monorepo port llm --target=/abs/path/to/monorepo [--copy] [--launch] [--json]',
        '  [--from-happy=/abs/path/to/old-happy --from-happy-base=<ref> --from-happy-ref=<ref>]',
        '  [--from-happy-cli=/abs/path/to/old-happy-cli --from-happy-cli-base=<ref> --from-happy-cli-ref=<ref>]',
        '  [--from-happy-server=/abs/path/to/old-happy-server --from-happy-server-base=<ref> --from-happy-server-ref=<ref>]',
      ],
    ],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const key = sub ? `${cmd} ${sub}` : cmd;
    const lines = usageByPath.get(key);
    if (lines?.length) {
      printResult({
        json,
        data: { ok: true, cmd, sub: sub || null, usage: lines[0] ?? null },
        text: [
          `[monorepo ${key}] usage:`,
          ...lines.map((l) => `  ${l}`),
          '',
          'see also:',
          '  hstack monorepo --help',
        ].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({ json, data: {}, text: usage() });
    return;
  }

  if (cmd !== 'port') {
    throw new Error(`[monorepo] unknown subcommand: ${cmd} (expected: port)`);
  }

  if (sub === 'status') {
    await cmdPortStatus({ kv, json });
    return;
  }
  if (sub === 'continue') {
    await cmdPortContinue({ kv, flags, json });
    return;
  }
  if (sub === 'preflight') {
    await cmdPortPreflight({ argv, flags, kv, json });
    return;
  }
  if (sub === 'guide') {
    await cmdPortGuide({ kv, flags, json });
    return;
  }
  if (sub === 'llm') {
    await cmdPortLlm({ kv, flags, json });
    return;
  }

  await cmdPortRun({ argv, flags, kv, json });
}

main().catch((err) => {
  console.error('[monorepo] failed:', err);
  process.exit(1);
});
