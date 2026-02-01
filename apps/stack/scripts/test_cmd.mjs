import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { ensureHappyMonorepoNestedDepsInstalled } from './utils/proc/happy_monorepo_deps.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { detectPackageManagerCmd, pickFirstScript, readPackageJsonScripts } from './utils/proc/package_scripts.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

const EXTRA_COMPONENTS = ['stacks'];
const VALID_TARGETS = ['ui', 'cli', 'server'];
const VALID_COMPONENTS = [...VALID_TARGETS, ...EXTRA_COMPONENTS, 'all'];

function targetFromLegacyComponent(component) {
  const c = String(component ?? '').trim();
  if (c === 'happy') return 'ui';
  if (c === 'happy-cli') return 'cli';
  if (c === 'happy-server' || c === 'happy-server-light') return 'server';
  return null;
}

function legacyComponentFromTarget(target) {
  const t = String(target ?? '').trim();
  if (t === 'ui') return 'happy';
  if (t === 'cli') return 'happy-cli';
  if (t === 'server') return 'happy-server';
  return null;
}

function normalizeTargetsOrThrow(rawTargets) {
  const requested = Array.isArray(rawTargets) ? rawTargets.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  if (!requested.length) return ['all'];

  const mapped = requested
    .map((t) => {
      const lower = t.toLowerCase();
      if (lower === 'all') return 'all';
      if (lower === 'stacks') return 'stacks';
      if (VALID_TARGETS.includes(lower)) return lower;
      const legacy = targetFromLegacyComponent(lower);
      return legacy ?? null;
    })
    .filter(Boolean);

  if (!mapped.length) return ['all'];
  return mapped;
}

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    // Avoid dot-dirs and dot-files (e.g. .DS_Store).
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await collectTestFiles(p)));
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.test.mjs')) continue;
    files.push(p);
  }
  files.sort();
  return files;
}

function pickTestScript(scripts) {
  const candidates = [
    'test',
    'tst',
    'test:ci',
    'test:unit',
    'check:test',
  ];
  return pickFirstScript(scripts, candidates);
}

async function resolveTestDirForComponent({ component, dir }) {
  // Monorepo mode:
  // In the Happy monorepo, the "happy" component dir is often set to `<repo>/expo-app`
  // so dev/start can operate from the app package. For validation, we want the monorepo
  // root scripts (which run expo-app + cli + server together).
  if (component !== 'happy') return dir;
  const isLegacyExpoApp = dir.endsWith(`${sep}expo-app`) || dir.endsWith('/expo-app');
  const isPackagesHappyApp =
    dir.endsWith(`${sep}packages${sep}happy-app`) || dir.endsWith('/apps/ui');
  if (!isLegacyExpoApp && !isPackagesHappyApp) return dir;

  const parent = isPackagesHappyApp ? dirname(dirname(dir)) : dirname(dir);
  try {
    const scripts = await readPackageJsonScripts(parent);
    if (!scripts) return dir;
    if ((scripts?.test ?? '').toString().trim().length === 0) return dir;

    // Only redirect when the parent is clearly intended as the monorepo root.
    const pkg = JSON.parse(await readFile(join(parent, 'package.json'), 'utf-8'));
    const name = String(pkg?.name ?? '').trim();
    if (name !== 'monorepo') return dir;
    return parent;
  } catch {
    return dir;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { components: VALID_COMPONENTS, flags: ['--json'] },
      text: [
        '[test] usage:',
        '  hstack test [ui|cli|server|all|stacks] [--json]',
        '',
        'targets:',
        `  ${VALID_COMPONENTS.join(' | ')}`,
        '',
        'examples:',
        '  hstack test',
        '  hstack test stacks',
        '  hstack test ui cli',
        '',
        'note:',
        '  If run from inside a repo checkout/worktree and no targets are provided, defaults to the inferred app (ui/cli/server).',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const inferredLegacy =
    positionals.length === 0
      ? inferComponentFromCwd({
          rootDir,
          invokedCwd: getInvokedCwd(process.env),
          components: ['happy', 'happy-cli', 'happy-server'],
        })
      : null;
  if (inferredLegacy) {
    if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_REPO_DIR = inferredLegacy.repoDir;
    }
  }

  const inferredTarget = inferredLegacy ? targetFromLegacyComponent(inferredLegacy.component) : null;
  const requested = normalizeTargetsOrThrow(positionals.length ? positionals : inferredTarget ? [inferredTarget] : ['all']);
  const wantAll = requested.includes('all');
  // Default `all` excludes "stacks" to avoid coupling to stack tests and their baselines.
  const targets = wantAll ? VALID_TARGETS : requested;

  const results = [];
  for (const target of targets) {
    if (!VALID_COMPONENTS.includes(target)) {
      results.push({ target, ok: false, skipped: false, error: `unknown target (expected one of: ${VALID_COMPONENTS.join(', ')})` });
      continue;
    }

    if (target === 'stacks') {
      try {
        // eslint-disable-next-line no-console
        console.log('[test] stacks: running node --test (hstack unit tests)');
        // Note: do not rely on shell glob expansion here.
        // Node 20 does not expand globs for `--test`, and bash/sh won't expand globs inside quotes.
        // Enumerate files ourselves so this works reliably in CI.
        const scriptsDir = join(rootDir, 'scripts');
        const testFiles = await collectTestFiles(scriptsDir);
        if (testFiles.length === 0) {
          throw new Error(`[test] stacks: no test files found under ${scriptsDir}`);
        }
        await run(process.execPath, ['--test', ...testFiles], { cwd: rootDir, env: process.env });
        results.push({ target, ok: true, skipped: false, dir: rootDir, pm: 'node', script: '--test' });
      } catch (e) {
        results.push({ target, ok: false, skipped: false, dir: rootDir, pm: 'node', script: '--test', error: String(e?.message ?? e) });
      }
      continue;
    }

    const component = legacyComponentFromTarget(target);
    const rawDir = getComponentDir(rootDir, component);
    const dir = await resolveTestDirForComponent({ component, dir: rawDir });
    if (!(await pathExists(dir))) {
      results.push({ target, ok: false, skipped: false, dir, error: `missing target dir: ${dir}` });
      continue;
    }

    const scripts = await readPackageJsonScripts(dir);
    if (!scripts) {
      results.push({ target, ok: true, skipped: true, dir, reason: 'no package.json' });
      continue;
    }

    const script = pickTestScript(scripts);
    if (!script) {
      results.push({ target, ok: true, skipped: true, dir, reason: 'no test script found in package.json' });
      continue;
    }

    if (target === 'ui') {
      await ensureHappyMonorepoNestedDepsInstalled({
        happyTestDir: dir,
        quiet: json,
        env: process.env,
        ensureDepsInstalled,
      });
    }

    await ensureDepsInstalled(dir, target, { quiet: json, env: process.env });
    const pm = await detectPackageManagerCmd(dir);

    try {
      const line = `[test] ${target}: running ${pm.name} ${script}\n`;
      if (json) {
        process.stderr.write(line);
        const out = await runCapture(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
        if (out) process.stderr.write(out);
      } else {
        // eslint-disable-next-line no-console
        console.log(line.trimEnd());
        await run(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
      }
      results.push({ target, ok: true, skipped: false, dir, pm: pm.name, script });
    } catch (e) {
      results.push({ target, ok: false, skipped: false, dir, pm: pm.name, script, error: String(e?.message ?? e) });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    printResult({ json, data: { ok, results } });
    return;
  }

  const lines = ['[test] results:'];
  for (const r of results) {
    if (r.ok && r.skipped) {
      lines.push(`- ↪ ${r.target}: skipped (${r.reason})`);
    } else if (r.ok) {
      lines.push(`- ✅ ${r.target}: ok (${r.pm} ${r.script})`);
    } else {
      lines.push(`- ❌ ${r.target}: failed (${r.pm ?? 'unknown'} ${r.script ?? ''})`);
      if (r.error) lines.push(`  - ${r.error}`);
    }
  }
  if (!ok) {
    lines.push('');
    lines.push('[test] failed');
  }
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[test] failed:', err);
  process.exit(1);
});
