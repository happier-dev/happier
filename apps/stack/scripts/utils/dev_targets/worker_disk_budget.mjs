import { lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import { pruneWorkerYarnCache } from '../proc/package_manager_cache.mjs';

const classes = ['validation', 'dependency-install', 'package-dist', 'runtime-build', 'source-bundle', 'compilation'];

function directory(path) {
  try { return lstatSync(path).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function existingParent(path) {
  while (!directory(path)) {
    const parent = dirname(path);
    if (path === parent) throw new Error('worker filesystem unavailable');
    path = parent;
  }
  return path;
}

export function observeWorkerFilesystem(path) {
  const parent = existingParent(path);
  const result = spawnSync('df', ['-Pk', parent], { encoding: 'utf8' });
  const fields = result.stdout?.trim().split('\n').at(-1)?.trim().split(/\s+/);
  const totalBytes = Number(fields?.[1]) * 1024, availableBytes = Number(fields?.[3]) * 1024;
  if (result.error || result.status !== 0 || !Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)
    || totalBytes <= 0 || availableBytes < 0) throw new Error(`worker free-space observation unavailable for ${path}`);
  return { device: String(statSync(parent).dev), totalBytes, availableBytes };
}

function protectedRepositories(repoDir) {
  // Released/predecessor mirrors can use the same worker cache. Preserve the
  // existing sibling lockfile frontier.
  const repositories = [repoDir];
  for (const sibling of ['0.2', '0.3']) {
    const candidate = join(dirname(repoDir), sibling);
    if (candidate === repoDir) continue;
    try { if (lstatSync(join(candidate, 'yarn.lock')).isFile()) repositories.push(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return repositories;
}

// Refuse already-exhausted write filesystems. Resident dependencies, caches
// and other jobs' existing outputs do not establish this operation's future
// writes. No additional-write peak is measured, so do not invent a reservation.
export async function inspectWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass = 'runtime-build', scratchRoot = tmpdir(), observeFilesystem = observeWorkerFilesystem }) {
  if (['targeted-validation', 'full-validation'].includes(commandClass)) commandClass = 'validation';
  if (['compilation-ui', 'compilation-cli', 'compilation-server'].includes(commandClass)) commandClass = 'compilation';
  if (!classes.includes(commandClass)) throw new Error(`unknown worker disk class: ${commandClass}`);
  const observations = new Map();
  const paths = ['package-dist', 'compilation', 'validation'].includes(commandClass)
    ? [repoDir]
    : commandClass === 'dependency-install' ? [repoDir, cacheBaseDir]
      // Shared source bundles and the configured cache live on the target home
      // filesystem; source builds do not write native runtime staging.
      : commandClass === 'source-bundle' ? [cacheBaseDir] : [repoDir, cacheBaseDir, scratchRoot];
  for (const path of paths) {
    const fs = observeFilesystem(path);
    observations.set(fs.device, { ...fs, path });
  }
  const filesystems = [...observations.values()];
  const admitted = filesystems.every(fs => fs.availableBytes > 0);
  return { admitted, commandClass, filesystems, reason: admitted ? 'ready' : 'worker write filesystem exhausted' };
}

export async function admitWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass, scratchRoot = tmpdir(), procRoot = '/proc', ownerUid = process.getuid(), observeFilesystem = observeWorkerFilesystem, maintenance = false }) {
  const options = { repoDir, cacheBaseDir, commandClass, scratchRoot, observeFilesystem };
  const initial = await inspectWorkerDiskBudget(options);
  const reclamation = [];
  let current = initial;
  // Maintenance enforces age retention even on roomy workers. Admission only
  // spends time reclaiming when the measured containing filesystem is short.
  if ((!initial.admitted || maintenance) && process.platform === 'linux') {
    const steps = [
      ['packages', () => pruneWorkerYarnCache({ cacheBaseDir, repositoryDirectories: protectedRepositories(repoDir), procRoot, ownerUid })],
      ['scratch', () => directory(scratchRoot) ? reapHistoricalTempRoots(scratchRoot, procRoot, { ownerUid }) : { reclaimedBytes: 0, reclaimedRoots: 0 }],
    ];
    for (const [kind, run] of steps) {
      reclamation.push({ kind, ...run() });
      // Reobserve the same write filesystems after custody-safe reclamation.
      current = { ...initial, filesystems: initial.filesystems.map(fs => ({ ...fs, ...observeFilesystem(fs.path) })) };
      current.admitted = current.filesystems.every(fs => fs.availableBytes > 0);
      if (current.admitted && !maintenance) break;
    }
  }
  return { ...current, reason: current.admitted ? 'ready' : initial.reason,
    reclaimedBytes: reclamation.reduce((sum, step) => sum + step.reclaimedBytes, 0), reclamation };
}

export async function runWorkerDiskBudgetCommand(args = process.argv.slice(2)) {
  const value = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  try {
    const options = { repoDir: value('repo') ?? process.cwd(), cacheBaseDir: value('cache') ?? process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR,
      commandClass: value('class') ?? 'runtime-build',
      ...(value('owner-uid') ? { ownerUid: Number(value('owner-uid')) } : {}) };
    if (!options.cacheBaseDir) throw new Error('configured worker cache owner unavailable');
    const result = args.includes('--admit') || args.includes('--maintenance')
      ? await admitWorkerDiskBudget({ ...options, maintenance: args.includes('--maintenance') }) : await inspectWorkerDiskBudget(options);
    if (args.includes('--admit')) {
      process.stderr.write(`[preferred-execution] worker disk class=${result.commandClass}; ${result.filesystems.map(fs => `free=${fs.availableBytes}/${fs.totalBytes} path=${fs.path}`).join('; ')}; reclaimed=${result.reclaimedBytes} bytes; ${result.reason}\n`);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.admitted ? 0 : 76;
    } else process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`[preferred-execution] worker disk observation unavailable: ${error.message}\n`);
    process.exitCode = 76;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWorkerDiskBudgetCommand();
