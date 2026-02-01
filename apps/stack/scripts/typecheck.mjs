import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run } from './utils/proc/proc.mjs';
import { detectPackageManagerCmd, pickFirstScript, readPackageJsonScripts } from './utils/proc/package_scripts.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';

const DEFAULT_COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

function pickTypecheckScript(scripts) {
  const candidates = [
    'typecheck',
    'type-check',
    'check-types',
    'check:types',
    'tsc',
    'typescript',
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
      data: { components: DEFAULT_COMPONENTS, flags: ['--json'] },
      text: [
        '[typecheck] usage:',
        '  hapsta typecheck [component...] [--json]',
        '',
        'components:',
        `  ${DEFAULT_COMPONENTS.join(' | ')}`,
        '',
        'examples:',
        '  hapsta typecheck',
        '  hapsta typecheck happy happy-cli',
        '',
        'note:',
        '  If run from inside a component checkout/worktree and no components are provided, defaults to that component.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const inferred =
    positionals.length === 0
      ? inferComponentFromCwd({
          rootDir,
          invokedCwd: getInvokedCwd(process.env),
          components: DEFAULT_COMPONENTS,
        })
      : null;
  if (inferred) {
    if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
    }
  }

  const requested = positionals.length ? positionals : inferred ? [inferred.component] : ['all'];
  const wantAll = requested.includes('all');
  const components = wantAll ? DEFAULT_COMPONENTS : requested;

  const results = [];
  for (const component of components) {
    if (!DEFAULT_COMPONENTS.includes(component)) {
      results.push({ component, ok: false, skipped: false, error: `unknown component (expected one of: ${DEFAULT_COMPONENTS.join(', ')})` });
      continue;
    }

    const dir = getComponentDir(rootDir, component);
    if (!(await pathExists(dir))) {
      results.push({ component, ok: false, skipped: false, dir, error: `missing component dir: ${dir}` });
      continue;
    }

    const scripts = await readPackageJsonScripts(dir);
    if (!scripts) {
      results.push({ component, ok: true, skipped: true, dir, reason: 'no package.json' });
      continue;
    }

    const script = pickTypecheckScript(scripts);
    if (!script) {
      results.push({ component, ok: true, skipped: true, dir, reason: 'no typecheck script found in package.json' });
      continue;
    }

    await ensureDepsInstalled(dir, component);
    const pm = await detectPackageManagerCmd(dir);

    try {
      // eslint-disable-next-line no-console
      console.log(`[typecheck] ${component}: running ${pm.name} ${script}`);
      await run(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
      results.push({ component, ok: true, skipped: false, dir, pm: pm.name, script });
    } catch (e) {
      results.push({ component, ok: false, skipped: false, dir, pm: pm.name, script, error: String(e?.message ?? e) });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    printResult({ json, data: { ok, results } });
    return;
  }

  const lines = ['[typecheck] results:'];
  for (const r of results) {
    if (r.ok && r.skipped) {
      lines.push(`- ↪ ${r.component}: skipped (${r.reason})`);
    } else if (r.ok) {
      lines.push(`- ✅ ${r.component}: ok (${r.pm} ${r.script})`);
    } else {
      lines.push(`- ❌ ${r.component}: failed (${r.pm ?? 'unknown'} ${r.script ?? ''})`);
      if (r.error) lines.push(`  - ${r.error}`);
    }
  }
  if (!ok) {
    lines.push('');
    lines.push('[typecheck] failed');
  }
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[typecheck] failed:', err);
  process.exit(1);
});
