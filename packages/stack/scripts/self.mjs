import './utils/env/env.mjs';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
      updateAvailable ? `${dim('Run:')} ${cmd('happys self update')}` : null,
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
        ? `${yellow('!')} update available: ${cyan(current)} → ${cyan(latest)}\n${dim('Run:')} ${cmd('happys self update')}`
        : `${green('✓')} up to date ${dim('(')}${cyan(current)}${dim(')')}`
      : `${yellow('!')} unable to check latest version`,
  });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);

  const { flags } = parseArgs(argv);
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    const json = wantsJson(argv, { flags });
    printResult({
      json,
      data: { commands: ['status', 'update', 'check'], flags: ['--no-check', '--to=<version>', '--quiet'] },
      text: [
        banner('self', { subtitle: 'Runtime install + self-update.' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('happys self')} status [--no-check] [--json]`,
        `  ${cyan('happys self')} update [--to=<version>] [--json]`,
        `  ${cyan('happys self')} check [--quiet] [--json]`,
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

  throw new Error(`[self] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[self] failed:', err);
  process.exit(1);
});
