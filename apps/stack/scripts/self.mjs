import './utils/env/env.mjs';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { getHappyStacksHomeDir, getRootDir } from './utils/paths/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { readJsonIfExists } from './utils/fs/json.mjs';
import { readPackageJsonVersion } from './utils/fs/package_json.mjs';
import { banner, bullets, cmd, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { getCanonicalHomeEnvPath, getHomeEnvPath, ensureCanonicalHomeEnvUpdated, ensureHomeEnvUpdated } from './utils/env/config.mjs';
import { ensureEnvFilePruned } from './utils/env/env_file.mjs';
import { coerceHappyMonorepoRootFromPath, getDevRepoDir, getRepoDir, getWorkspaceDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';

function packageJsonPathForNodeModules({ rootDir, packageName }) {
  const name = String(packageName ?? '').trim();
  if (!name) return null;
  const parts = name.split('/').filter(Boolean);
  return join(rootDir, 'node_modules', ...parts, 'package.json');
}

function cachePaths() {
  const home = getHappyStacksHomeDir();
  return {
    home,
    cacheDir: join(home, 'cache'),
    updateJson: join(home, 'cache', 'update.json'),
  };
}

async function writeJsonSafe(path, obj) {
  try {
    await mkdir(join(path, '..'), { recursive: true });
  } catch {
    // ignore
  }
  try {
    await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  } catch {
    // ignore
  }
}

async function getRuntimeInstalledVersion() {
  const runtimeDir = getRuntimeDir();
  const invoker = await readJsonIfExists(join(getRootDir(import.meta.url), 'package.json'), { defaultValue: null });
  const pkgName = String(invoker?.name ?? '').trim();
  if (!pkgName) return null;
  const pkgJson = packageJsonPathForNodeModules({ rootDir: runtimeDir, packageName: pkgName });
  if (!pkgJson) return null;
  return await readPackageJsonVersion(pkgJson);
}

async function getInvokerVersion({ rootDir }) {
  return await readPackageJsonVersion(join(rootDir, 'package.json'));
}

async function fetchLatestVersion({ packageName }) {
  // Prefer npm (available on most systems with Node).
  // Keep it simple: `npm view <pkg> version` prints a single version.
  try {
    const pkg = String(packageName ?? '').trim();
    if (!pkg) return null;
    const out = (await runCapture('npm', ['view', pkg, 'version'])).trim();
    return out || null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  // Very small semver-ish compare (supports x.y.z); falls back to string compare.
  const pa = String(a ?? '').trim().split('.').map((n) => Number(n));
  const pb = String(b ?? '').trim().split('.').map((n) => Number(n));
  if (pa.length >= 2 && pb.length >= 2 && pa.every((n) => Number.isFinite(n)) && pb.every((n) => Number.isFinite(n))) {
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da > db) return 1;
      if (da < db) return -1;
    }
    return 0;
  }
  return String(a).localeCompare(String(b));
}

async function cmdStatus({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const doCheck = !flags.has('--no-check');

  const { updateJson, cacheDir } = cachePaths();
  const invoker = await readJsonIfExists(join(rootDir, 'package.json'), { defaultValue: null });
  const packageName = String(invoker?.name ?? '').trim();
  const invokerVersion = await getInvokerVersion({ rootDir });
  const runtimeDir = getRuntimeDir();
  const runtimeVersion = await getRuntimeInstalledVersion();

  const cached = await readJsonIfExists(updateJson, { defaultValue: null });

  let latest = cached?.latest ?? null;
  let checkedAt = cached?.checkedAt ?? null;
  let updateAvailable = Boolean(cached?.updateAvailable);

  if (doCheck) {
    try {
      latest = await fetchLatestVersion({ packageName });
      checkedAt = Date.now();
      const current = runtimeVersion || invokerVersion;
      updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);
      await mkdir(cacheDir, { recursive: true });
      await writeJsonSafe(updateJson, {
        checkedAt,
        latest,
        current: current || null,
        runtimeVersion: runtimeVersion || null,
        invokerVersion: invokerVersion || null,
        updateAvailable,
        notifiedAt: cached?.notifiedAt ?? null,
      });
    } catch {
      // ignore network/npm failures; keep cached values
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      invoker: { version: invokerVersion, rootDir },
      runtime: { dir: runtimeDir, installed: Boolean(runtimeVersion), version: runtimeVersion },
      update: { cachedLatest: cached?.latest ?? null, latest, checkedAt, updateAvailable },
    },
    text: [
      '',
      banner('self', { subtitle: 'Runtime install + self-update.' }),
      '',
      sectionTitle('Versions'),
      bullets([
        kv('invoker:', invokerVersion ? cyan(invokerVersion) : dim('unknown')),
        kv('runtime:', runtimeVersion ? cyan(runtimeVersion) : `${yellow('not installed')} ${dim(`(${runtimeDir})`)}`),
        kv('latest:', latest ? cyan(latest) : dim('unknown')),
        checkedAt ? kv('checked:', dim(new Date(checkedAt).toISOString())) : null,
      ].filter(Boolean)),
      updateAvailable ? `\n${yellow('!')} update available: ${cyan(runtimeVersion || invokerVersion || 'current')} → ${cyan(latest)}` : null,
      updateAvailable ? `${dim('Run:')} ${cmd('hstack self update')}` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdUpdate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const runtimeDir = getRuntimeDir();
  const to = (kv.get('--to') ?? '').trim();
  const invoker = await readJsonIfExists(join(rootDir, 'package.json'), { defaultValue: null });
  const pkgName = String(invoker?.name ?? '').trim();
  if (!pkgName) throw new Error('[self] unable to resolve package name (missing package.json name)');
  const spec = to ? `${pkgName}@${to}` : `${pkgName}@latest`;

  // Ensure runtime dir exists.
  await mkdir(runtimeDir, { recursive: true });

  // Install/update runtime package.
  try {
    await run('npm', ['install', '--no-audit', '--no-fund', '--silent', '--prefix', runtimeDir, spec], { cwd: rootDir });
  } catch (err) {
    // Pre-publish dev fallback: allow updating runtime from the local checkout.
    if (!to && existsSync(join(rootDir, 'package.json'))) {
      try {
        const raw = await readFile(join(rootDir, 'package.json'), 'utf-8');
        const pkg = JSON.parse(raw);
        if (pkg?.name === pkgName) {
          await run('npm', ['install', '--no-audit', '--no-fund', '--silent', '--prefix', runtimeDir, rootDir], { cwd: rootDir });
        } else {
          throw err;
        }
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Refresh cache best-effort.
  try {
    const latest = await fetchLatestVersion({ packageName: pkgName });
    const runtimeVersion = await getRuntimeInstalledVersion();
    const invokerVersion = await getInvokerVersion({ rootDir });
    const current = runtimeVersion || invokerVersion;
    const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);
    const { updateJson, cacheDir } = cachePaths();
    await mkdir(cacheDir, { recursive: true });
    await writeJsonSafe(updateJson, {
      checkedAt: Date.now(),
      latest,
      current: current || null,
      runtimeVersion: runtimeVersion || null,
      invokerVersion: invokerVersion || null,
      updateAvailable,
      notifiedAt: null,
    });
  } catch {
    // ignore
  }

  const runtimeVersionAfter = await getRuntimeInstalledVersion();
  printResult({
    json,
    data: { ok: true, runtimeDir, version: runtimeVersionAfter ?? null, spec },
    text: `${green('✓')} updated runtime in ${cyan(runtimeDir)} ${dim('(')}${cyan(runtimeVersionAfter ?? spec)}${dim(')')}`,
  });
}

async function cmdCheck({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const quiet = flags.has('--quiet');

  const { updateJson, cacheDir } = cachePaths();
  const runtimeVersion = await getRuntimeInstalledVersion();
  const invokerVersion = await getInvokerVersion({ rootDir });
  const current = runtimeVersion || invokerVersion;
  const invoker = await readJsonIfExists(join(rootDir, 'package.json'), { defaultValue: null });
  const packageName = String(invoker?.name ?? '').trim();

  let latest = null;
  try {
    latest = await fetchLatestVersion({ packageName });
  } catch {
    latest = null;
  }

  const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);
  await mkdir(cacheDir, { recursive: true });
  await writeJsonSafe(updateJson, {
    checkedAt: Date.now(),
    latest,
    current: current || null,
    runtimeVersion: runtimeVersion || null,
    invokerVersion: invokerVersion || null,
    updateAvailable,
    notifiedAt: null,
  });

  if (quiet) {
    return;
  }
  printResult({
    json,
    data: { ok: true, current: current || null, latest, updateAvailable },
    text: latest
      ? updateAvailable
        ? `${yellow('!')} update available: ${cyan(current)} → ${cyan(latest)}\n${dim('Run:')} ${cmd('hstack self update')}`
        : `${green('✓')} up to date ${dim('(')}${cyan(current)}${dim(')')}`
      : `${yellow('!')} unable to check latest version`,
  });
}

function resolveCliRootCandidate({ rootDir, target }) {
  const raw = String(target ?? '').trim();
  if (!raw) return null;

  const workspaceDir = getWorkspaceDir(rootDir, process.env);
  if (raw === 'main') {
    return join(getRepoDir(rootDir, process.env), 'apps', 'stack');
  }
  if (raw === 'dev') {
    return join(getDevRepoDir(rootDir, process.env), 'apps', 'stack');
  }

  // Allow absolute/relative path targets. If the path is a monorepo root, accept apps/stack.
  const expanded = expandHome(raw);
  const abs = expanded.startsWith('/') ? expanded : resolve(process.cwd(), expanded);
  if (existsSync(join(abs, 'bin', 'hstack.mjs'))) return abs;
  if (existsSync(join(abs, 'apps', 'stack', 'bin', 'hstack.mjs'))) return join(abs, 'apps', 'stack');
  if (existsSync(join(abs, 'package.json')) && existsSync(join(abs, 'bin', 'hstack.mjs'))) return abs;
  // If user passed a workspace dir by mistake, allow selecting main/dev via keywords.
  void workspaceDir;
  return abs;
}

async function cmdUseCli({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positional = argv.filter((a) => !a.startsWith('--'));
  const target = positional[1] ?? '';
  const stackFlag = String(kv.get('--stack') ?? '').trim();

  const key = 'HAPPIER_STACK_CLI_ROOT_DIR';
  const homeEnv = getHomeEnvPath();
  const canonicalEnv = getCanonicalHomeEnvPath();

  if ((!target && !stackFlag) || wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { ok: true, command: 'use-cli', targets: ['default', 'main', 'dev', '/abs/path/to/apps/stack'], flags: ['--stack=<name>'] },
      text: [
        banner('self use-cli', { subtitle: 'Point the hstack shim at a local checkout (or reset to runtime).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack self')} use-cli default`,
        `  ${cyan('hstack self')} use-cli main`,
        `  ${cyan('hstack self')} use-cli dev`,
        `  ${cyan('hstack self')} use-cli /abs/path/to/apps/stack`,
        `  ${cyan('hstack self')} use-cli --stack=<name>`,
        '',
        sectionTitle('notes:'),
        bullets([
          `Writes ${cyan(homeEnv)} and ${cyan(canonicalEnv)}.`,
          `Takes effect for new shells (and SwiftBar/launchd) because the ${cyan('hstack')} shim reads the canonical pointer file.`,
        ]),
      ].join('\n'),
    });
    return;
  }

  if (target === 'default' || target === 'runtime') {
    await ensureEnvFilePruned({ envPath: homeEnv, removeKeys: [key] });
    await ensureEnvFilePruned({ envPath: canonicalEnv, removeKeys: [key] });
    printResult({
      json,
      data: { ok: true, mode: 'runtime' },
      text: `${green('✓')} using runtime CLI (cleared ${cyan(key)})`,
    });
    return;
  }

  const candidate = (() => {
    if (!stackFlag) return resolveCliRootCandidate({ rootDir, target });
    return null;
  })();

  if (stackFlag) {
    const { envPath } = resolveStackEnvPath(stackFlag, process.env);
    const raw = existsSync(envPath) ? await readFile(envPath, 'utf-8') : '';
    const parsed = raw ? parseEnvToObject(raw) : {};
    const repoDirRaw = String(parsed.HAPPIER_STACK_REPO_DIR ?? '').trim();
    if (!repoDirRaw) {
      throw new Error(`[self use-cli] stack "${stackFlag}" has no HAPPIER_STACK_REPO_DIR in ${envPath}`);
    }
    const repoRoot = coerceHappyMonorepoRootFromPath(repoDirRaw) || repoDirRaw;
    const fromStack = join(repoRoot, 'apps', 'stack');
    const entry = join(fromStack, 'bin', 'hstack.mjs');
    if (!existsSync(entry)) {
      throw new Error(`[self use-cli] stack "${stackFlag}" repo does not contain apps/stack (${entry} missing)`);
    }
    await ensureHomeEnvUpdated({ updates: [{ key, value: fromStack }] });
    await ensureCanonicalHomeEnvUpdated({ updates: [{ key, value: fromStack }] });
    printResult({
      json,
      data: { ok: true, mode: 'local', stack: stackFlag, cliRootDir: fromStack },
      text: `${green('✓')} using local CLI from stack "${stackFlag}" at ${cyan(fromStack)}`,
    });
    return;
  }

  const entry = candidate ? join(candidate, 'bin', 'hstack.mjs') : null;
  if (!candidate || !entry || !existsSync(entry)) {
    throw new Error(
      `[self use-cli] invalid target: ${target}\n` +
        `Expected one of: default|main|dev|/abs/path/to/apps/stack\n` +
        `Missing: ${entry || '<path>/bin/hstack.mjs'}`
    );
  }

  await ensureHomeEnvUpdated({ updates: [{ key, value: candidate }] });
  await ensureCanonicalHomeEnvUpdated({ updates: [{ key, value: candidate }] });
  printResult({
    json,
    data: { ok: true, mode: 'local', cliRootDir: candidate },
    text: `${green('✓')} using local CLI at ${cyan(candidate)}`,
  });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);

  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const cmd = helpScopeArgv.find((a) => a && a !== '--' && !a.startsWith('-')) ?? 'help';

  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const json = wantsJson(helpScopeArgv, { flags });
  const usageByCmd = new Map([
    ['status', 'hstack self status [--no-check] [--json]'],
    ['update', 'hstack self update [--to=<version>] [--json]'],
    ['check', 'hstack self check [--quiet] [--json]'],
    ['use-cli', 'hstack self use-cli default|main|dev|/abs/path/to/apps/stack [--json]'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[self ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack self --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'update', 'check', 'use-cli'], flags: ['--no-check', '--to=<version>', '--quiet'] },
      text: [
        banner('self', { subtitle: 'Runtime install + self-update.' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack self')} status [--no-check] [--json]`,
        `  ${cyan('hstack self')} update [--to=<version>] [--json]`,
        `  ${cyan('hstack self')} check [--quiet] [--json]`,
        `  ${cyan('hstack self')} use-cli default|main|dev|/abs/path/to/apps/stack [--json]`,
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'status') {
    await cmdStatus({ rootDir, argv });
    return;
  }
  if (cmd === 'update') {
    await cmdUpdate({ rootDir, argv });
    return;
  }
  if (cmd === 'check') {
    await cmdCheck({ rootDir, argv });
    return;
  }
  if (cmd === 'use-cli') {
    await cmdUseCli({ rootDir, argv });
    return;
  }

  throw new Error(`[self] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[self] failed:', err);
  process.exit(1);
});
