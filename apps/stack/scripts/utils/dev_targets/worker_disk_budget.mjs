import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import { pruneWorkerYarnCache } from '../proc/package_manager_cache.mjs';

const targetName = /^(linux|darwin|win32)-(x64|arm64)$/;
const classes = ['validation', 'dependency-install', 'package-dist', 'runtime-build', 'compilation'];

function directory(path) {
  try { return lstatSync(path).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function allocatedBytes(path) {
  if (!directory(path)) return 0;
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  const kib = Number(/^\s*(\d+)\s/.exec(result.stdout ?? '')?.[1]);
  if (result.error || result.status !== 0 || !Number.isSafeInteger(kib)) throw new Error(`disk footprint unavailable for ${path}: ${result.stderr || result.error?.message}`);
  return kib * 1024;
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

function retainedStaging(runtimeBuildRoot) {
  if (!directory(runtimeBuildRoot)) return [];
  const stages = [];
  for (const stack of readdirSync(runtimeBuildRoot, { withFileTypes: true })) {
    if (!stack.isDirectory()) continue;
    const parent = join(runtimeBuildRoot, stack.name);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const legacy = ['repo', 'cache'].includes(entry.name);
      if (!entry.isDirectory() || (!legacy && !targetName.test(entry.name))) continue;
      const path = join(parent, entry.name);
      // Captured membership is written when this target is actually consumed,
      // rather than when its otherwise-retained parent happens to be touched.
      let lastBuiltMs = lstatSync(path).mtimeMs;
      try { lastBuiltMs = lstatSync(join(path, 'source-files.json')).mtimeMs; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      stages.push({ path, parent, name: entry.name, lastBuiltMs, legacy });
    }
  }
  return stages.sort((a, b) => a.lastBuiltMs - b.lastBuiltMs);
}

function protectedRepositories(repoDir) {
  // Released/predecessor mirrors can use the same worker cache. Preserve the
  // existing sibling lockfile frontier as well as retained target lockfiles.
  const repositories = [repoDir];
  for (const sibling of ['0.2', '0.3']) {
    const candidate = join(dirname(repoDir), sibling);
    if (candidate === repoDir) continue;
    try { if (lstatSync(join(candidate, 'yarn.lock')).isFile()) repositories.push(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return repositories;
}

export function pruneWorkerRuntimeStaging({ runtimeBuildRoot, target = '', workspaceDir = '', procRoot = '/proc', ownerUid = process.getuid() }) {
  const stages = retainedStaging(runtimeBuildRoot);
  const newest = new Map(stages.filter(stage => !stage.legacy).map(stage => [stage.name, stage.path]));
  const result = { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null };
  for (const stage of stages) {
    if (stage.path === workspaceDir || (stage.name === target && newest.get(target) === stage.path)) continue;
    const step = reapHistoricalTempRoots(stage.parent, procRoot, { candidateNames: [stage.name], ownerUid });
    for (const key of ['reclaimedBytes', 'reclaimedRoots', 'retainedRoots']) result[key] += step[key];
    result.observationUnavailable ??= step.observationUnavailable;
  }
  return result;
}

// Measure the resident install/build closure on this worker, including its
// shared package/native caches. This is a conservative cold-copy envelope;
// it is not a temporal peak measurement or a guarantee for unobserved builds.
export async function inspectWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass = 'runtime-build', admissionRoot, ownOwnerPath, observeFilesystem = observeWorkerFilesystem }) {
  if (['targeted-validation', 'full-validation'].includes(commandClass)) commandClass = 'validation';
  if (!classes.includes(commandClass)) throw new Error(`unknown worker disk class: ${commandClass}`);
  const runtimeBuildRoot = join(dirname(resolve(cacheBaseDir)), 'runtime-build');
  const stages = retainedStaging(runtimeBuildRoot).filter(stage => !stage.legacy);
  const dependencyBytes = Math.max(allocatedBytes(join(repoDir, 'node_modules')),
    ...stages.map(stage => allocatedBytes(join(stage.path, 'repo/node_modules'))));
  const stagingBytes = Math.max(dependencyBytes, ...stages.map(stage => allocatedBytes(stage.path)));
  const packageCacheBytes = allocatedBytes(join(cacheBaseDir, 'yarn'));
  const cacheBytes = allocatedBytes(cacheBaseDir);
  const installBytes = dependencyBytes + packageCacheBytes;
  const buildBytes = stagingBytes + cacheBytes;
  const measurements = { dependencyBytes, packageCacheBytes, stagingBytes, cacheBytes,
    basis: 'allocated worker install/build closure; temporal peak not measured' };
  const requirements = new Map();
  const charge = (path, bytes) => {
    const fs = observeFilesystem(path);
    const previous = requirements.get(fs.device);
    requirements.set(fs.device, { ...fs, path, requiredBytes: (previous?.requiredBytes ?? 0) + bytes });
  };
  if (commandClass === 'dependency-install' || commandClass === 'validation') {
    charge(repoDir, dependencyBytes);
    charge(cacheBaseDir, packageCacheBytes);
  } else {
    charge(runtimeBuildRoot, stagingBytes);
    charge(cacheBaseDir, cacheBytes);
  }
  const filesystems = [...requirements.values()];
  for (const fs of filesystems) fs.reservedBytes = 0;
  if (admissionRoot && process.platform === 'linux') {
    const { readWorkerMemoryReservations } = await import('../proc/service_memory.mjs');
    const { admittedOwners } = readWorkerMemoryReservations({ admissionRoot, includeAdmittedRss: true, includeOwnerProgress: true });
    for (const owner of admittedOwners) {
      const ownerPath = join(admissionRoot, 'owners', `${owner.pid}-${owner.token}`);
      if (ownerPath === ownOwnerPath) continue;
      // Only the existing owner authenticates live PID generations. An old
      // loaded job without a disk envelope is unknown, never free headroom.
      const disk = JSON.parse(readFileSync(join(ownerPath, 'disk'), 'utf8'));
      if (!Array.isArray(disk.filesystems) || disk.filesystems.some(fs => typeof fs.device !== 'string' || !Number.isSafeInteger(fs.requiredBytes) || fs.requiredBytes < 0)) throw new Error('live worker disk reservation unavailable');
      for (const fs of filesystems) fs.reservedBytes += disk.filesystems.filter(peer => peer.device === fs.device).reduce((sum, peer) => sum + peer.requiredBytes, 0);
    }
  }
  const requiredBytes = commandClass === 'dependency-install' || commandClass === 'validation' ? installBytes : buildBytes;
  const admitted = dependencyBytes > 0 && filesystems.every(fs => fs.availableBytes - fs.reservedBytes >= fs.requiredBytes);
  return { admitted, commandClass, requiredBytes, measurements, filesystems,
    reason: !dependencyBytes ? 'worker dependency footprint unobserved' : admitted ? 'ready' : 'insufficient worker disk headroom' };
}

export async function admitWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass, admissionRoot, ownOwnerPath, target = '', scratchRoot = tmpdir(), procRoot = '/proc', ownerUid = process.getuid(), observeFilesystem = observeWorkerFilesystem, maintenance = false }) {
  const options = { repoDir, cacheBaseDir, commandClass, admissionRoot, ownOwnerPath, observeFilesystem };
  const initial = await inspectWorkerDiskBudget(options);
  const reclamation = [];
  let current = initial;
  const runtimeBuildRoot = join(dirname(resolve(cacheBaseDir)), 'runtime-build');
  // Maintenance enforces age retention even on roomy workers. Admission only
  // spends time reclaiming when the measured containing filesystem is short.
  if ((!initial.admitted || maintenance) && process.platform === 'linux') {
    const steps = [
      ['staging', () => pruneWorkerRuntimeStaging({ runtimeBuildRoot, target, procRoot, ownerUid })],
      ['packages', () => pruneWorkerYarnCache({ cacheBaseDir, repositoryDirectories: protectedRepositories(repoDir), runtimeBuildRoot: directory(runtimeBuildRoot) ? runtimeBuildRoot : undefined, procRoot, ownerUid })],
      ['scratch', () => directory(scratchRoot) ? reapHistoricalTempRoots(scratchRoot, procRoot, { ownerUid }) : { reclaimedBytes: 0, reclaimedRoots: 0 }],
    ];
    for (const [kind, run] of steps) {
      reclamation.push({ kind, ...run() });
      // Reobserve space without shrinking the envelope after deleting its
      // evidence. Deletion must not make an otherwise-unfit worker look fit.
      current = { ...initial, filesystems: initial.filesystems.map(fs => ({ ...fs, ...observeFilesystem(fs.path) })) };
      current.admitted = initial.measurements.dependencyBytes > 0 && current.filesystems.every(fs => fs.availableBytes - fs.reservedBytes >= fs.requiredBytes);
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
      commandClass: value('class') ?? 'runtime-build', target: value('target') ?? '',
      admissionRoot: value('admission-root'), ownOwnerPath: value('own-owner-path'),
      ...(value('owner-uid') ? { ownerUid: Number(value('owner-uid')) } : {}) };
    if (!options.cacheBaseDir) throw new Error('configured worker cache owner unavailable');
    const result = args.includes('--admit') || args.includes('--maintenance')
      ? await admitWorkerDiskBudget({ ...options, maintenance: args.includes('--maintenance') }) : await inspectWorkerDiskBudget(options);
    if (args.includes('--admit')) {
      process.stderr.write(`[preferred-execution] worker disk class=${result.commandClass} requires=${result.requiredBytes} bytes; ${result.filesystems.map(fs => `free=${fs.availableBytes}/${fs.totalBytes} reserved=${fs.reservedBytes}`).join('; ')}; reclaimed=${result.reclaimedBytes} bytes; ${result.reason}\n`);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.admitted ? 0 : 76;
    } else process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`[preferred-execution] worker disk observation unavailable: ${error.message}\n`);
    process.exitCode = 76;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWorkerDiskBudgetCommand();
