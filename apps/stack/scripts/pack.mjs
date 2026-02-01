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

const VALID_COMPONENTS = ['happy-cli', 'happy-server', 'happy'];

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

  // In the Happy monorepo, stacks often point components at the monorepo root.
  // For packing/publishing we want the actual workspace package dir.
  const monorepoRoot = await findMonorepoRoot(componentDir);
  if (monorepoRoot) {
    try {
      const rootPkg = await readJson(join(monorepoRoot, 'package.json'));
      const name = String(rootPkg?.name ?? '').trim();
      const hasPackages = await pathExists(join(monorepoRoot, 'packages'));
      if (name === 'monorepo' && hasPackages) {
        if (component === 'happy-cli') return join(monorepoRoot, 'packages', 'happy-cli');
        if (component === 'happy-server') return join(monorepoRoot, 'packages', 'happy-server');
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
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'hapsta-pack-'));

  // Minimal monorepo layout needed for the happy-cli prepack step:
  // - root package.json + yarn.lock (for repo root detection)
  // - apps/cli (the package being packed)
  // - packages/agents + packages/protocol (bundled deps source)
  const filesToCopy = [
    'package.json',
    'yarn.lock',
  ];
  for (const f of filesToCopy) {
    await copyDir(join(monorepoRoot, f), join(sandboxRoot, f));
  }

  const pkgsSrc = join(monorepoRoot, 'packages');
  const pkgsDest = join(sandboxRoot, 'packages');
  await runCapture('mkdir', ['-p', pkgsDest], { cwd: '/', env: process.env });

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
      data: { commands: VALID_COMPONENTS, flags: ['--dir=/abs/path', '--json'] },
      text: [
        '[pack] usage:',
        '  hapsta pack happy-cli [--json]',
        '  hapsta pack happy-server [--json]',
        '  hapsta pack --dir=/abs/path/to/apps/cli [--json]',
        '',
        'notes:',
        '- packs in a temporary sandbox to avoid dirtying the worktree',
        '- validates bundledDependencies output by inspecting the generated tarball',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const explicitDir = (kv.get('--dir') ?? '').toString().trim();
  const component =
    explicitDir
      ? null
      : positionals.length === 1
        ? positionals[0]
        : null;

  if (!explicitDir && !component) {
    throw new Error('[pack] missing target (expected: hapsta pack happy-cli | hapsta pack happy-server | --dir=...)');
  }
  if (component && !VALID_COMPONENTS.includes(component)) {
    throw new Error(`[pack] unknown component: ${component} (expected one of: ${VALID_COMPONENTS.join(', ')})`);
  }

  const rootDir = getRootDir(import.meta.url);
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
  if (!packageRelDir.startsWith('packages/')) {
    throw new Error(`[pack] expected pack dir to be under monorepo packages/: ${packDir}`);
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

    const ok = hasAgents && hasProtocol;
    const data = {
      ok,
      packDir,
      sandboxRoot,
      tarball: { name: basename(tarballPath) },
      bundled: { agents: hasAgents, protocol: hasProtocol },
      dryRun: { ok: true, output: json ? undefined : dryRunOut },
    };

    if (json) {
      printResult({ json, data });
      return;
    }

    const lines = [
      `[pack] dir: ${packDir}`,
      `[pack] tarball: ${basename(tarballPath)} (generated in a temp sandbox)`,
      `[pack] bundledDependencies:`,
      `- @happier-dev/agents:   ${hasAgents ? '✅ present' : '❌ missing'}`,
      `- @happier-dev/protocol: ${hasProtocol ? '✅ present' : '❌ missing'}`,
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
