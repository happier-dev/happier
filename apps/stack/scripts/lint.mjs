import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run } from './utils/proc/proc.mjs';
import { detectPackageManagerCmd, pickFirstScript, readPackageJsonScripts } from './utils/proc/package_scripts.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';

const VALID_TARGETS = ['ui', 'cli', 'server'];

function targetFromComponent(component) {
  const c = String(component ?? '').trim();
  if (c === 'happier-ui' || c === 'happy') return 'ui';
  if (c === 'happier-cli' || c === 'happy-cli') return 'cli';
  if (c === 'happier-server' || c === 'happier-server-light' || c === 'happy-server' || c === 'happy-server-light') return 'server';
  return null;
}

function componentFromTarget(target) {
  const t = String(target ?? '').trim();
  if (t === 'ui') return 'happier-ui';
  if (t === 'cli') return 'happier-cli';
  if (t === 'server') return 'happier-server';
  return null;
}

function normalizeTargetsOrThrow(rawTargets) {
  const requested = Array.isArray(rawTargets) ? rawTargets.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  if (!requested.length) return ['all'];

  const mapped = requested
    .map((t) => {
      const lower = t.toLowerCase();
      if (lower === 'all') return 'all';
      if (VALID_TARGETS.includes(lower)) return lower;
      return targetFromComponent(lower) ?? null;
    })
    .filter(Boolean);

  if (!mapped.length) return ['all'];
  return mapped;
}

function pickLintScript(scripts) {
  const candidates = [
    'lint',
    'lint:ci',
    'check',
    'check:lint',
    'eslint',
    'eslint:check',
  ];
  return pickFirstScript(scripts, candidates);
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { targets: [...VALID_TARGETS, 'all'], flags: ['--json'] },
      text: [
        '[lint] usage:',
        '  hstack lint [ui|cli|server|all] [--json]',
        '',
        'targets:',
        `  ${[...VALID_TARGETS, 'all'].join(' | ')}`,
        '',
        'examples:',
        '  hstack lint',
        '  hstack lint ui',
        '  hstack lint ui cli',
        '',
        'note:',
        '  If run from inside a repo checkout/worktree and no targets are provided, defaults to the inferred app (ui/cli/server).',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const inferredComponent =
    positionals.length === 0
      ? inferComponentFromCwd({
          rootDir,
          invokedCwd: getInvokedCwd(process.env),
          components: ['happier-ui', 'happier-cli', 'happier-server', 'happier-server-light', 'happy', 'happy-cli', 'happy-server', 'happy-server-light'],
        })
      : null;
  if (inferredComponent) {
    if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_REPO_DIR = inferredComponent.repoDir;
    }
  }

  const inferredTarget = inferredComponent ? targetFromComponent(inferredComponent.component) : null;
  const requested = normalizeTargetsOrThrow(positionals.length ? positionals : inferredTarget ? [inferredTarget] : ['all']);
  const wantAll = requested.includes('all');
  const targets = wantAll ? VALID_TARGETS : requested;

  const results = [];
  for (const target of targets) {
    if (!VALID_TARGETS.includes(target)) {
      results.push({ target, ok: false, skipped: false, error: `unknown target (expected one of: ${[...VALID_TARGETS, 'all'].join(', ')})` });
      continue;
    }

    const component = componentFromTarget(target);
    const dir = getComponentDir(rootDir, component);
    if (!(await pathExists(dir))) {
      results.push({ target, ok: false, skipped: false, dir, error: `missing target dir: ${dir}` });
      continue;
    }

    const scripts = await readPackageJsonScripts(dir);
    if (!scripts) {
      results.push({ target, ok: true, skipped: true, dir, reason: 'no package.json' });
      continue;
    }

    const script = pickLintScript(scripts);
    if (!script) {
      results.push({ target, ok: true, skipped: true, dir, reason: 'no lint script found in package.json' });
      continue;
    }

    await ensureDepsInstalled(dir, target);
    const pm = await detectPackageManagerCmd(dir);

    try {
      // eslint-disable-next-line no-console
      console.log(`[lint] ${target}: running ${pm.name} ${script}`);
      await run(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
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

  const lines = ['[lint] results:'];
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
    lines.push('[lint] failed');
  }
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[lint] failed:', err);
  process.exit(1);
});
