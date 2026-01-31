import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { componentDirEnvKey, getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { ensureHappyMonorepoNestedDepsInstalled } from './utils/proc/happy_monorepo_deps.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { detectPackageManagerCmd, pickFirstScript, readPackageJsonScripts } from './utils/proc/package_scripts.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

const DEFAULT_COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];
const EXTRA_COMPONENTS = ['stacks'];
const VALID_COMPONENTS = [...DEFAULT_COMPONENTS, ...EXTRA_COMPONENTS];

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
    dir.endsWith(`${sep}packages${sep}happy-app`) || dir.endsWith('/packages/happy-app');
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
        '  happys test [component...] [--json]',
        '',
        'components:',
        `  ${VALID_COMPONENTS.join(' | ')}`,
        '',
        'examples:',
        '  happys test',
        '  happys test stacks',
        '  happys test happy happy-cli',
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
    const stacksKey = componentDirEnvKey(inferred.component);
    const legacyKey = stacksKey.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
    if (!(process.env[stacksKey] ?? '').toString().trim() && !(process.env[legacyKey] ?? '').toString().trim()) {
      process.env[stacksKey] = inferred.repoDir;
    }
  }

  const requested = positionals.length ? positionals : inferred ? [inferred.component] : ['all'];
  const wantAll = requested.includes('all');
  // Default `all` excludes "stacks" to avoid coupling to component repos and their test baselines.
  const components = wantAll ? DEFAULT_COMPONENTS : requested;

  const results = [];
  for (const component of components) {
    if (!VALID_COMPONENTS.includes(component)) {
      results.push({ component, ok: false, skipped: false, error: `unknown component (expected one of: ${VALID_COMPONENTS.join(', ')})` });
      continue;
    }

    if (component === 'stacks') {
      try {
        // eslint-disable-next-line no-console
        console.log('[test] stacks: running node --test (happy-stacks unit tests)');
        // Note: do not rely on shell glob expansion here.
        // Node 20 does not expand globs for `--test`, and bash/sh won't expand globs inside quotes.
        // Enumerate files ourselves so this works reliably in CI.
        const scriptsDir = join(rootDir, 'scripts');
        const testFiles = await collectTestFiles(scriptsDir);
        if (testFiles.length === 0) {
          throw new Error(`[test] stacks: no test files found under ${scriptsDir}`);
        }
        await run(process.execPath, ['--test', ...testFiles], { cwd: rootDir, env: process.env });
        results.push({ component, ok: true, skipped: false, dir: rootDir, pm: 'node', script: '--test' });
      } catch (e) {
        results.push({ component, ok: false, skipped: false, dir: rootDir, pm: 'node', script: '--test', error: String(e?.message ?? e) });
      }
      continue;
    }

    const rawDir = getComponentDir(rootDir, component);
    const dir = await resolveTestDirForComponent({ component, dir: rawDir });
    if (!(await pathExists(dir))) {
      results.push({ component, ok: false, skipped: false, dir, error: `missing component dir: ${dir}` });
      continue;
    }

	    const scripts = await readPackageJsonScripts(dir);
	    if (!scripts) {
	      results.push({ component, ok: true, skipped: true, dir, reason: 'no package.json' });
	      continue;
    }

    const script = pickTestScript(scripts);
	    if (!script) {
	      results.push({ component, ok: true, skipped: true, dir, reason: 'no test script found in package.json' });
	      continue;
	    }

	    if (component === 'happy') {
	      await ensureHappyMonorepoNestedDepsInstalled({
	        happyTestDir: dir,
	        quiet: json,
	        env: process.env,
	        ensureDepsInstalled,
	      });
	    }

	    await ensureDepsInstalled(dir, component, { quiet: json, env: process.env });
	    const pm = await detectPackageManagerCmd(dir);

    try {
      const line = `[test] ${component}: running ${pm.name} ${script}\n`;
      if (json) {
        process.stderr.write(line);
        const out = await runCapture(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
        if (out) process.stderr.write(out);
      } else {
        // eslint-disable-next-line no-console
        console.log(line.trimEnd());
        await run(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
      }
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

  const lines = ['[test] results:'];
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
