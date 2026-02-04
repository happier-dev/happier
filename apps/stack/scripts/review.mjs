import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { coerceHappyMonorepoRootFromPath, getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { assertCliPrereqs } from './utils/cli/prereqs.mjs';
import { resolveBaseRef } from './utils/review/base_ref.mjs';
import { isStackMode, resolveDefaultStackReviewComponents } from './utils/review/targets.mjs';
import { planCommitChunks } from './utils/review/chunks.mjs';
import { planPathSlices } from './utils/review/slices.mjs';
import { createHeadSliceCommits, getChangedOps } from './utils/review/head_slice.mjs';
import { runWithConcurrencyLimit } from './utils/proc/parallel.mjs';
import { runCodeRabbitReview } from './utils/review/runners/coderabbit.mjs';
import { extractCodexReviewFromJsonl, runCodexReview } from './utils/review/runners/codex.mjs';
import { detectAugmentAuthError, runAugmentReview } from './utils/review/runners/augment.mjs';
import { formatTriageMarkdown, parseCodeRabbitPlainOutput, parseCodexReviewText } from './utils/review/findings.mjs';
import { runSlicedJobs } from './utils/review/sliced_runner.mjs';
import { seedAugmentHomeFromRealHome, seedCodeRabbitHomeFromRealHome, seedCodexHomeFromRealHome } from './utils/review/tool_home_seed.mjs';
import { join } from 'node:path';
import { ensureDir } from './utils/fs/ops.mjs';
import { copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runCapture } from './utils/proc/proc.mjs';
import { withDetachedWorktree } from './utils/review/detached_worktree.mjs';

const VALID_TARGETS = ['ui', 'cli', 'server'];
const DEFAULT_TARGETS = VALID_TARGETS;
const VALID_COMPONENTS = ['happier-ui', 'happier-cli', 'happier-server'];
const VALID_REVIEWERS = ['coderabbit', 'codex', 'augment'];
const VALID_DEPTHS = ['deep', 'normal'];
const VALID_CHANGE_TYPES = ['committed', 'uncommitted', 'all'];
const DEFAULT_REVIEW_MAX_FILES = 50;

function parseCsv(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeReviewers(list) {
  const raw = Array.isArray(list) ? list : [];
  const lower = raw.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  const uniq = Array.from(new Set(lower));
  return uniq.length ? uniq : ['coderabbit'];
}

function normalizeChangeType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return 'committed';
  if (VALID_CHANGE_TYPES.includes(t)) return t;
  throw new Error(`[review] invalid --type=${raw} (expected: ${VALID_CHANGE_TYPES.join(' | ')})`);
}

function usage() {
  return [
    '[review] usage:',
    '  hstack tools review [ui|cli|server|all] [--reviewers=coderabbit,codex,augment] [--type=committed|uncommitted|all] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--concurrency=N] [--depth=deep|normal] [--chunks|--no-chunks] [--chunking=auto|head-slice|commit-window] [--chunk-max-files=N] [--coderabbit-type=committed|uncommitted|all] [--coderabbit-max-files=N] [--coderabbit-chunks|--no-coderabbit-chunks] [--codex-chunks|--no-codex-chunks] [--augment-chunks|--no-augment-chunks] [--augment-model=<id>] [--augment-max-turns=N] [--run-label=<label>] [--no-stream] [--json]',
    '',
    'targets:',
    `  ${[...VALID_TARGETS, 'all'].join(' | ')}`,
    '',
    'reviewers:',
    `  ${VALID_REVIEWERS.join(' | ')}`,
    '',
    'depth:',
    `  ${VALID_DEPTHS.join(' | ')}`,
    '',
    'notes:',
    '- If run from inside a repo checkout/worktree and no targets are provided, defaults to the inferred app (ui/cli/server).',
    '- In stack mode, if no targets are provided, defaults to reviewing only when the stack is pinned to a non-default repo/worktree.',
    '',
    'examples:',
    '  hstack tools review',
    '  hstack tools review cli --reviewers=coderabbit,codex',
    '  hstack tools review ui --base-remote=upstream --base-branch=main',
  ].join('\n');
}

function resolveComponentFromCwdOrNull({ rootDir, invokedCwd }) {
  return inferComponentFromCwd({ rootDir, invokedCwd, components: VALID_COMPONENTS });
}

function stackRemoteFallbackFromEnv(env) {
  return String(env.HAPPIER_STACK_STACK_REMOTE ?? '').trim();
}

function targetFromLegacyComponent(component) {
  const c = String(component ?? '').trim();
  if (c === 'happier-ui') return 'ui';
  if (c === 'happier-cli') return 'cli';
  if (c === 'happier-server' || c === 'happier-server-light') return 'server';
  return null;
}

function legacyComponentFromTarget(target) {
  const t = String(target ?? '').trim();
  if (t === 'ui') return 'happier-ui';
  if (t === 'cli') return 'happier-cli';
  if (t === 'server') return 'happier-server';
  return null;
}

function normalizeTargets(rawTargets) {
  const requested = Array.isArray(rawTargets) ? rawTargets.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  if (!requested.length) return ['all'];
  const mapped = requested
    .map((t) => {
      const lower = t.toLowerCase();
      if (lower === 'all') return 'all';
      if (VALID_TARGETS.includes(lower)) return lower;
      const legacy = targetFromLegacyComponent(lower);
      return legacy ?? null;
    })
    .filter(Boolean);
  return mapped.length ? mapped : ['all'];
}

function sanitizeLabel(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tailLines(text, n) {
  const lines = String(text ?? '')
    .split('\n')
    .slice(-n)
    .join('\n')
    .trimEnd();
  return lines;
}

function detectCodeRabbitAuthError({ stdout, stderr }) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
  return combined.includes('Authentication required') && combined.includes("coderabbit auth login");
}

function detectCodexUsageLimit({ stdout, stderr }) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();
  return combined.includes('usage limit') || combined.includes('http 429') || combined.includes('status code: 429');
}

function printReviewOperatorGuidance() {
  // Guidance for the human/LLM running the review (not the reviewer model itself).
  // eslint-disable-next-line no-console
  console.log(
    [
      '[review] operator guidance:',
      '- Treat reviewer output as suggestions; verify against best practices + this codebase before applying.',
      '- Triage every single finding (no skipping): apply / adjust / defer-with-rationale.',
      '- Do not apply changes blindly; when uncertain, record in the report for discussion.',
      '- When a suggestion references external standards, verify via official docs (or note what you checked).',
      '- Prefer unified fixes; avoid duplication; avoid brittle tests (no exact wording assertions).',
      '- This command writes a triage checklist file; work through it item-by-item and record decisions + commits.',
      '',
    ].join('\n')
  );
}

function codexScopePathForComponent(component) {
  switch (component) {
    case 'happier-ui':
      return 'apps/ui';
    case 'happier-cli':
      return 'apps/cli';
    case 'happier-server-light':
    case 'happier-server':
      return 'apps/server';
    default:
      return null;
  }
}

function buildCodexDeepPrompt({ component, baseRef, changeType }) {
  const scopePath = codexScopePathForComponent(component);
  const ct = normalizeChangeType(changeType);
  const committedCmd = scopePath
    ? `cd \"$(git rev-parse --show-toplevel)\" && git diff ${baseRef}...HEAD -- ${scopePath}/`
    : `cd \"$(git rev-parse --show-toplevel)\" && git diff ${baseRef}...HEAD`;
  const uncommittedCmd = scopePath
    ? `cd \"$(git rev-parse --show-toplevel)\" && git diff HEAD -- ${scopePath}/`
    : `cd \"$(git rev-parse --show-toplevel)\" && git diff HEAD`;
  const cmds = ct === 'committed' ? [committedCmd] : ct === 'uncommitted' ? [uncommittedCmd] : [committedCmd, uncommittedCmd];

  return [
    'Run a deep, long-form code review.',
    '',
    `Change type: ${ct}`,
    ct === 'uncommitted' ? 'Base for review: (uncommitted-only)' : `Base for review: ${baseRef}`,
    scopePath ? `Scope: ${scopePath}/` : 'Scope: full repo (no path filter)',
    '',
    'Instructions:',
    ...cmds.map((c) => `- Use: ${c}`),
    ct !== 'committed' ? '- Include untracked files (if any): git status --porcelain=v1' : null,
    '- Focus on correctness, edge cases, reliability, performance, and security.',
    '- Prefer unified/coherent fixes; avoid duplication.',
    '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
    '- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings; add translation keys across locales as needed.',
    '- Treat every recommendation as a suggestion: validate it against best practices and this codebase’s existing patterns. Do not propose changes that violate project invariants.',
    '- Be exhaustive: list all findings you notice, not only the highest-signal ones.',
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildCodexMonorepoDeepPrompt({ baseRef, changeType }) {
  const ct = normalizeChangeType(changeType);
  const committedCmd = `cd \"$(git rev-parse --show-toplevel)\" && git diff ${baseRef}...HEAD`;
  const uncommittedCmd = `cd \"$(git rev-parse --show-toplevel)\" && git diff HEAD`;
  const cmds = ct === 'committed' ? [committedCmd] : ct === 'uncommitted' ? [uncommittedCmd] : [committedCmd, uncommittedCmd];
  return [
    'Run a deep, long-form code review on the monorepo.',
    '',
    `Change type: ${ct}`,
    ct === 'uncommitted' ? 'Base for review: (uncommitted-only)' : `Base for review: ${baseRef}`,
    'Scope: full repo',
    '',
    'Instructions:',
    ...cmds.map((c) => `- Use: ${c}`),
    ct !== 'committed' ? '- Include untracked files (if any): git status --porcelain=v1' : null,
    '- You may inspect any file in the repo for cross-references (server/cli/ui).',
    '- Focus on correctness, edge cases, reliability, performance, and security.',
    '- Prefer unified/coherent fixes; avoid duplication.',
    '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
    '- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings; add translation keys across locales as needed.',
    '- Treat every recommendation as a suggestion: validate it against best practices and this codebase’s existing patterns. Do not propose changes that violate project invariants.',
    '- Be exhaustive: list all findings you notice, not only the highest-signal ones.',
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildCodexMonorepoSlicePrompt({ sliceLabel, baseCommit, baseRef }) {
  const diffCmd = `cd \"$(git rev-parse --show-toplevel)\" && git diff ${baseCommit}...HEAD`;
  return [
    'Run a deep, long-form code review on the monorepo.',
    '',
    `Base ref: ${baseRef}`,
    `Slice: ${sliceLabel}`,
    '',
    'Important:',
    '- The base commit for this slice is synthetic: it represents upstream plus all NON-slice changes.',
    '- Therefore, the diff below contains ONLY the changes for this slice, but the checked-out code is the full final HEAD.',
    '',
    'Instructions:',
    `- Use: ${diffCmd}`,
    '- You may inspect any file in the repo for cross-references (server/cli/ui), but keep findings scoped to this slice diff.',
    '- Focus on correctness, edge cases, reliability, performance, and security.',
    '- Prefer unified/coherent fixes; avoid duplication.',
    '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
    '- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings; add translation keys across locales as needed.',
    '- Treat every recommendation as a suggestion: validate it against best practices and this codebase’s existing patterns. Do not propose changes that violate project invariants.',
    '- Be exhaustive within this slice: list all findings you notice, not only the highest-signal ones.',
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ].join('\n');
}

async function gitLines({ cwd, args, env }) {
  const out = await runCapture('git', args, { cwd, env });
  return String(out ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

async function countChangedFiles({ cwd, base, env }) {
  const lines = await gitLines({ cwd, env, args: ['diff', '--name-only', `${base}...HEAD`] });
  return lines.length;
}

async function countChangedFilesBetween({ cwd, base, head, env }) {
  const lines = await gitLines({ cwd, env, args: ['diff', '--name-only', `${base}...${head}`] });
  return lines.length;
}

async function mergeBase({ cwd, a, b, env }) {
  const out = await runCapture('git', ['merge-base', a, b], { cwd, env });
  const mb = String(out ?? '').trim();
  if (!mb) throw new Error('[review] failed to compute merge-base');
  return mb;
}

async function listCommitsBetween({ cwd, base, head, env }) {
  return await gitLines({ cwd, env, args: ['rev-list', '--reverse', `${base}..${head}`] });
}

async function pickCoderabbitBaseCommitForMaxFiles({ cwd, baseRef, maxFiles, env }) {
  const commits = await gitLines({ cwd, env, args: ['rev-list', '--reverse', `${baseRef}..HEAD`] });
  if (!commits.length) return null;

  let lo = 0;
  let hi = commits.length - 1;
  let best = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const startCommit = commits[mid];
    let baseCommit = '';
    try {
      baseCommit = (await runCapture('git', ['rev-parse', `${startCommit}^`], { cwd, env })).toString().trim();
    } catch {
      baseCommit = (await runCapture('git', ['rev-parse', startCommit], { cwd, env })).toString().trim();
    }

    const n = await countChangedFiles({ cwd, env, base: baseCommit });
    if (n <= maxFiles) {
      best = baseCommit;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return best;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const stream = !json && !flags.has('--no-stream');

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const invokedCwd = getInvokedCwd(process.env);
  const positionals = argv.filter((a) => !a.startsWith('--'));

  const reviewers = normalizeReviewers(parseCsv(kv.get('--reviewers') ?? ''));
  for (const r of reviewers) {
    if (!VALID_REVIEWERS.includes(r)) {
      throw new Error(`[review] unknown reviewer: ${r} (expected one of: ${VALID_REVIEWERS.join(', ')})`);
    }
  }

  await assertCliPrereqs({
    git: true,
    coderabbit: reviewers.includes('coderabbit'),
    codex: reviewers.includes('codex'),
    augment: reviewers.includes('augment'),
  });

  const inferred = positionals.length === 0 ? resolveComponentFromCwdOrNull({ rootDir, invokedCwd }) : null;
  if (inferred) {
    // Make downstream getComponentDir() resolve to the inferred repo dir for this run.
    process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
  }

  const inStackMode = isStackMode(process.env);
  const inferredTarget = inferred ? targetFromLegacyComponent(inferred.component) : null;
  const requestedTargets = normalizeTargets(positionals.length ? positionals : inferredTarget ? [inferredTarget] : ['all']);
  const wantAll = requestedTargets.includes('all');

  let targets = wantAll ? DEFAULT_TARGETS : requestedTargets;
  if (!positionals.length && !inferred && inStackMode) {
    const pinned = resolveDefaultStackReviewComponents({ rootDir, components: DEFAULT_TARGETS });
    targets = pinned.length ? pinned : [];
  }

  for (const t of targets) {
    if (!VALID_TARGETS.includes(t)) {
      throw new Error(`[review] unknown target: ${t} (expected one of: ${[...VALID_TARGETS, 'all'].join(', ')})`);
    }
  }

  if (!targets.length) {
    const msg = inStackMode ? '[review] no non-default stack-pinned repo/worktree to review' : '[review] no targets selected';
    printResult({ json, data: { ok: true, skipped: true, reason: msg }, text: msg });
    return;
  }

  const components = targets.map((t) => legacyComponentFromTarget(t)).filter(Boolean);

  const baseRefOverride = (kv.get('--base-ref') ?? '').trim();
  const baseRemoteOverride = (kv.get('--base-remote') ?? '').trim();
  const baseBranchOverride = (kv.get('--base-branch') ?? '').trim();
  const stackRemoteFallback = stackRemoteFallbackFromEnv(process.env);
  const concurrency = (kv.get('--concurrency') ?? '').trim();
  const limit = concurrency ? Number(concurrency) : 4;
  const depth = (kv.get('--depth') ?? 'deep').toString().trim().toLowerCase();
  const changeType = normalizeChangeType(kv.get('--type') ?? kv.get('--review-type') ?? 'committed');
  const coderabbitTypeRaw = (kv.get('--coderabbit-type') ?? '').toString().trim();
  const coderabbitType = coderabbitTypeRaw
    ? (() => {
      try {
        return normalizeChangeType(coderabbitTypeRaw);
      } catch {
        throw new Error(
          `[review] invalid --coderabbit-type=${coderabbitTypeRaw} (expected: ${VALID_CHANGE_TYPES.join(' | ')})`,
        );
      }
    })()
    : changeType;
  const chunkingMode = (kv.get('--chunking') ?? 'auto').toString().trim().toLowerCase();
  const augmentModelFlag = (kv.get('--augment-model') ?? '').toString().trim();
  const augmentMaxTurnsFlag = (kv.get('--augment-max-turns') ?? '').toString().trim();
  const chunkMaxFilesRaw = (kv.get('--chunk-max-files') ?? '').toString().trim();
  const coderabbitMaxFilesRaw = (kv.get('--coderabbit-max-files') ?? '').toString().trim();
  const coderabbitMaxFiles = coderabbitMaxFilesRaw ? Number(coderabbitMaxFilesRaw) : DEFAULT_REVIEW_MAX_FILES;
  const chunkMaxFiles = chunkMaxFilesRaw ? Number(chunkMaxFilesRaw) : coderabbitMaxFiles;
  const globalChunks = flags.has('--chunks') ? true : flags.has('--no-chunks') ? false : null;
  const coderabbitChunksOverride = flags.has('--coderabbit-chunks')
    ? true
    : flags.has('--no-coderabbit-chunks')
      ? false
      : null;
  const codexChunksOverride = flags.has('--codex-chunks') ? true : flags.has('--no-codex-chunks') ? false : null;
  const augmentChunksOverride = flags.has('--augment-chunks') ? true : flags.has('--no-augment-chunks') ? false : null;
  if (!VALID_DEPTHS.includes(depth)) {
    throw new Error(`[review] invalid --depth=${depth} (expected: ${VALID_DEPTHS.join(' | ')})`);
  }
  if (!['auto', 'head-slice', 'commit-window'].includes(chunkingMode)) {
    throw new Error('[review] invalid --chunking (expected: auto|head-slice|commit-window)');
  }

  if (augmentModelFlag) process.env.HAPPIER_STACK_AUGMENT_MODEL = augmentModelFlag;
  if (augmentMaxTurnsFlag) process.env.HAPPIER_STACK_AUGMENT_MAX_TURNS = augmentMaxTurnsFlag;

  const deepInstructionsPath = join(rootDir, 'scripts', 'utils', 'review', 'instructions', 'deep.md');
  const coderabbitConfigFiles = depth === 'deep' ? [deepInstructionsPath] : [];

  if (reviewers.includes('coderabbit')) {
    const coderabbitHomeKey = 'HAPPIER_STACK_CODERABBIT_HOME_DIR';
    if (!(process.env[coderabbitHomeKey] ?? '').toString().trim()) {
      process.env[coderabbitHomeKey] = join(rootDir, '.project', 'coderabbit-home');
    }
    await ensureDir(process.env[coderabbitHomeKey]);

    // Seed CodeRabbit auth/config into the isolated home dir so review runs can be non-interactive.
    // We never print or inspect auth contents.
    try {
      const realHome = (process.env.HOME ?? '').toString().trim();
      const overrideHome = (process.env[coderabbitHomeKey] ?? '').toString().trim();
      if (realHome && overrideHome && realHome !== overrideHome) {
        await seedCodeRabbitHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: overrideHome });
      }
    } catch {
      // ignore (coderabbit will surface auth issues if seeding fails)
    }
  }

  if (reviewers.includes('codex')) {
    const codexHomeKey = 'HAPPIER_STACK_CODEX_HOME_DIR';
    if (!(process.env[codexHomeKey] ?? '').toString().trim()) {
      process.env[codexHomeKey] = join(rootDir, '.project', 'codex-home');
    }
    await ensureDir(process.env[codexHomeKey]);

    if (!(process.env.HAPPIER_STACK_CODEX_SANDBOX ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_CODEX_SANDBOX = 'workspace-write';
    }

    // Seed Codex auth/config into the isolated CODEX_HOME to avoid sandbox permission issues
    // writing under the real ~/.codex. We never print or inspect auth contents.
    try {
      const realHome = (process.env.HOME ?? '').toString().trim();
      const overrideHome = process.env[codexHomeKey];
      if (realHome && overrideHome && realHome !== overrideHome) {
        await seedCodexHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: overrideHome });
      }
    } catch {
      // ignore (codex will surface auth issues if seeding fails)
    }
  }

  if (reviewers.includes('augment')) {
    const augmentHomeKey = 'HAPPIER_STACK_AUGMENT_CACHE_DIR';
    if (!(process.env[augmentHomeKey] ?? '').toString().trim()) {
      process.env[augmentHomeKey] = join(rootDir, '.project', 'augment-home');
    }
    await ensureDir(process.env[augmentHomeKey]);

    // Seed Auggie auth/config into the isolated cache dir so review runs can be non-interactive.
    // We never print or inspect auth contents.
    try {
      const realHome = (process.env.HOME ?? '').toString().trim();
      const overrideHome = process.env[augmentHomeKey];
      if (realHome && overrideHome && realHome !== overrideHome) {
        await seedAugmentHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: overrideHome });
      }
    } catch {
      // ignore (auggie will surface auth issues if seeding fails)
    }
  }

  if (stream) {
    // eslint-disable-next-line no-console
    console.log('[review] note: this can take a long time (up to 60+ minutes per reviewer). No timeout is enforced.');
    printReviewOperatorGuidance();
  }

  const resolved = components.map((component) => ({ component, repoDir: getComponentDir(rootDir, component) }));
  const monoRoots = new Set(resolved.map((x) => coerceHappyMonorepoRootFromPath(x.repoDir)).filter(Boolean));
  if (monoRoots.size > 1) {
    const roots = Array.from(monoRoots).sort();
    throw new Error(
      `[review] multiple monorepo roots detected across selected component dirs:\n` +
        roots.map((r) => `- ${r}`).join('\n') +
        `\n\n` +
        `Fix: ensure all monorepo components (happier-ui/happier-cli/happier-server(-light)) point at the same worktree.\n` +
        `- Stack mode: use \`hstack stack wt <stack> -- use <owner/branch|/abs/path>\`\n` +
        `- One-shot: pass \`--repo=<owner/branch|/abs/path>\` to the stack command you're running`
    );
  }
  const monorepoRoot = monoRoots.size === 1 ? Array.from(monoRoots)[0] : null;

  const jobs = monorepoRoot
    ? [{ component: 'monorepo', repoDir: monorepoRoot, monorepo: true }]
    : resolved.map((x) => ({ component: x.component, repoDir: x.repoDir, monorepo: false }));

  // Review artifacts: always create a per-run directory containing raw outputs + a triage checklist.
  const reviewsRootDir = join(rootDir, '.project', 'reviews');
  await ensureDir(reviewsRootDir);
  const runLabelOverride = (kv.get('--run-label') ?? '').toString().trim();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim();
  const defaultLabel = `review-${ts}${stackName ? `-${sanitizeLabel(stackName)}` : ''}`;
  const runLabel = sanitizeLabel(runLabelOverride || defaultLabel) || defaultLabel;
  const runDir = join(reviewsRootDir, runLabel);
  await ensureDir(runDir);
  await ensureDir(join(runDir, 'raw'));

  const jobResults = await runWithConcurrencyLimit({
    items: jobs,
    limit,
    fn: async (job) => {
      const { component, repoDir, monorepo } = job;
      const base = await resolveBaseRef({
        cwd: repoDir,
        baseRefOverride,
        baseRemoteOverride,
        baseBranchOverride,
        stackRemoteFallback,
      });

      const maxFiles = Number.isFinite(chunkMaxFiles) && chunkMaxFiles > 0 ? chunkMaxFiles : 300;
      const sliceConcurrency = Math.max(1, Math.floor(limit / Math.max(1, reviewers.length)));
      const wantChunksCoderabbit = coderabbitType === 'committed' ? (coderabbitChunksOverride ?? globalChunks) : false;
      const wantChunksCodex = changeType === 'committed' ? (codexChunksOverride ?? globalChunks) : false;
      const wantChunksAugment = changeType === 'committed' ? (augmentChunksOverride ?? globalChunks) : false;
      const effectiveChunking = chunkingMode === 'auto' ? (monorepo ? 'head-slice' : 'commit-window') : chunkingMode;

      if (monorepo && stream) {
        // eslint-disable-next-line no-console
        console.log(
          `[review] monorepo detected at ${repoDir}; running a single unified review (chunking=${effectiveChunking}, concurrency=${sliceConcurrency}).`
        );
      }

      const perReviewer = await Promise.all(
        reviewers.map(async (reviewer) => {
          if (reviewer === 'coderabbit') {
            const fileCount = await countChangedFiles({ cwd: repoDir, env: process.env, base: base.baseRef });
            const autoChunks = fileCount > maxFiles;

            let coderabbitBaseCommit = null;
            let note = '';

            // Monorepo: prefer HEAD-sliced chunking so each slice is reviewed in the final HEAD state.
            if (monorepo && effectiveChunking === 'head-slice' && (wantChunksCoderabbit ?? autoChunks)) {
              const headCommit = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: process.env })).trim();
              const baseCommit = (await runCapture('git', ['rev-parse', base.baseRef], { cwd: repoDir, env: process.env })).trim();
              const ops = await getChangedOps({ cwd: repoDir, baseRef: baseCommit, headRef: headCommit, env: process.env });
              const slices = planPathSlices({ changedPaths: Array.from(ops.all), maxFiles });

              const sliceItems = slices.map((slice, i) => ({ slice, index: i + 1, of: slices.length }));
              const sliceResults = await runSlicedJobs({
                items: sliceItems,
                limit: sliceConcurrency,
                run: async ({ slice, index, of }) => {
                  const logFile = join(runDir, 'raw', `coderabbit-slice-${index}-of-${of}-${sanitizeLabel(slice.label)}.log`);
                  const rr = await withDetachedWorktree(
                    { repoDir, headCommit: baseCommit, label: `coderabbit-${index}-of-${of}`, env: process.env },
                    async (worktreeDir) => {
                      const { baseSliceCommit } = await createHeadSliceCommits({
                        cwd: worktreeDir,
                        env: process.env,
                        baseRef: baseCommit,
                        headCommit,
                        ops,
                        slicePaths: slice.paths,
                        label: slice.label.replace(/\/+$/g, ''),
                      });
                      return await runCodeRabbitReview({
                        repoDir: worktreeDir,
                        baseRef: null,
                        baseCommit: baseSliceCommit,
                        env: process.env,
                        type: coderabbitType,
                        configFiles: coderabbitConfigFiles,
                        streamLabel: stream ? `monorepo:coderabbit:${index}/${of}` : undefined,
                        teeFile: logFile,
                        teeLabel: `monorepo:coderabbit:${index}/${of}`,
                      });
                    }
                  );
                  return {
                    index,
                    of,
                    slice: slice.label,
                    fileCount: slice.paths.length,
                    logFile,
                    ok: Boolean(rr.ok),
                    exitCode: rr.exitCode,
                    signal: rr.signal,
                    durationMs: rr.durationMs,
                    stdout: rr.stdout ?? '',
                    stderr: rr.stderr ?? '',
                  };
                },
                shouldAbortEarly: (r) => detectCodeRabbitAuthError({ stdout: r?.stdout, stderr: r?.stderr }),
              });

              if (sliceResults.length === 1 && detectCodeRabbitAuthError(sliceResults[0])) {
                const msg = `[review] coderabbit auth required: run 'coderabbit auth login' in an interactive session, then re-run this review.`;
                // eslint-disable-next-line no-console
                console.error(msg);
              }

              const okAll = sliceResults.every((r) => r.ok);
              return {
                reviewer,
                ok: okAll,
                exitCode: okAll ? 0 : 1,
                signal: null,
                durationMs: sliceResults.reduce((acc, r) => acc + (r.durationMs ?? 0), 0),
                stdout: '',
                stderr: '',
                note: `monorepo head-slice: ${sliceResults.length} slices (maxFiles=${maxFiles})`,
                slices: sliceResults,
              };
            }

            // Non-monorepo or non-sliced: optionally chunk by commit windows (older behavior).
            if (coderabbitType === 'committed' && fileCount > maxFiles && effectiveChunking === 'commit-window' && (wantChunksCoderabbit ?? false)) {
              // fall through to commit-window chunking below
            } else if (coderabbitType === 'committed' && fileCount > maxFiles && (wantChunksCoderabbit === false || wantChunksCoderabbit == null)) {
              coderabbitBaseCommit = await pickCoderabbitBaseCommitForMaxFiles({
                cwd: repoDir,
                env: process.env,
                baseRef: base.baseRef,
                maxFiles,
              });
              note = coderabbitBaseCommit
                ? `diff too large (${fileCount} files vs limit ${maxFiles}); using --base-commit ${coderabbitBaseCommit} for a partial review`
                : `diff too large (${fileCount} files vs limit ${maxFiles}); unable to pick a --base-commit automatically`;
              // eslint-disable-next-line no-console
              console.log(`[review] coderabbit: ${note}`);
            }

            if (!(coderabbitType === 'committed' && fileCount > maxFiles && effectiveChunking === 'commit-window' && (wantChunksCoderabbit ?? false))) {
              const logFile = join(runDir, 'raw', `coderabbit-${sanitizeLabel(component)}.log`);
              const baseRefForType = coderabbitType === 'uncommitted' ? null : coderabbitBaseCommit ? null : base.baseRef;
              const res = await runCodeRabbitReview({
                repoDir,
                baseRef: baseRefForType,
                baseCommit: coderabbitBaseCommit,
                env: process.env,
                type: coderabbitType,
                configFiles: coderabbitConfigFiles,
                streamLabel: stream ? `${component}:coderabbit` : undefined,
                teeFile: logFile,
                teeLabel: `${component}:coderabbit`,
              });
              return {
                reviewer,
                ok: Boolean(res.ok),
                exitCode: res.exitCode,
                signal: res.signal,
                durationMs: res.durationMs,
                stdout: res.stdout ?? '',
                stderr: res.stderr ?? '',
                note,
                logFile,
              };
            }

            // Chunked mode: split the commit range into <=maxFiles windows and review each window by
            // running CodeRabbit in a detached worktree checked out at the window head.
            const mb = await mergeBase({ cwd: repoDir, env: process.env, a: base.baseRef, b: 'HEAD' });
            const commits = await listCommitsBetween({ cwd: repoDir, env: process.env, base: mb, head: 'HEAD' });
            const planned = await planCommitChunks({
              baseCommit: mb,
              commits,
              maxFiles,
              countFilesBetween: async ({ base: baseCommit, head }) =>
                await countChangedFilesBetween({ cwd: repoDir, env: process.env, base: baseCommit, head }),
            });

            const chunks = planned.map((ch) => ({
              baseCommit: ch.base,
              headCommit: ch.head,
              fileCount: ch.fileCount,
              overLimit: Boolean(ch.overLimit),
            }));

            const chunkResults = [];
            for (let i = 0; i < chunks.length; i += 1) {
              const ch = chunks[i];
              const logFile = join(
                runDir,
                'raw',
                `coderabbit-${sanitizeLabel(component)}-window-${i + 1}-of-${chunks.length}-${String(ch.headCommit).slice(0, 12)}.log`
              );
              // eslint-disable-next-line no-await-in-loop
              const rr = await withDetachedWorktree(
                { repoDir, headCommit: ch.headCommit, label: `coderabbit-${component}-${i + 1}-of-${chunks.length}`, env: process.env },
                async (worktreeDir) => {
                  return await runCodeRabbitReview({
                    repoDir: worktreeDir,
                    baseRef: null,
                    baseCommit: ch.baseCommit,
                    env: process.env,
                    type: coderabbitType,
                    configFiles: coderabbitConfigFiles,
                    streamLabel: stream ? `${component}:coderabbit:${i + 1}/${chunks.length}` : undefined,
                    teeFile: logFile,
                    teeLabel: `${component}:coderabbit:${i + 1}/${chunks.length}`,
                  });
                }
              );
              chunkResults.push({
                index: i + 1,
                of: chunks.length,
                baseCommit: ch.baseCommit,
                headCommit: ch.headCommit,
                fileCount: ch.fileCount,
                overLimit: ch.overLimit,
                logFile,
                ok: Boolean(rr.ok),
                exitCode: rr.exitCode,
                signal: rr.signal,
                durationMs: rr.durationMs,
                stdout: rr.stdout ?? '',
                stderr: rr.stderr ?? '',
              });
            }

            const okAll = chunkResults.every((r) => r.ok);
            return {
              reviewer,
              ok: okAll,
              exitCode: okAll ? 0 : 1,
              signal: null,
              durationMs: chunkResults.reduce((acc, r) => acc + (r.durationMs ?? 0), 0),
              stdout: '',
              stderr: '',
              note: `chunked: ${chunkResults.length} windows (maxFiles=${maxFiles})`,
              chunks: chunkResults,
            };
          }
          if (reviewer === 'codex') {
            const jsonMode = json;
            const usePromptMode = depth === 'deep' || changeType === 'all';
            const fileCount = await countChangedFiles({ cwd: repoDir, env: process.env, base: base.baseRef });
            const autoChunks = usePromptMode && fileCount > maxFiles;

            if (monorepo && effectiveChunking === 'head-slice' && usePromptMode && (wantChunksCodex ?? autoChunks)) {
              const headCommit = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: process.env })).trim();
              const baseCommit = (await runCapture('git', ['rev-parse', base.baseRef], { cwd: repoDir, env: process.env })).trim();
              const ops = await getChangedOps({ cwd: repoDir, baseRef: baseCommit, headRef: headCommit, env: process.env });
              const slices = planPathSlices({ changedPaths: Array.from(ops.all), maxFiles });

              const sliceItems = slices.map((slice, i) => ({ slice, index: i + 1, of: slices.length }));
              const sliceResults = await runSlicedJobs({
                items: sliceItems,
                limit: sliceConcurrency,
                run: async ({ slice, index, of }) => {
                  const logFile = join(runDir, 'raw', `codex-slice-${index}-of-${of}-${sanitizeLabel(slice.label)}.log`);
                  const rr = await withDetachedWorktree(
                    { repoDir, headCommit: baseCommit, label: `codex-${index}-of-${of}`, env: process.env },
                    async (worktreeDir) => {
                      const { baseSliceCommit } = await createHeadSliceCommits({
                        cwd: worktreeDir,
                        env: process.env,
                        baseRef: baseCommit,
                        headCommit,
                        ops,
                        slicePaths: slice.paths,
                        label: slice.label.replace(/\/+$/g, ''),
                      });
                      const prompt = buildCodexMonorepoSlicePrompt({
                        sliceLabel: slice.label,
                        baseCommit: baseSliceCommit,
                        baseRef: base.baseRef,
                      });
                      return await runCodexReview({
                        repoDir: worktreeDir,
                        baseRef: null,
                        env: process.env,
                        jsonMode,
                        prompt,
                        streamLabel: stream && !jsonMode ? `monorepo:codex:${index}/${of}` : undefined,
                        teeFile: logFile,
                        teeLabel: `monorepo:codex:${index}/${of}`,
                      });
                    }
                  );
                  const extracted = jsonMode ? extractCodexReviewFromJsonl(rr.stdout ?? '') : null;
                  return {
                    index,
                    of,
                    slice: slice.label,
                    fileCount: slice.paths.length,
                    logFile,
                    ok: Boolean(rr.ok),
                    exitCode: rr.exitCode,
                    signal: rr.signal,
                    durationMs: rr.durationMs,
                    stdout: rr.stdout ?? '',
                    stderr: rr.stderr ?? '',
                    review_output: extracted,
                  };
                },
                shouldAbortEarly: (r) => detectCodexUsageLimit({ stdout: r?.stdout, stderr: r?.stderr }),
              });

              if (sliceResults.length === 1 && detectCodexUsageLimit(sliceResults[0])) {
                const msg = `[review] codex usage limit detected; resolve Codex credits/limits, then re-run this review.`;
                // eslint-disable-next-line no-console
                console.error(msg);
              }

              const okAll = sliceResults.every((r) => r.ok);
              return {
                reviewer,
                ok: okAll,
                exitCode: okAll ? 0 : 1,
                signal: null,
                durationMs: sliceResults.reduce((acc, r) => acc + (r.durationMs ?? 0), 0),
                stdout: '',
                stderr: '',
                note: `monorepo head-slice: ${sliceResults.length} slices (maxFiles=${maxFiles})`,
                slices: sliceResults,
              };
            }

            const prompt = usePromptMode
              ? monorepo
                ? buildCodexMonorepoDeepPrompt({ baseRef: base.baseRef, changeType })
                : buildCodexDeepPrompt({ component, baseRef: base.baseRef, changeType })
              : '';
            const logFile = join(runDir, 'raw', `codex-${sanitizeLabel(component)}.log`);
            const res = await runCodexReview({
              repoDir,
              baseRef: usePromptMode ? null : changeType === 'uncommitted' ? null : base.baseRef,
              env: process.env,
              jsonMode,
              prompt,
              streamLabel: stream && !jsonMode ? `${component}:codex` : undefined,
              teeFile: logFile,
              teeLabel: `${component}:codex`,
            });
            const extracted = jsonMode ? extractCodexReviewFromJsonl(res.stdout ?? '') : null;
            return {
              reviewer,
              ok: Boolean(res.ok),
              exitCode: res.exitCode,
              signal: res.signal,
              durationMs: res.durationMs,
              stdout: res.stdout ?? '',
              stderr: res.stderr ?? '',
              review_output: extracted,
              logFile,
            };
          }
          if (reviewer === 'augment') {
            const usePromptMode = depth === 'deep';
            const fileCount = await countChangedFiles({ cwd: repoDir, env: process.env, base: base.baseRef });
            const autoChunks = usePromptMode && fileCount > maxFiles;
            const cacheDir = (process.env.HAPPIER_STACK_AUGMENT_CACHE_DIR ?? '').toString().trim();
            const model = (process.env.HAPPIER_STACK_AUGMENT_MODEL ?? '').toString().trim();
            const maxTurnsRaw = (process.env.HAPPIER_STACK_AUGMENT_MAX_TURNS ?? '').toString().trim();
            const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : null;

            if (monorepo && effectiveChunking === 'head-slice' && usePromptMode && (wantChunksAugment ?? autoChunks)) {
              const headCommit = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: process.env })).trim();
              const baseCommit = (await runCapture('git', ['rev-parse', base.baseRef], { cwd: repoDir, env: process.env })).trim();
              const ops = await getChangedOps({ cwd: repoDir, baseRef: baseCommit, headRef: headCommit, env: process.env });
              const slices = planPathSlices({ changedPaths: Array.from(ops.all), maxFiles });

              const sliceItems = slices.map((slice, i) => ({ slice, index: i + 1, of: slices.length }));
              const sliceResults = await runSlicedJobs({
                items: sliceItems,
                limit: sliceConcurrency,
                run: async ({ slice, index, of }) => {
                  const logFile = join(runDir, 'raw', `augment-slice-${index}-of-${of}-${sanitizeLabel(slice.label)}.log`);
                  const rr = await withDetachedWorktree(
                    { repoDir, headCommit: baseCommit, label: `augment-${index}-of-${of}`, env: process.env },
                    async (worktreeDir) => {
                      const { baseSliceCommit } = await createHeadSliceCommits({
                        cwd: worktreeDir,
                        env: process.env,
                        baseRef: baseCommit,
                        headCommit,
                        ops,
                        slicePaths: slice.paths,
                        label: slice.label.replace(/\/+$/g, ''),
                      });
                      const prompt = buildCodexMonorepoSlicePrompt({
                        sliceLabel: slice.label,
                        baseCommit: baseSliceCommit,
                        baseRef: base.baseRef,
                      });
                      return await runAugmentReview({
                        repoDir: worktreeDir,
                        prompt,
                        env: process.env,
                        cacheDir,
                        model,
                        maxTurns: Number.isFinite(maxTurns) ? String(maxTurns) : undefined,
                        streamLabel: stream ? `monorepo:augment:${index}/${of}` : undefined,
                        teeFile: logFile,
                        teeLabel: `monorepo:augment:${index}/${of}`,
                      });
                    }
                  );
                  return {
                    index,
                    of,
                    slice: slice.label,
                    fileCount: slice.paths.length,
                    logFile,
                    ok: Boolean(rr.ok),
                    exitCode: rr.exitCode,
                    signal: rr.signal,
                    durationMs: rr.durationMs,
                    stdout: rr.stdout ?? '',
                    stderr: rr.stderr ?? '',
                  };
                },
                shouldAbortEarly: (r) => detectAugmentAuthError({ stdout: r?.stdout, stderr: r?.stderr }),
              });

              if (sliceResults.length === 1 && detectAugmentAuthError(sliceResults[0])) {
                const msg = `[review] augment auth required: run 'auggie login' in an interactive session, then re-run this review.`;
                // eslint-disable-next-line no-console
                console.error(msg);
              }

              const okAll = sliceResults.every((r) => r.ok);
              return {
                reviewer,
                ok: okAll,
                exitCode: okAll ? 0 : 1,
                signal: null,
                durationMs: sliceResults.reduce((acc, r) => acc + (r.durationMs ?? 0), 0),
                stdout: '',
                stderr: '',
                note: `monorepo head-slice: ${sliceResults.length} slices (maxFiles=${maxFiles})`,
                slices: sliceResults,
              };
            }

            const prompt = usePromptMode
              ? monorepo
                ? buildCodexMonorepoDeepPrompt({ baseRef: base.baseRef, changeType })
                : buildCodexDeepPrompt({ component, baseRef: base.baseRef, changeType })
              : '';
            const logFile = join(runDir, 'raw', `augment-${sanitizeLabel(component)}.log`);
            const res = await runAugmentReview({
              repoDir,
              prompt,
              env: process.env,
              cacheDir,
              model,
              maxTurns: Number.isFinite(maxTurns) ? String(maxTurns) : undefined,
              streamLabel: stream ? `${component}:augment` : undefined,
              teeFile: logFile,
              teeLabel: `${component}:augment`,
            });
            return {
              reviewer,
              ok: Boolean(res.ok),
              exitCode: res.exitCode,
              signal: res.signal,
              durationMs: res.durationMs,
              stdout: res.stdout ?? '',
              stderr: res.stderr ?? '',
              logFile,
            };
          }
          return { reviewer, ok: false, exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: 'unknown reviewer\n' };
        })
      );

      return { component, repoDir, base, results: perReviewer };
    },
  });

  // Persist a structured triage checklist for the operator (human/LLM) to work through.
  try {
    const meta = {
      runLabel,
      startedAt: ts,
      stackName: stackName || null,
      reviewers,
      jobs: jobs.map((j) => ({ component: j.component, repoDir: j.repoDir, monorepo: j.monorepo })),
      depth,
      chunkMaxFiles: Number.isFinite(chunkMaxFiles) ? chunkMaxFiles : null,
      coderabbitMaxFiles,
      chunkingMode,
      argv,
    };
    await writeFile(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    const allFindings = [];
    let cr = 0;
    let cx = 0;
    let au = 0;

    for (const job of jobResults) {
      for (const rr of job.results) {
        if (rr.reviewer === 'coderabbit') {
          const sliceLike = rr.slices ?? rr.chunks ?? null;
          if (Array.isArray(sliceLike)) {
            for (const s of sliceLike) {
              const parsed = parseCodeRabbitPlainOutput(s.stdout ?? '');
              for (const f of parsed) {
                cr += 1;
                allFindings.push({
                  ...f,
                  id: `CR-${String(cr).padStart(3, '0')}`,
                  job: job.component,
                  slice: s.slice ?? `${s.index}/${s.of}`,
                  sourceLog: s.logFile ?? null,
                });
              }
            }
          } else {
            const parsed = parseCodeRabbitPlainOutput(rr.stdout ?? '');
            for (const f of parsed) {
              cr += 1;
              allFindings.push({
                ...f,
                id: `CR-${String(cr).padStart(3, '0')}`,
                job: job.component,
                slice: null,
                sourceLog: rr.logFile ?? null,
              });
            }
          }
        }

        if (rr.reviewer === 'codex') {
          const sliceLike = rr.slices ?? rr.chunks ?? null;
          const consumeText = (reviewText, slice, sourceLog) => {
            const parsed = parseCodexReviewText(reviewText);
            for (const f of parsed) {
              cx += 1;
              allFindings.push({
                ...f,
                id: `CX-${String(cx).padStart(3, '0')}`,
                job: job.component,
                slice,
                sourceLog: sourceLog ?? null,
              });
            }
          };

          if (Array.isArray(sliceLike)) {
            for (const s of sliceLike) {
              const reviewText = s.review_output ?? extractCodexReviewFromJsonl(s.stdout ?? '') ?? (s.stdout ?? '');
              consumeText(reviewText, s.slice ?? `${s.index}/${s.of}`, s.logFile ?? null);
            }
          } else {
            const reviewText = rr.review_output ?? extractCodexReviewFromJsonl(rr.stdout ?? '') ?? (rr.stdout ?? '');
            consumeText(reviewText, null, rr.logFile ?? null);
          }
        }

        if (rr.reviewer === 'augment') {
          const sliceLike = rr.slices ?? rr.chunks ?? null;
          const consumeText = (reviewText, slice, sourceLog) => {
            const parsed = parseCodexReviewText(reviewText).map((f) => ({ ...f, reviewer: 'augment' }));
            for (const f of parsed) {
              au += 1;
              allFindings.push({
                ...f,
                id: `AU-${String(au).padStart(3, '0')}`,
                job: job.component,
                slice,
                sourceLog: sourceLog ?? null,
              });
            }
          };

          if (Array.isArray(sliceLike)) {
            for (const s of sliceLike) {
              consumeText(s.stdout ?? '', s.slice ?? `${s.index}/${s.of}`, s.logFile ?? null);
            }
          } else {
            consumeText(rr.stdout ?? '', null, rr.logFile ?? null);
          }
        }
      }
    }

    await writeFile(join(runDir, 'findings.json'), JSON.stringify(allFindings, null, 2), 'utf-8');
    const triage = formatTriageMarkdown({ runLabel, baseRef: jobResults?.[0]?.base?.baseRef ?? '', findings: allFindings });
    await writeFile(join(runDir, 'triage.md'), triage, 'utf-8');

    if (stream) {
      // eslint-disable-next-line no-console
      console.log(`[review] trust/triage checklist (READ THIS NEXT): ${join(runDir, 'triage.md')}`);
      // eslint-disable-next-line no-console
      console.log(`[review] findings (raw, parsed): ${join(runDir, 'findings.json')}`);
      // eslint-disable-next-line no-console
      console.log(`[review] raw outputs: ${join(runDir, 'raw')}`);
      // eslint-disable-next-line no-console
      console.log(
        [
          '[review] next steps (mandatory):',
          `- STOP: open ${join(runDir, 'triage.md')} now and load it into your context before doing anything else.`,
          `- Then load ${join(runDir, 'findings.json')} (full parsed finding details + source logs).`,
          `- Treat reviewer output as suggestions: verify against codebase invariants + best practices (use web search when needed) before applying.`,
          `- For each finding: verify in the validation worktree, decide apply/adjust/defer, and record rationale + commit refs in triage.md.`,
          `- For tests: validate behavior/logic; avoid brittle "wording/policing" assertions.`,
          `- Do not start a new review run until the checklist has no remaining TBD decisions.`,
        ].join('\n')
      );
    }
  } catch (e) {
    if (stream) {
      // eslint-disable-next-line no-console
      console.warn('[review] warning: failed to write triage artifacts:', e);
    }
  }

  const ok = jobResults.every((r) => r.results.every((x) => x.ok));
  if (json) {
    printResult({ json, data: { ok, reviewers, components, results: jobResults } });
    if (!ok) process.exit(1);
    return;
  }

  const lines = [];
  lines.push('[review] results:');
  for (const r of jobResults) {
    lines.push('============================================================================');
    lines.push(`component: ${r.component}`);
    lines.push(`dir: ${r.repoDir}`);
    lines.push(`baseRef: ${r.base.baseRef}`);
    for (const rr of r.results) {
      lines.push('');
      const status = rr.ok ? '✅ ok' : '❌ failed';
      lines.push(`[${rr.reviewer}] ${status} (exit=${rr.exitCode ?? 'null'} durMs=${rr.durationMs ?? '?'})`);
      if (rr.note) lines.push(`note: ${rr.note}`);
      if (!rr.ok) {
        if (rr.stderr) {
          lines.push('--- stderr (tail) ---');
          lines.push(tailLines(rr.stderr, 120));
        }
        if (rr.stdout) {
          lines.push('--- stdout (tail) ---');
          lines.push(tailLines(rr.stdout, 120));
        }
      }
    }
    lines.push('');
  }
  lines.push(ok ? '[review] ok' : '[review] failed');
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('[review] failed:', err);
  process.exit(1);
});
