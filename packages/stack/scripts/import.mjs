import './utils/env/env.mjs';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { banner, bullets, cmd as cmdFmt, kv as kvFmt, sectionTitle } from './utils/ui/layout.mjs';
import { bold, cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { componentDirEnvKey, getComponentRepoDir, getRootDir, getWorkspaceDir, isHappyMonorepoRoot, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { listAllStackNames, stackExistsSync } from './utils/stack/stacks.mjs';
import { sanitizeStackName } from './utils/stack/names.mjs';
import { sanitizeSlugPart } from './utils/git/refs.mjs';
import { readEnvObjectFromFile } from './utils/env/read.mjs';
import { clipboardAvailable, copyTextToClipboard } from './utils/ui/clipboard.mjs';
import { detectInstalledLlmTools } from './utils/llm/tools.mjs';
import { launchLlmAssistant } from './utils/llm/assist.mjs';
import { buildHappyStacksRunnerShellSnippet } from './utils/llm/happys_runner.mjs';

function usage() {
  return [
    '[import] usage:',
    '  happys import',
    '  happys import inspect [--happy=<path|url>] [--happy-cli=<path|url>] [--happy-server=<path|url>] [--happy-server-light=<path|url>] [--yes] [--json]',
    '  happys import apply --stack=<name> [--server=happy-server|happy-server-light] [--happy=<path|url>] [--happy-ref=<ref>] [--happy-cli=<path|url>] [--happy-cli-ref=<ref>] [--happy-server=<path|url>] [--happy-server-ref=<ref>] [--happy-server-light=<path|url>] [--happy-server-light-ref=<ref>] [--yes] [--json]',
    '  happys import migrate [--stack=<name>]',
    '  happys import llm [--mode=import|migrate] [--stack=<name>] [--copy] [--launch]',
    '  happys import [--json]',
    '',
    'What it does:',
    '- imports legacy split repos (happy / happy-cli / happy-server) into Happy Stacks by pinning stack component paths',
    '- optionally ports commits into the slopus/happy monorepo layout via `happys monorepo port`',
    '',
    'Notes:',
    '- This is for users who still have split repos/branches/PRs (pre-monorepo).',
    '- Migration uses `git format-patch` + `git am` and may require conflict resolution.',
  ].join('\n');
}

function legacyEnvKey(key) {
  return key.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
}

async function gitRoot(dir) {
  const d = resolve(String(dir ?? '').trim());
  if (!d) return '';
  try {
    return (await runCapture('git', ['rev-parse', '--show-toplevel'], { cwd: d })).trim();
  } catch {
    return '';
  }
}

async function gitBranch(dir) {
  try {
    const b = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim();
    return b && b !== 'HEAD' ? b : 'detached';
  } catch {
    return 'unknown';
  }
}

async function gitDirty(dir) {
  try {
    return Boolean((await runCapture('git', ['status', '--porcelain'], { cwd: dir })).trim());
  } catch {
    return false;
  }
}

async function gitOk(cwd, args) {
  try {
    await runCapture('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function listGitWorktrees(repoRoot) {
  // `git worktree list --porcelain` includes the current worktree plus any additional worktrees.
  const out = await runCapture('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const lines = out.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: '', head: '' };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      cur.branch = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
      continue;
    }
    if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
      continue;
    }
    if (line.startsWith('detached')) {
      cur.branch = 'detached';
      continue;
    }
  }
  if (cur) entries.push(cur);

  // Normalize: ensure current worktree comes first and paths are absolute.
  const normalized = entries
    .map((e) => ({ ...e, path: resolve(e.path) }))
    .filter((e) => e.path);
  return normalized;
}

async function listLocalBranches(repoRoot) {
  try {
    const out = await runCapture('git', ['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { cwd: repoRoot });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function looksLikeGitUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (s.startsWith('git@')) return true;
  if (s.startsWith('https://') || s.startsWith('http://')) return true;
  if (s.endsWith('.git')) return true;
  return false;
}

function repoNameFromGitUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'repo';
  // Examples:
  // - https://github.com/org/name.git
  // - git@github.com:org/name.git
  const m = s.match(/[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m?.[2]) return m[2];
  const tail = s.split('/').filter(Boolean).pop() ?? 'repo';
  return tail.replace(/\.git$/, '') || 'repo';
}

async function resolveRepoRootFromPathOrUrl({ rootDir, label, raw, rl }) {
  const input = String(raw ?? '').trim();
  if (!input) return '';

  if (!looksLikeGitUrl(input)) {
    const r = await gitRoot(input);
    if (!r) throw new Error(`[import] ${label}: not a git repo: ${input}`);
    return r;
  }

  // Git URL: clone into the Happy Stacks workspace so it can be pinned reliably.
  const workspaceDir = getWorkspaceDir(rootDir);
  const repoName = repoNameFromGitUrl(input);
  const targetDir = join(workspaceDir, 'imports', 'repos', label, sanitizeSlugPart(repoName));

  if (existsSync(join(targetDir, '.git'))) {
    const reuse = await promptSelect(rl, {
      title: `${bold(label)}\n${dim(`Repo already cloned at ${targetDir}.`)}`,
      options: [
        { label: `reuse existing clone (default)`, value: 'reuse' },
        { label: `fetch latest (${dim('git fetch --all')})`, value: 'fetch' },
      ],
      defaultIndex: 0,
    });
    if (reuse === 'fetch') {
      await run('git', ['fetch', '--all', '--prune'], { cwd: targetDir }).catch(() => {});
    }
    const r = await gitRoot(targetDir);
    if (!r) throw new Error(`[import] ${label}: expected git repo at ${targetDir} (missing)`);
    return r;
  }

  await mkdir(join(targetDir, '..'), { recursive: true });
  // eslint-disable-next-line no-console
  console.log(dim(`Cloning ${label}: ${input} -> ${targetDir}`));
  await run('git', ['clone', input, targetDir], { cwd: workspaceDir });
  const r = await gitRoot(targetDir);
  if (!r) throw new Error(`[import] ${label}: clone succeeded but repo root not found: ${targetDir}`);
  return r;
}

async function resolveRepoRootFromPathOrUrlNonInteractive({ rootDir, label, raw, yes, fetch }) {
  const input = String(raw ?? '').trim();
  if (!input) return '';

  if (!looksLikeGitUrl(input)) {
    const r = await gitRoot(input);
    if (!r) throw new Error(`[import] ${label}: not a git repo: ${input}`);
    return r;
  }

  if (!yes) {
    throw new Error(
      `[import] ${label}: got a git URL but non-interactive mode cannot prompt.\n` +
        `[import] re-run with --yes to allow cloning into the Happy Stacks workspace.\n` +
        `[import] url: ${input}`
    );
  }

  const workspaceDir = getWorkspaceDir(rootDir);
  const repoName = repoNameFromGitUrl(input);
  const targetDir = join(workspaceDir, 'imports', 'repos', label, sanitizeSlugPart(repoName));

  if (existsSync(join(targetDir, '.git'))) {
    if (fetch) {
      await run('git', ['fetch', '--all', '--prune'], { cwd: targetDir }).catch(() => {});
    }
    const r = await gitRoot(targetDir);
    if (!r) throw new Error(`[import] ${label}: expected git repo at ${targetDir} (missing)`);
    return r;
  }

  await mkdir(join(targetDir, '..'), { recursive: true });
  // eslint-disable-next-line no-console
  console.log(dim(`Cloning ${label}: ${input} -> ${targetDir}`));
  await run('git', ['clone', input, targetDir], { cwd: workspaceDir });
  const r = await gitRoot(targetDir);
  if (!r) throw new Error(`[import] ${label}: clone succeeded but repo root not found: ${targetDir}`);
  return r;
}

async function ensureWorktreeForRef({ rootDir, componentLabel, repoRoot, ref }) {
  const r = String(ref ?? '').trim();
  if (!r) return '';

  const workspaceDir = getWorkspaceDir(rootDir);
  const safeRef = sanitizeSlugPart(r);
  const componentSlug = String(componentLabel ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const targetDir = join(workspaceDir, 'imports', 'worktrees', componentSlug, safeRef);

  await mkdir(join(targetDir, '..'), { recursive: true });
  if (existsSync(targetDir)) return targetDir;

  if (!(await gitOk(repoRoot, ['rev-parse', '--verify', '--quiet', r]))) {
    await run('git', ['fetch', '--all', '--prune'], { cwd: repoRoot }).catch(() => {});
  }

  // eslint-disable-next-line no-console
  console.log(dim(`Creating worktree: ${repoRoot} -> ${targetDir} (${r})`));

  // Important:
  // A normal clone has a branch checked out in its "main worktree" already.
  // `git worktree add <dir> <branch>` fails if `<branch>` is currently checked out anywhere.
  //
  // To make `happys import apply` robust for typical contributor setups,
  // create a dedicated, uniquely named branch under the source repo when the ref is a local branch.
  const isLocalBranch = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${r}`]);
  if (isLocalBranch) {
    const importPrefix = `hs-import/${componentSlug}/${safeRef}`;
    let importBranch = importPrefix;
    let i = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${importBranch}`]);
      if (!exists) break;
      i += 1;
      importBranch = `${importPrefix}-${i}`;
      if (i > 50) {
        throw new Error(`[import] could not find a free import branch name for ${r}`);
      }
    }
    await run('git', ['worktree', 'add', '-b', importBranch, targetDir, r], { cwd: repoRoot });
  } else {
    // Commit SHA / tag / remote ref: keep it detached to avoid consuming/locking branches.
    await run('git', ['worktree', 'add', '--detach', targetDir, r], { cwd: repoRoot });
  }
  return targetDir;
}

async function resolveDefaultTargetBaseRef(repoRoot) {
  // Prefer refs/remotes/origin/HEAD when available.
  try {
    const sym = (await runCapture('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repoRoot })).trim();
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(sym);
    if (m?.[1]) {
      const ref = `origin/${m[1]}`;
      if (await gitOk(repoRoot, ['rev-parse', '--verify', '--quiet', ref])) {
        return ref;
      }
    }
  } catch {
    // ignore
  }

  // Fallback candidates.
  for (const c of ['upstream/main', 'origin/main', 'main', 'master']) {
    // eslint-disable-next-line no-await-in-loop
    if (await gitOk(repoRoot, ['rev-parse', '--verify', '--quiet', c])) return c;
  }
  return '';
}

async function createMonorepoPortWorktree({ rootDir, monorepoRepoRoot, slug, baseRef }) {
  const workspaceDir = getWorkspaceDir(rootDir);
  const safe = sanitizeSlugPart(slug || 'port');
  const dir = join(workspaceDir, 'imports', 'monorepo-worktrees', safe);

  await mkdir(join(dir, '..'), { recursive: true });
  if (existsSync(dir)) {
    throw new Error(
      `[import] monorepo worktree path already exists: ${dir}\n` +
        `[import] fix: delete it, or pick a different port branch/slug`
    );
  }

  const ref = String(baseRef ?? '').trim() || (await resolveDefaultTargetBaseRef(monorepoRepoRoot)) || 'main';
  // eslint-disable-next-line no-console
  console.log(dim(`Creating monorepo worktree: ${monorepoRepoRoot} -> ${dir} (${ref})`));
  await run('git', ['worktree', 'add', dir, ref], { cwd: monorepoRepoRoot });
  return dir;
}

async function chooseCheckoutPathForRepo({ rl, rootDir, componentLabel, repoRoot, repoHintLabel }) {
  const worktrees = await listGitWorktrees(repoRoot);
  const branches = await listLocalBranches(repoRoot);

  const currentBranch = await gitBranch(repoRoot);
  const currentDirty = await gitDirty(repoRoot);
  const current = worktrees.find((w) => resolve(w.path) === resolve(repoRoot));

  const options = [];
  if (current) {
    options.push({
      value: { kind: 'path', path: current.path },
      label: `${cyan('current')} — ${dim(current.branch || currentBranch)}${currentDirty ? ` ${yellow('(dirty)')}` : ''} ${dim(current.path)}`,
    });
  } else {
    options.push({
      value: { kind: 'path', path: repoRoot },
      label: `${cyan('current')} — ${dim(currentBranch)}${currentDirty ? ` ${yellow('(dirty)')}` : ''} ${dim(repoRoot)}`,
    });
  }

  const others = worktrees.filter((w) => resolve(w.path) !== resolve(repoRoot));
  for (const w of others.slice(0, 25)) {
    options.push({
      value: { kind: 'path', path: w.path },
      label: `${cyan('worktree')} — ${dim(w.branch || 'detached')} ${dim(w.path)}`,
    });
  }
  if (branches.length) {
    options.push({ value: { kind: 'branch' }, label: `${cyan('other branch')} — create a new worktree under your Happy Stacks workspace` });
  }

  const picked = await promptSelect(rl, {
    title:
      `${bold(componentLabel)}\n` +
      `${dim(`Pick which checkout to import from this repo${repoHintLabel ? ` (${repoHintLabel})` : ''}.`)}`,
    options,
    defaultIndex: 0,
  });

  if (picked?.kind === 'path') {
    return { path: picked.path, branch: await gitBranch(picked.path) };
  }

  // Branch -> create worktree under workspace (recommended).
  const branch = await promptSelect(rl, {
    title: `${bold(componentLabel)}\n${dim('Pick a branch to import (we will create a dedicated worktree for it).')}`,
    options: branches.slice(0, 80).map((b) => ({ label: b, value: b })),
    defaultIndex: 0,
  });
  const workspaceDir = getWorkspaceDir(rootDir);
  const safe = sanitizeSlugPart(String(branch ?? 'branch'));
  const componentSlug = componentLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const targetDir = join(workspaceDir, 'imports', 'worktrees', componentSlug, safe);

  // eslint-disable-next-line no-console
  console.log(dim(`Creating worktree: ${repoRoot} -> ${targetDir} (${branch})`));

  // Create only the parent directory; git worktree add expects the target dir to NOT exist.
  await mkdir(join(targetDir, '..'), { recursive: true });
  if (existsSync(targetDir)) {
    throw new Error(`[import] worktree path already exists: ${targetDir}\n[import] fix: delete it or pick a different branch name/slug`);
  }

  // Same reasoning as ensureWorktreeForRef(): avoid trying to check out the exact same branch in 2 worktrees.
  const importPrefix = `hs-import/${componentSlug}/${safe}`;
  let importBranch = importPrefix;
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${importBranch}`]);
    if (!exists) break;
    i += 1;
    importBranch = `${importPrefix}-${i}`;
    if (i > 50) throw new Error(`[import] could not find a free import branch name for ${branch}`);
  }
  await run('git', ['worktree', 'add', '-b', importBranch, targetDir, branch], { cwd: repoRoot });

  return { path: targetDir, branch: importBranch };
}

async function ensureStackExists({ rootDir, stackName, serverComponent }) {
  const name = sanitizeStackName(stackName);
  if (!name) throw new Error('[import] invalid stack name');
  if (stackExistsSync(name)) return name;
  await run(process.execPath, [join(rootDir, 'scripts/stack.mjs'), 'new', name, `--server=${serverComponent}`], { cwd: rootDir });
  return name;
}

async function pinStackComponentDirs({ stackName, pins }) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  const updates = [];
  for (const [component, path] of Object.entries(pins)) {
    if (!path) continue;
    const key = componentDirEnvKey(component);
    updates.push({ key, value: path });
    updates.push({ key: legacyEnvKey(key), value: path });
  }
  await ensureEnvFileUpdated({ envPath, updates });
  return envPath;
}

async function resolveDefaultMonorepoRoot({ rootDir }) {
  const repoDir = getComponentRepoDir(rootDir, 'happy');
  if (repoDir && existsSync(repoDir) && isHappyMonorepoRoot(repoDir)) return repoDir;
  return '';
}

async function runMonorepoPort({ rootDir, targetMonorepoRoot, sources, branch, dryRun }) {
  // Use guided mode only when we expect conflicts (or when the user wants it).
  const args = [
    'port',
    ...(dryRun ? [] : ['guide']),
    `--target=${targetMonorepoRoot}`,
    `--branch=${branch}`,
    '--3way',
    ...(dryRun ? ['--dry-run'] : []),
  ];
  if (sources.happy) args.push(`--from-happy=${sources.happy}`);
  if (sources['happy-cli']) args.push(`--from-happy-cli=${sources['happy-cli']}`);
  if (sources['happy-server']) args.push(`--from-happy-server=${sources['happy-server']}`);
  await run(process.execPath, [join(rootDir, 'scripts/monorepo.mjs'), ...args], { cwd: rootDir });
}

async function runMonorepoPortRun({ rootDir, targetMonorepoRoot, sources, branch }) {
  const args = ['port', `--target=${targetMonorepoRoot}`, `--branch=${branch}`, '--3way', '--json'];
  if (sources.happy) args.push(`--from-happy=${sources.happy}`);
  if (sources['happy-cli']) args.push(`--from-happy-cli=${sources['happy-cli']}`);
  if (sources['happy-server']) args.push(`--from-happy-server=${sources['happy-server']}`);
  const out = await runCapture(process.execPath, [join(rootDir, 'scripts/monorepo.mjs'), ...args], { cwd: rootDir });
  return JSON.parse(String(out ?? '').trim() || '{}');
}

async function runMonorepoPortPreflight({ rootDir, targetMonorepoRoot, sources }) {
  const args = ['port', 'preflight', `--target=${targetMonorepoRoot}`, '--3way', '--json'];
  if (sources.happy) args.push(`--from-happy=${sources.happy}`);
  if (sources['happy-cli']) args.push(`--from-happy-cli=${sources['happy-cli']}`);
  if (sources['happy-server']) args.push(`--from-happy-server=${sources['happy-server']}`);
  const out = await runCapture(process.execPath, [join(rootDir, 'scripts/monorepo.mjs'), ...args], { cwd: rootDir });
  return JSON.parse(String(out ?? '').trim() || '{}');
}

function summarizePreflightFailures(preflight) {
  const results = Array.isArray(preflight?.results) ? preflight.results : [];
  const lines = [];
  for (const r of results) {
    const failed = r?.report?.failed ?? [];
    if (!Array.isArray(failed) || failed.length === 0) continue;
    const label = String(r.label ?? '').trim() || 'source';
    lines.push(`- ${cyan(label)}: ${failed.length} failed patch(es)`);
    for (const f of failed.slice(0, 5)) {
      const subj = String(f.subject ?? '').replace(/^\[PATCH \d+\/\d+\]\s*/, '');
      const kind = f.kind ? ` (${f.kind})` : '';
      const paths = (f.paths ?? []).slice(0, 3).join(', ');
      lines.push(`  - ${subj || f.patch}${kind}${paths ? ` → ${paths}` : ''}`);
    }
    if (failed.length > 5) lines.push(`  - ...and ${failed.length - 5} more`);
  }
  return lines;
}

function summarizePins(pins) {
  const lines = [];
  for (const [k, v] of Object.entries(pins)) {
    if (!v) continue;
    lines.push(`- ${dim(k)}: ${v}`);
  }
  return lines;
}

function readPinnedComponentDirFromEnvObject(envObj, component) {
  const key = componentDirEnvKey(component);
  const legacyKey = legacyEnvKey(key);
  const raw = (envObj?.[key] ?? envObj?.[legacyKey] ?? '').toString().trim();
  return raw || '';
}

function buildLlmPromptForImport() {
  const hs = buildHappyStacksRunnerShellSnippet();
  return [
    'You are an assistant helping the user migrate legacy Happy split repos into Happy Stacks.',
    '',
    hs,
    'Goals:',
    '- Import legacy split repos (happy / happy-cli / happy-server) into a stack in Happy Stacks.',
    '- Optionally migrate commits into the slopus/happy monorepo layout (packages/happy-* or legacy expo-app/cli/server).',
    '',
    'How to proceed:',
    '1) Run the guided import wizard:',
    '   - `hs import`',
    '',
    'Non-interactive (LLM-friendly) variant:',
    '- Inspect candidate repos/worktrees/branches (JSON):',
    '   - `hs import inspect --happy=<path|url> --happy-cli=<path|url> --happy-server=<path|url> --yes --json`',
    '- Apply pins to a stack (no prompts):',
    '   - `hs import apply --stack=<name> --server=happy-server-light --happy=<path|url> --happy-ref=<ref> --happy-cli=<path|url> --happy-cli-ref=<ref> --happy-server=<path|url> --happy-server-ref=<ref> --yes`',
    '2) If you want to migrate an existing imported stack later:',
    '   - `hs import migrate --stack=<stack>`',
    '',
    'Conflict handling (monorepo port):',
    '- Prefer guided mode: `hs monorepo port guide --target=<monorepo-root>`',
    '- For machine-readable state, use:',
    '   - `hs monorepo port status --target=<monorepo-root> --json`',
    '   - `hs monorepo port continue --target=<monorepo-root>`',
    '',
    'Important:',
    '- A “stack” is an isolated runtime (ports + data + env) under ~/.happy/stacks/<name>.',
    '- Import pins stack component paths (it does not rewrite history).',
    '- Migration uses git format-patch + git am and may require resolving conflicts.',
  ].join('\n');
}

function buildLlmPromptForMigrate({ stackName }) {
  const hs = buildHappyStacksRunnerShellSnippet();
  return [
    'You are an assistant helping the user migrate an existing Happy Stacks stack to the monorepo.',
    '',
    hs,
    `Target stack: ${stackName || '<stack>'}`,
    '',
    'Goal:',
    '- Port the stack’s pinned split-repo commits into a monorepo worktree (slopus/happy layout).',
    '- Create a new monorepo stack by default (keep the legacy stack intact).',
    '',
    'Command:',
    `- hs import migrate --stack=${stackName || '<stack>'}`,
    '',
    'Conflict handling:',
    '- This uses `hs monorepo port guide` which pauses on conflicts.',
    '- To inspect machine-readably: `hs monorepo port status --target=<monorepo-root> --json`',
  ].join('\n');
}

function buildMonorepoMigrationPrompt({ targetMonorepoRoot, branch, sources }) {
  const args = [
    `hs monorepo port --target=${targetMonorepoRoot} --branch=${branch} --3way`,
    sources.happy ? `--from-happy=${sources.happy}` : '',
    sources['happy-cli'] ? `--from-happy-cli=${sources['happy-cli']}` : '',
    sources['happy-server'] ? `--from-happy-server=${sources['happy-server']}` : '',
  ]
    .filter(Boolean)
    .join(' \\\n+  ');

  return [
    'You are an assistant helping the user migrate split-repo commits into the Happy monorepo layout.',
    '',
    buildHappyStacksRunnerShellSnippet(),
    `Target monorepo worktree: ${targetMonorepoRoot}`,
    `Port branch: ${branch}`,
    '',
    'Goal:',
    '- Run the port command.',
    '- If conflicts occur, resolve them cleanly and continue until complete.',
    '',
    'Start the port:',
    args,
    '',
    'If it stops with conflicts:',
    `- Inspect: hs monorepo port status --target=${targetMonorepoRoot} --json`,
    `- Resolve conflicted files (keep changes scoped to packages/happy-*/ or legacy expo-app/, cli/, server/)`,
    `- Stage:  git -C ${targetMonorepoRoot} add <files>`,
    `- Continue: hs monorepo port continue --target=${targetMonorepoRoot}`,
    '',
    'Repeat status/resolve/continue until ok.',
  ].join('\n');
}

async function cmdLlm({ argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const mode = (kv.get('--mode') ?? '').trim().toLowerCase() || 'import';
  const stackName = sanitizeStackName((kv.get('--stack') ?? '').trim());
  const promptText = mode === 'migrate' ? buildLlmPromptForMigrate({ stackName }) : buildLlmPromptForImport();
  const tools = await detectInstalledLlmTools();

  if (json) {
    printResult({ json, data: { mode, stack: stackName || null, prompt: promptText, detectedTools: tools.map((t) => t.id) } });
    return;
  }

  const wantsLaunch = flags.has('--launch');
  if (wantsLaunch) {
    const launched = await launchLlmAssistant({
      title: 'Happy Stacks import/migrate (LLM)',
      subtitle: 'Guides import and/or runs the monorepo port + conflict resolution.',
      promptText,
      cwd: rootDir,
      env: process.env,
      allowRunHere: true,
      allowCopyOnly: true,
    });
    if (launched.ok && launched.launched) return;
    if (!launched.ok) {
      // eslint-disable-next-line no-console
      console.log(dim(`[import] LLM launch unavailable: ${launched.reason || 'unknown'}`));
    }
    // fall through to printing the prompt
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(banner('LLM prompt', { subtitle: 'Copy-paste this into your LLM to drive import/migration.' }));
  // eslint-disable-next-line no-console
  console.log(promptText);
  if (tools.length) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Detected LLM CLIs'));
    // eslint-disable-next-line no-console
    console.log(
      bullets(tools.map((t) => `- ${dim(t.id)}: ${t.label}${t.note ? ` ${dim(`— ${t.note}`)}` : ''}`))
    );
  }

  const wantsCopy = flags.has('--copy');
  if (wantsCopy && (await clipboardAvailable())) {
    const res = await copyTextToClipboard(promptText);
    // eslint-disable-next-line no-console
    console.log(res.ok ? green('✓ Copied to clipboard') : dim(`(Clipboard copy failed: ${res.reason || 'unknown'})`));
  } else if (wantsCopy) {
    // eslint-disable-next-line no-console
    console.log(dim('(Clipboard copy unavailable on this system)'));
  }
}

async function cmdInspect({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const yes = flags.has('--yes');
  const fetch = flags.has('--fetch');

  const inputs = {
    happy: (kv.get('--happy') ?? '').toString().trim(),
    'happy-cli': (kv.get('--happy-cli') ?? '').toString().trim(),
    'happy-server': (kv.get('--happy-server') ?? '').toString().trim(),
    'happy-server-light': (kv.get('--happy-server-light') ?? '').toString().trim(),
  };

  const repos = {};
  for (const [label, raw] of Object.entries(inputs)) {
    if (!raw) continue;
    // eslint-disable-next-line no-await-in-loop
    const repoRoot = await resolveRepoRootFromPathOrUrlNonInteractive({ rootDir, label, raw, yes, fetch });
    // eslint-disable-next-line no-await-in-loop
    const branch = await gitBranch(repoRoot);
    // eslint-disable-next-line no-await-in-loop
    const dirty = await gitDirty(repoRoot);
    // eslint-disable-next-line no-await-in-loop
    const worktrees = await listGitWorktrees(repoRoot);
    // eslint-disable-next-line no-await-in-loop
    const branches = await listLocalBranches(repoRoot);
    repos[label] = { input: raw, repoRoot, branch, dirty, worktrees, branches };
  }

  printResult({ json, data: { repos } });
}

async function cmdApply({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const yes = flags.has('--yes');
  const fetch = flags.has('--fetch');

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackFromPos = positionals[1] || '';
  const stackName = sanitizeStackName(((kv.get('--stack') ?? stackFromPos) || '').toString().trim());
  if (!stackName) throw new Error('[import] apply: missing --stack=<name>');

  const serverComponent = String(kv.get('--server') ?? 'happy-server-light').trim() || 'happy-server-light';
  if (!['happy-server', 'happy-server-light'].includes(serverComponent)) {
    throw new Error(`[import] apply: invalid --server=${serverComponent} (expected happy-server or happy-server-light)`);
  }

  const spec = {
    happy: { raw: String(kv.get('--happy') ?? '').trim(), ref: String(kv.get('--happy-ref') ?? '').trim() },
    'happy-cli': { raw: String(kv.get('--happy-cli') ?? '').trim(), ref: String(kv.get('--happy-cli-ref') ?? '').trim() },
    'happy-server': { raw: String(kv.get('--happy-server') ?? '').trim(), ref: String(kv.get('--happy-server-ref') ?? '').trim() },
    'happy-server-light': {
      raw: String(kv.get('--happy-server-light') ?? '').trim(),
      ref: String(kv.get('--happy-server-light-ref') ?? '').trim(),
    },
  };

  const pins = {};
  for (const [label, { raw, ref }] of Object.entries(spec)) {
    if (!raw) continue;
    // eslint-disable-next-line no-await-in-loop
    const repoRoot = await resolveRepoRootFromPathOrUrlNonInteractive({ rootDir, label, raw, yes, fetch });
    // eslint-disable-next-line no-await-in-loop
    const worktreePath = ref ? await ensureWorktreeForRef({ rootDir, componentLabel: label, repoRoot, ref }) : '';
    pins[label] = worktreePath || repoRoot;
  }

  const ensured = await ensureStackExists({ rootDir, stackName, serverComponent });
  const envPath = await pinStackComponentDirs({ stackName: ensured, pins });

  if (json) {
    printResult({ json, data: { ok: true, stackName: ensured, serverComponent, envPath, pins } });
    return;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(banner('Import applied', { subtitle: 'Pinned the provided checkouts into the target stack env file.' }));
  // eslint-disable-next-line no-console
  console.log(kvFmt('stack', ensured));
  // eslint-disable-next-line no-console
  console.log(kvFmt('server', serverComponent));
  // eslint-disable-next-line no-console
  console.log(kvFmt('env', envPath));
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(sectionTitle('Pinned components'));
  // eslint-disable-next-line no-console
  console.log(bullets(summarizePins(pins)));
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(sectionTitle('Next'));
  // eslint-disable-next-line no-console
  console.log(bullets([cmdFmt(`happys stack dev ${ensured}`), cmdFmt(`happys import migrate --stack=${ensured}`)]));
}

async function cmdMigrateStack({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const interactive = isTty() && !json;
  if (!interactive) {
    throw new Error('[import] migrate is interactive-only (TTY required).');
  }

  await withRl(async (rl) => {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(
      banner('Migrate a stack to monorepo', {
        subtitle: 'Port the stack’s split-repo commits into a monorepo worktree, then (recommended) create a new monorepo stack.',
      })
    );

    const allStacks = await listAllStackNames();
    const providedStack = (kv.get('--stack') ?? '').trim() || argv.filter((a) => !a.startsWith('--'))[1]?.trim() || '';

    const stackName = providedStack
      ? sanitizeStackName(providedStack)
      : await promptSelect(rl, {
          title: `${bold('Pick a stack to migrate')}\n${dim('We will read its component pins and port those repos into the monorepo layout.')}`,
          options: allStacks.map((s) => ({ label: s, value: s })),
          defaultIndex: allStacks.includes('main') ? Math.max(0, allStacks.indexOf('main') - 1) : 0,
        });

    if (!stackName) throw new Error('[import] missing stack name');
    if (!stackExistsSync(stackName)) {
      throw new Error(`[import] stack does not exist: ${stackName}`);
    }

    const envPath = resolveStackEnvPath(stackName).envPath;
    const envObj = await readEnvObjectFromFile(envPath);
    const pins = {
      happy: readPinnedComponentDirFromEnvObject(envObj, 'happy'),
      'happy-cli': readPinnedComponentDirFromEnvObject(envObj, 'happy-cli'),
      'happy-server': readPinnedComponentDirFromEnvObject(envObj, 'happy-server'),
      'happy-server-light': readPinnedComponentDirFromEnvObject(envObj, 'happy-server-light'),
    };

    const hasAnyPins = Object.values(pins).some(Boolean);
    if (!hasAnyPins) {
      throw new Error(
        `[import] stack ${stackName} does not have any pinned component dirs.\n` +
          `[import] Fix: run ${cmdFmt('happys import')} to create an imported stack first, then re-run migrate.`
      );
    }

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Detected pins'));
    // eslint-disable-next-line no-console
    console.log(bullets(summarizePins(pins)));

    // Choose monorepo target repo to base the worktree on.
    const defaultMonorepo = await resolveDefaultMonorepoRoot({ rootDir });
    let monorepoRepoRoot = defaultMonorepo;
    if (!monorepoRepoRoot) {
      const raw = await prompt(rl, `Monorepo repo path or URL (slopus/happy): `, { defaultValue: '' });
      const r = raw.trim() ? await resolveRepoRootFromPathOrUrl({ rootDir, label: 'happy-monorepo', raw, rl }) : '';
      if (!r || !isHappyMonorepoRoot(r)) {
        throw new Error(
          '[import] target is not a slopus/happy monorepo root ' +
            '(missing packages/happy-app|packages/happy-cli|packages/happy-server or legacy expo-app/cli/server).'
        );
      }
      monorepoRepoRoot = r;
    }

    const portBranchDefault = `port/${sanitizeSlugPart(stackName)}`;
    const portBranchRaw = await prompt(rl, `Monorepo port branch (default: ${portBranchDefault}): `, { defaultValue: portBranchDefault });
    const branch = String(portBranchRaw ?? '').trim() || portBranchDefault;

    // Recommended: do the port into a dedicated worktree so we don't disturb your main monorepo checkout.
    const worktreeMode = await promptSelect(rl, {
      title: `${bold('Where should the port be applied?')}\n${dim('Recommended: create a dedicated monorepo worktree for this port branch.')}`,
      options: [
        { label: `create a dedicated monorepo worktree (${green('recommended')})`, value: 'worktree' },
        { label: `use the existing monorepo checkout ${dim('(advanced)')}`, value: 'in-place' },
      ],
      defaultIndex: 0,
    });

    const targetMonorepoRoot =
      worktreeMode === 'worktree'
        ? await createMonorepoPortWorktree({ rootDir, monorepoRepoRoot, slug: sanitizeSlugPart(branch), baseRef: '' })
        : monorepoRepoRoot;

    // Only pass sources that exist.
    const sources = {};
    if (pins.happy) sources.happy = pins.happy;
    if (pins['happy-cli']) sources['happy-cli'] = pins['happy-cli'];
    if (pins['happy-server']) sources['happy-server'] = pins['happy-server'];
    // Port flow is owned by `happys monorepo port guide` (preflight + auto-apply + conflicts + optional LLM).
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('Migrating', { subtitle: 'Porting commits into the monorepo layout (preflight + guided conflict resolution).' }));
    await runMonorepoPort({ rootDir, targetMonorepoRoot, sources, branch, dryRun: false });

    // After migration: reuse or new stack.
    // eslint-disable-next-line no-console
    console.log('');
    const stackAfter = await promptSelect(rl, {
      title: `${bold('After migration')}\n${dim('Reuse this stack, or create a new monorepo stack to keep the old one intact?')}`,
      options: [
        { label: `create a new stack (${green('recommended')}) — keep legacy stack intact`, value: 'new' },
        { label: `reuse existing stack — switch it to the monorepo checkout`, value: 'reuse' },
      ],
      defaultIndex: 0,
    });

    const migratedStackNameDefault =
      sanitizeStackName(`${stackName}-mono`) || sanitizeStackName(`mono-${stackName}`) || 'mono';
    const migratedStackName =
      stackAfter === 'reuse'
        ? stackName
        : sanitizeStackName(
            (
              await prompt(rl, `New monorepo stack name (default: ${migratedStackNameDefault}): `, {
                defaultValue: migratedStackNameDefault,
              })
            ).trim() || migratedStackNameDefault
          );

    const finalStackName =
      stackAfter === 'reuse'
        ? migratedStackName
        : await ensureStackExists({ rootDir, stackName: migratedStackName, serverComponent: 'happy-server' });

    const monoPins = {};
    if (pins.happy) monoPins.happy = targetMonorepoRoot;
    if (pins['happy-cli']) monoPins['happy-cli'] = targetMonorepoRoot;
    if (pins['happy-server']) monoPins['happy-server'] = targetMonorepoRoot;
    if (pins['happy-server-light']) monoPins['happy-server-light'] = pins['happy-server-light'];
    const finalEnvPath = await pinStackComponentDirs({ stackName: finalStackName, pins: monoPins });

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('Migrated', { subtitle: 'Your monorepo stack is ready.' }));
    // eslint-disable-next-line no-console
    console.log(kvFmt('Stack', cyan(finalStackName)));
    // eslint-disable-next-line no-console
    console.log(kvFmt('Env', finalEnvPath));
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Next'));
    // eslint-disable-next-line no-console
    console.log(bullets([`Run: ${cmdFmt(`happys stack dev ${finalStackName}`)}`]));
  });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const interactive = isTty() && !json;

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { json: true }, text: usage() });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const sub = positionals[0] || '';
  if (sub === 'inspect') {
    await cmdInspect({ rootDir, argv });
    return;
  }
  if (sub === 'apply') {
    await cmdApply({ rootDir, argv });
    return;
  }
  if (sub === 'migrate') {
    await cmdMigrateStack({ rootDir, argv });
    return;
  }
  if (sub === 'llm') {
    await cmdLlm({ argv });
    return;
  }

  if (!interactive) {
    printResult({
      json,
      data: { ok: false },
      text: '[import] This command is currently interactive-only. Re-run in a TTY.',
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(
    banner('Import legacy repos', {
      subtitle: 'Bring your pre-monorepo (split repo) work into Happy Stacks, then optionally migrate to monorepo.',
    })
  );
  // eslint-disable-next-line no-console
  console.log(sectionTitle('Key concepts'));
  // eslint-disable-next-line no-console
  console.log(
    bullets([
      `${bold('components')}: the main codebases (UI = ${cyan('happy')}, CLI/daemon = ${cyan('happy-cli')}, server = ${cyan('happy-server')})`,
      `${bold('stack')}: an isolated runtime (ports + data + env) under ${dim('~/.happy/stacks/<name>')}`,
      `${bold('import')}: pin a stack to your existing repo checkouts (so you can run your work as-is)`,
      `${bold('migrate')}: port your split-repo commits into the monorepo layout via ${cyan('happys monorepo port')}`,
    ])
  );

  await withRl(async (rl) => {
    const repos = { happy: '', 'happy-cli': '', 'happy-server': '', 'happy-server-light': '' };

    const collectRepos = async () => {
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(sectionTitle('Your repos'));
      // eslint-disable-next-line no-console
      console.log(
        bullets([
          `Paste a ${bold('local path')} or a ${bold('git URL')} (GitHub HTTPS/SSH).`,
          `If you paste a URL, we clone it into your Happy Stacks workspace under ${dim('imports/repos/...')}.`,
          `Tip: if you already have a worktree checked out on the branch you want, paste that worktree path.`,
        ])
      );

      const uiRaw = await prompt(rl, `${cyan('happy')} (UI) path or URL: `, { defaultValue: repos.happy ? repos.happy : '' });
      const cliRaw = await prompt(rl, `${cyan('happy-cli')} (CLI/daemon) path or URL: `, {
        defaultValue: repos['happy-cli'] ? repos['happy-cli'] : '',
      });
      const serverRaw = await prompt(rl, `${cyan('happy-server')} (server) path or URL: `, {
        defaultValue: repos['happy-server'] ? repos['happy-server'] : '',
      });
      const serverLightRaw = await prompt(rl, `${cyan('happy-server-light')} (optional) path or URL: `, {
        defaultValue: repos['happy-server-light'] ? repos['happy-server-light'] : '',
      });

      repos.happy = uiRaw.trim() ? await resolveRepoRootFromPathOrUrl({ rootDir, label: 'happy', raw: uiRaw, rl }) : '';
      repos['happy-cli'] = cliRaw.trim()
        ? await resolveRepoRootFromPathOrUrl({ rootDir, label: 'happy-cli', raw: cliRaw, rl })
        : '';
      repos['happy-server'] = serverRaw.trim()
        ? await resolveRepoRootFromPathOrUrl({ rootDir, label: 'happy-server', raw: serverRaw, rl })
        : '';
      repos['happy-server-light'] = serverLightRaw.trim()
        ? await resolveRepoRootFromPathOrUrl({ rootDir, label: 'happy-server-light', raw: serverLightRaw, rl })
        : '';

      if (!repos.happy && !repos['happy-cli'] && !repos['happy-server'] && !repos['happy-server-light']) {
        throw new Error('[import] no repos provided. Provide at least one path/URL.');
      }
    };

    await collectRepos();

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Import plan'));
    // eslint-disable-next-line no-console
    console.log(dim('We can import multiple branches/stacks in one run. Start with your first one.'));

    while (true) {
      // Step: choose checkouts (branch/worktree) for this stack
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(sectionTitle('Choose what to import'));
      // eslint-disable-next-line no-console
      console.log(dim('We will pin the stack to these exact checkouts so you can run your work as-is.'));

      const selected = {};
      const selectedBranches = [];

      if (repos.happy) {
        const r = await chooseCheckoutPathForRepo({
          rl,
          rootDir,
          componentLabel: 'happy',
          repoRoot: repos.happy,
          repoHintLabel: 'UI',
        });
        selected.happy = r.path;
        if (r.branch && r.branch !== 'unknown' && r.branch !== 'detached') selectedBranches.push(r.branch);
      }
      if (repos['happy-cli']) {
        const r = await chooseCheckoutPathForRepo({
          rl,
          rootDir,
          componentLabel: 'happy-cli',
          repoRoot: repos['happy-cli'],
          repoHintLabel: 'CLI/daemon',
        });
        selected['happy-cli'] = r.path;
        if (r.branch && r.branch !== 'unknown' && r.branch !== 'detached') selectedBranches.push(r.branch);
      }
      if (repos['happy-server']) {
        const r = await chooseCheckoutPathForRepo({
          rl,
          rootDir,
          componentLabel: 'happy-server',
          repoRoot: repos['happy-server'],
          repoHintLabel: 'server',
        });
        selected['happy-server'] = r.path;
        if (r.branch && r.branch !== 'unknown' && r.branch !== 'detached') selectedBranches.push(r.branch);
      }
      if (repos['happy-server-light']) {
        const includeServerLight = await promptSelect(rl, {
          title: `${bold('happy-server-light')}\n${dim('Optional: also pin server-light for this stack?')}`,
          options: [
            { label: 'no (default)', value: false },
            { label: 'yes', value: true },
          ],
          defaultIndex: 0,
        });
        if (includeServerLight) {
          const r = await chooseCheckoutPathForRepo({
            rl,
            rootDir,
            componentLabel: 'happy-server-light',
            repoRoot: repos['happy-server-light'],
            repoHintLabel: 'server-light (sqlite)',
          });
          selected['happy-server-light'] = r.path;
          if (r.branch && r.branch !== 'unknown' && r.branch !== 'detached') selectedBranches.push(r.branch);
        }
      }

      // Step: stack selection
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(sectionTitle('Stack'));
      // eslint-disable-next-line no-console
      console.log(dim('A stack is an isolated runtime. Create a new stack per feature/branch (recommended).'));

      const existing = await listAllStackNames();
      const canReuse = existing.length > 0;
      const stackMode = await promptSelect(rl, {
        title: `${bold('Where should this imported work run?')}`,
        options: [
          { label: `create a new stack (${green('recommended')})`, value: 'new' },
          ...(canReuse ? [{ label: `reuse an existing stack ${dim('(advanced)')}`, value: 'reuse' }] : []),
        ],
        defaultIndex: 0,
      });

      const inferredBase =
        selectedBranches.length && selectedBranches.every((b) => b === selectedBranches[0]) ? selectedBranches[0] : 'import';
      const defaultStackName = sanitizeStackName(inferredBase) || 'import';

      let stackName = '';
      if (stackMode === 'reuse') {
        stackName = await promptSelect(rl, {
          title: `${bold('Pick a stack to reuse')}\n${dim('We will update its component pins to point at your selected checkouts.')}`,
          options: existing.map((s) => ({ label: s, value: s })),
          defaultIndex: 0,
        });
      } else {
        const raw = await prompt(rl, `New stack name (default: ${defaultStackName}): `, { defaultValue: defaultStackName });
        stackName = sanitizeStackName(raw.trim() || defaultStackName);
      }
      if (!stackName) throw new Error('[import] missing stack name');

      const serverComponentDefault = selected['happy-server-light'] ? 0 : 1;
      const serverComponent = await promptSelect(rl, {
        title: `${bold('Server flavor for this stack')}\n${dim('Pick how you want to run the server for this imported work.')}`,
        options: [
          { label: `${cyan('happy-server-light')} (${green('recommended')}) — easier local dev`, value: 'happy-server-light' },
          { label: `${cyan('happy-server')} — full server (Docker-managed infra)`, value: 'happy-server' },
        ],
        defaultIndex: serverComponentDefault,
      });

      // Apply pins
      const ensuredStack = await ensureStackExists({ rootDir, stackName, serverComponent });
      const envPath = await pinStackComponentDirs({ stackName: ensuredStack, pins: selected });

      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(banner('Imported', { subtitle: 'Your stack is now pinned to your existing repo checkouts.' }));
      // eslint-disable-next-line no-console
      console.log(kvFmt('Stack', cyan(ensuredStack)));
      // eslint-disable-next-line no-console
      console.log(kvFmt('Env', envPath));
      // eslint-disable-next-line no-console
      console.log(sectionTitle('Pinned components'));
      // eslint-disable-next-line no-console
      console.log(bullets(summarizePins(selected)));
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(dim(`Tip: run it with ${cmdFmt(`happys stack dev ${ensuredStack}`)} (or ${cmdFmt(`happys stack start ${ensuredStack}`)}).`));

      // Optional migration
      // eslint-disable-next-line no-console
      console.log('');
      const migrateWanted = await promptSelect(rl, {
        title: `${bold('Migrate to monorepo?')}\n${dim(
          'Optional: port split-repo commits into the monorepo layout (packages/happy-* or legacy expo-app/cli/server).'
        )}`,
        options: [
          { label: `no (default) — keep running from split repos`, value: 'no' },
          { label: `yes (${green('recommended')}) — port commits into a monorepo branch`, value: 'yes' },
          { label: `dry run — preview what would be ported`, value: 'dry-run' },
        ],
        defaultIndex: 0,
      });

      if (migrateWanted !== 'no') {
        const defaultTarget = await resolveDefaultMonorepoRoot({ rootDir });
        let monorepoRepoRoot = defaultTarget;
        if (!monorepoRepoRoot) {
          // eslint-disable-next-line no-console
          console.log(
            `${yellow('!')} No monorepo checkout detected in your Happy Stacks workspace yet.\n` +
              dim(`Fix: run ${cmdFmt('happys setup --profile=dev')} (or ${cmdFmt('happys bootstrap')}) first, then re-run import.`)
          );
          const raw = await prompt(rl, `Monorepo target path (slopus/happy root): `, { defaultValue: '' });
          monorepoRepoRoot = raw.trim() ? await gitRoot(raw.trim()) : '';
          if (!monorepoRepoRoot || !isHappyMonorepoRoot(monorepoRepoRoot)) {
            throw new Error(
              '[import] target is not a slopus/happy monorepo root ' +
                '(missing packages/happy-app|packages/happy-cli|packages/happy-server or legacy expo-app/cli/server).'
            );
          }
        }

        const portBranchDefault = `port/${sanitizeSlugPart(ensuredStack || 'import')}`;
        const portBranch = await prompt(rl, `Monorepo port branch (default: ${portBranchDefault}): `, {
          defaultValue: portBranchDefault,
        });
        const branch = String(portBranch ?? '').trim() || portBranchDefault;

        if (migrateWanted === 'dry-run') {
          // Also show the "what would be ported" preview (patch count only).
          // eslint-disable-next-line no-console
          console.log('');
          // eslint-disable-next-line no-console
          console.log(banner('Dry run', { subtitle: 'Previewing what would be ported (does not apply patches).' }));
          await runMonorepoPort({ rootDir, targetMonorepoRoot: monorepoRepoRoot, sources: selected, branch, dryRun: true });
          // eslint-disable-next-line no-console
          console.log(green('✓ Dry run complete'));
        } else {
          // Choose where to apply the real port (only needed when we actually run it).
          const worktreeMode = await promptSelect(rl, {
            title: `${bold('Where should the port be applied?')}\n${dim('Recommended: create a dedicated monorepo worktree for this port branch.')}`,
            options: [
              { label: `create a dedicated monorepo worktree (${green('recommended')})`, value: 'worktree' },
              { label: `use the existing monorepo checkout ${dim('(advanced)')}`, value: 'in-place' },
            ],
            defaultIndex: 0,
          });

          const targetMonorepoRoot =
            worktreeMode === 'worktree'
              ? await createMonorepoPortWorktree({ rootDir, monorepoRepoRoot, slug: sanitizeSlugPart(branch), baseRef: '' })
              : monorepoRepoRoot;

          let migrationCompleted = false;
          try {
            // This delegates all port logic to `happys monorepo port guide` (preflight + auto-apply + conflicts + optional LLM).
            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(banner('Migrating', { subtitle: 'Porting commits into the monorepo layout (guided).' }));
            await runMonorepoPort({ rootDir, targetMonorepoRoot, sources: selected, branch, dryRun: false });
            migrationCompleted = true;
          } catch (e) {
            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(`${yellow('!')} Migration stopped ${dim(`(${String(e?.message ?? e ?? 'unknown')})`)}`);
            // eslint-disable-next-line no-console
            console.log(dim('You can retry later by re-running import and choosing migration again.'));
            migrationCompleted = false;
          }

          if (migrationCompleted) {
            // eslint-disable-next-line no-console
            console.log('');
            const stackAfter = await promptSelect(rl, {
              title: `${bold('After migration')}\n${dim('Do you want to reuse the same stack or create a new stack for the monorepo branch?')}`,
              options: [
                { label: `create a new stack (${green('recommended')}) — keep legacy stack intact`, value: 'new' },
                { label: `reuse existing stack — switch it to the monorepo checkout`, value: 'reuse' },
              ],
              defaultIndex: 0,
            });

            const migratedStackNameDefault =
              sanitizeStackName(`${ensuredStack}-mono`) || sanitizeStackName(`mono-${ensuredStack}`) || 'mono';
            const migratedStackName =
              stackAfter === 'reuse'
                ? ensuredStack
                : sanitizeStackName(
                    (
                      await prompt(rl, `New monorepo stack name (default: ${migratedStackNameDefault}): `, {
                        defaultValue: migratedStackNameDefault,
                      })
                    ).trim() || migratedStackNameDefault
                  );

            const migratedServerComponent = selected['happy-server'] ? 'happy-server' : serverComponent;
            const finalStackName =
              stackAfter === 'reuse'
                ? migratedStackName
                : await ensureStackExists({ rootDir, stackName: migratedStackName, serverComponent: migratedServerComponent });

            const monoPins = {};
            if (selected.happy) monoPins.happy = targetMonorepoRoot;
            if (selected['happy-cli']) monoPins['happy-cli'] = targetMonorepoRoot;
            if (selected['happy-server']) monoPins['happy-server'] = targetMonorepoRoot;
            // Keep server-light pinned if user opted into it (server-light is not ported by monorepo port today).
            if (selected['happy-server-light']) monoPins['happy-server-light'] = selected['happy-server-light'];

            const finalEnvPath = await pinStackComponentDirs({ stackName: finalStackName, pins: monoPins });

            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log(banner('Migrated', { subtitle: 'Your monorepo stack is ready.' }));
            // eslint-disable-next-line no-console
            console.log(kvFmt('Stack', cyan(finalStackName)));
            // eslint-disable-next-line no-console
            console.log(kvFmt('Env', finalEnvPath));
            // eslint-disable-next-line no-console
            console.log(sectionTitle('Next'));
            // eslint-disable-next-line no-console
            console.log(
              bullets([
                `Run: ${cmdFmt(`happys stack dev ${finalStackName}`)}`,
                `If you need to import more branches later, re-run: ${cmdFmt('happys import')}`,
              ])
            );
          }
        }
      }

      // Loop
      // eslint-disable-next-line no-console
      console.log('');
      const again = await promptSelect(rl, {
        title: `${bold('Import another branch/stack?')}`,
        options: [
          { label: 'no (default)', value: 'no' },
          { label: 'yes — import another branch into another stack', value: 'yes' },
          { label: `yes — change repo inputs first ${dim('(advanced)')}`, value: 'change-repos' },
        ],
        defaultIndex: 0,
      });
      if (again === 'no') break;
      if (again === 'change-repos') {
        await collectRepos();
      }
    }
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.message ?? err) + '\n');
  process.exit(1);
});
