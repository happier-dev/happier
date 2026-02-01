import './utils/env/env.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { pathExists } from './utils/fs/fs.mjs';

const VALID_TARGETS = ['cli', 'server', 'ui'];

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

export async function findMonorepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    const lock = join(dir, 'yarn.lock');
    if ((await pathExists(pkg)) && (await pathExists(lock))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function resolvePackDirForComponent({ component, componentDir, explicitDir }) {
  if (explicitDir) return explicitDir;

  // In the monorepo, stacks often point the active repo dir at the monorepo root.
  // For packing/publishing we want the actual workspace package dir.
  const monorepoRoot = await findMonorepoRoot(componentDir);
  if (monorepoRoot) {
    try {
      const rootPkg = await readJson(join(monorepoRoot, 'package.json'));
      const name = String(rootPkg?.name ?? '').trim();
      if (name === 'monorepo') {
        if (component === 'happy-cli') return join(monorepoRoot, 'apps', 'cli');
        if (component === 'happy-server') return join(monorepoRoot, 'apps', 'server');
        if (component === 'happy') return join(monorepoRoot, 'apps', 'ui');
      }
    } catch {
      // ignore
    }
  }

  return componentDir;
}

async function copyDir(src, dest) {
  // Node 22 supports recursive copy via `cp` in fs/promises, but this repo has its own fs utils;
  // keep it simple using `cp -R` through the existing proc runner.
  // Using external `cp` keeps this fast and avoids re-implementing copy logic.
  await runCapture('cp', ['-R', src, dest], { cwd: '/', env: process.env });
}

async function createPackSandbox({ monorepoRoot, packageRelDir }) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'hstack-pack-'));

  // Minimal monorepo layout needed for pack steps that reference workspace deps:
  // - root package.json + yarn.lock (for repo root detection)
  // - target package dir (e.g. apps/cli)
  // - packages/agents + packages/protocol (bundled deps source)
  const filesToCopy = [
    'package.json',
    'yarn.lock',
  ];
  for (const f of filesToCopy) {
    await copyDir(join(monorepoRoot, f), join(sandboxRoot, f));
  }

  const dirsToCopy = [
    packageRelDir,
    'packages/agents',
    'packages/protocol',
  ];
  for (const d of dirsToCopy) {
    const src = join(monorepoRoot, d);
    if (!(await pathExists(src))) {
      throw new Error(`[pack] missing required directory for packing sandbox: ${src}`);
    }
    const destParent = dirname(join(sandboxRoot, d));
    await runCapture('mkdir', ['-p', destParent], { cwd: '/', env: process.env });
    await copyDir(src, join(sandboxRoot, d));
  }

  return sandboxRoot;
}

export function analyzeTarList(paths) {
  const hasAgents = paths.some((p) => p.startsWith('package/node_modules/@happier-dev/agents/'));
  const hasProtocol = paths.some((p) => p.startsWith('package/node_modules/@happier-dev/protocol/'));
  return { hasAgents, hasProtocol };
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { targets: [...VALID_TARGETS, '--dir=/abs/path'], flags: ['--json'] },
      text: [
        '[pack] usage:',
        '  hstack pack cli [--json]',
        '  hstack pack server [--json]',
        '  hstack pack ui [--json]',
        '  hstack pack --dir=/abs/path/to/apps/cli [--json]',
        '',
        'notes:',
        '- packs in a temporary sandbox to avoid dirtying the worktree',
        '- can validate bundledDependencies output by inspecting the generated tarball (best-effort)',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const explicitDir = (kv.get('--dir') ?? '').toString().trim();
  const raw =
    explicitDir
      ? null
      : positionals.length === 1
        ? positionals[0]
        : null;

  if (!explicitDir && !raw) {
    throw new Error('[pack] missing target (expected: hstack pack cli|server|ui | --dir=...)');
  }

  const target = raw
    ? (VALID_TARGETS.includes(String(raw).trim().toLowerCase()) ? String(raw).trim().toLowerCase() : targetFromLegacyComponent(raw))
    : null;
  if (raw && !target) {
    throw new Error(`[pack] unknown target: ${raw} (expected one of: ${VALID_TARGETS.join(', ')})`);
  }

  const rootDir = getRootDir(import.meta.url);
  const component = target ? legacyComponentFromTarget(target) : null;
  const componentDir = component ? getComponentDir(rootDir, component) : '';
  const packDir = await resolvePackDirForComponent({
    component: component ?? 'happy-cli',
    componentDir,
    explicitDir: explicitDir ? resolve(explicitDir) : null,
  });

  if (!(await pathExists(packDir))) {
    throw new Error(`[pack] missing pack dir: ${packDir}`);
  }
  const st = await stat(packDir);
  if (!st.isDirectory()) {
    throw new Error(`[pack] pack dir is not a directory: ${packDir}`);
  }

  const monorepoRoot = await findMonorepoRoot(packDir);
  if (!monorepoRoot) {
    throw new Error(`[pack] could not locate monorepo root (package.json + yarn.lock) from: ${packDir}`);
  }
  const packageRelDir = relative(monorepoRoot, packDir).split(sep).join('/');
  if (!(packageRelDir.startsWith('apps/') || packageRelDir.startsWith('packages/'))) {
    throw new Error(`[pack] expected pack dir to be under monorepo apps/ or packages/: ${packDir}`);
  }

  const sandboxRoot = await createPackSandbox({ monorepoRoot, packageRelDir });
  const sandboxPackDir = join(sandboxRoot, packageRelDir);

  try {
    // 1) dry run: helps catch issues without producing a tarball
    const dryRunOut = await runCapture('npm', ['pack', '--dry-run'], { cwd: sandboxPackDir, env: process.env });

    // 2) real pack: create tarball and inspect contents
    const tarballNameRaw = (await runCapture('npm', ['pack'], { cwd: sandboxPackDir, env: process.env })).trim();
    const tarballName = tarballNameRaw.split('\n').filter(Boolean).slice(-1)[0] ?? '';
    if (!tarballName) {
      throw new Error('[pack] npm pack did not produce a tarball name');
    }
    const tarballPath = join(sandboxPackDir, tarballName);
    const tarListRaw = await runCapture('tar', ['-tf', tarballPath], { cwd: sandboxPackDir, env: process.env });
    const tarPaths = tarListRaw.split('\n').map((l) => l.trim()).filter(Boolean);
    const { hasAgents, hasProtocol } = analyzeTarList(tarPaths);

    // Only enforce bundled deps for CLI by default; other packages may intentionally not bundle.
    const shouldEnforceBundledDeps = target === 'cli';
    const ok = shouldEnforceBundledDeps ? hasAgents && hasProtocol : true;
    const data = {
      ok,
      packDir,
      sandboxRoot,
      tarball: { name: basename(tarballPath) },
      bundled: { agents: hasAgents, protocol: hasProtocol },
      enforcement: { bundledDeps: shouldEnforceBundledDeps },
      dryRun: { ok: true, output: json ? undefined : dryRunOut },
    };

    if (json) {
      printResult({ json, data });
      return;
    }

    const lines = [
      `[pack] dir: ${packDir}`,
      `[pack] tarball: ${basename(tarballPath)} (generated in a temp sandbox)`,
      `[pack] bundledDependencies (best-effort):`,
      `- @happier-dev/agents:   ${hasAgents ? '✅ present' : shouldEnforceBundledDeps ? '❌ missing' : '↪ not required'}`,
      `- @happier-dev/protocol: ${hasProtocol ? '✅ present' : shouldEnforceBundledDeps ? '❌ missing' : '↪ not required'}`,
    ];
    if (!ok) {
      lines.push('', '[pack] NOTE: missing bundled deps in tarball; publish would likely break for npm consumers.');
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  } finally {
    // Always clean the sandbox to avoid filling tmp.
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // `argv[1]` can be a relative path.
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  });
}
