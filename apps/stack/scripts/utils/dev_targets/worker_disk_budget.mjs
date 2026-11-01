import { lstatSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import { getHappierTempRootForUid, prepareHappierTempDirOwnerCleanup, readHappierTempDirOwnerForDirectory,
  readHappierTempDirOwnerLiveness } from '../../../../../packages/cli-common/tempDirOwnership.mjs';

const writeRootsByClass = {
  validation: ['repoDir'],
  'dependency-install': ['repoDir', 'cacheBaseDir'],
  'package-dist': ['repoDir'],
  'runtime-build': ['repoDir', 'cacheBaseDir', 'scratchRoot'],
  'source-bundle': ['cacheBaseDir'],
  'source-web-export': ['cacheBaseDir', 'scratchRoot'],
  compilation: ['repoDir'],
};

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

function reapRetiredRuntimeBuildRoots(cacheBaseDir, procRoot, ownerUid) {
  // The former remote runtime producer wrote per-stack source generations and
  // private artifact stores here. Current builds use custody-owned temporary
  // roots and import final artifacts into the controller's retained store.
  // Retire only that known old layout; custody owns age, inode and live-use proof.
  const parent = join(dirname(cacheBaseDir), 'runtime-build');
  const result = { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null };
  try {
    if (!directory(parent) || lstatSync(parent).uid !== ownerUid) return result;
    for (const scope of readdirSync(parent)) {
      const generationParent = join(parent, scope);
      if (!directory(generationParent) || lstatSync(generationParent).uid !== ownerUid) continue;
      const candidateNames = readdirSync(generationParent).filter(name =>
        /^(?:linux|darwin|win32)-(?:x64|arm64)$/.test(name)
        || name === 'store' || name.startsWith('.incoming-happier-runtime-build-'));
      const sweep = reapHistoricalTempRoots(generationParent, procRoot, { ownerUid, candidateNames });
      for (const key of ['reclaimedBytes', 'reclaimedRoots', 'retainedRoots']) result[key] += sweep[key];
      result.observationUnavailable ??= sweep.observationUnavailable;
    }
  } catch (error) {
    result.observationUnavailable = `retired runtime-build observation unavailable (${error.code ?? error.name})`;
  }
  return result;
}

async function reapRuntimeBuildStaging(cacheBaseDir, scratchRoot, procRoot, ownerUid) {
  const result = reapRetiredRuntimeBuildRoots(cacheBaseDir, procRoot, ownerUid);
  const namespace = getHappierTempRootForUid(scratchRoot, ownerUid);
  if (!directory(namespace) || lstatSync(namespace).uid !== ownerUid) return result;
  const candidates = readdirSync(namespace).filter(name => {
    const path = join(namespace, name);
    if (!directory(path)) return false;
    const owner = readHappierTempDirOwnerForDirectory(path, ownerUid);
    return owner?.purpose === 'runtime-build' && readHappierTempDirOwnerLiveness(owner) === 'gone';
  });
  const cleanups = candidates.map(name => prepareHappierTempDirOwnerCleanup(join(namespace, name), ownerUid));
  const sweep = reapHistoricalTempRoots(namespace, procRoot, { ownerUid, candidateNames: candidates });
  // The SDK removes only the captured unchanged sidecar after its directory
  // is absent; directory eligibility and removal remain the canonical reaper's.
  for (const cleanup of cleanups) await cleanup();
  for (const key of ['reclaimedBytes', 'reclaimedRoots', 'retainedRoots']) result[key] += sweep[key];
  result.observationUnavailable ??= sweep.observationUnavailable;
  return result;
}

// Refuse already-exhausted write filesystems. Resident dependencies, caches
// and other jobs' existing outputs do not establish this operation's future
// writes. No additional-write peak is measured, so do not invent a reservation.
export async function inspectWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass = 'runtime-build', scratchRoot = tmpdir(), observeFilesystem = observeWorkerFilesystem }) {
  if (['targeted-validation', 'full-validation', 'native-source-test'].includes(commandClass)) commandClass = 'validation';
  if (['compilation-ui', 'compilation-cli', 'compilation-server'].includes(commandClass)) commandClass = 'compilation';
  if (!Object.hasOwn(writeRootsByClass, commandClass)) throw new Error(`unknown worker disk class: ${commandClass}`);
  const observations = new Map();
  const roots = { repoDir, cacheBaseDir, scratchRoot };
  for (const root of writeRootsByClass[commandClass]) {
    const path = roots[root];
    const fs = observeFilesystem(path);
    observations.set(fs.device, { ...fs, path });
  }
  const filesystems = [...observations.values()];
  const admitted = filesystems.every(fs => fs.availableBytes > 0);
  return { admitted, commandClass, filesystems, reason: admitted ? 'ready' : 'worker write filesystem exhausted' };
}

async function reapWorkerScratch(repoDir, scratchRoot, procRoot, ownerUid) {
  const result = directory(scratchRoot) ? reapHistoricalTempRoots(scratchRoot, procRoot, { ownerUid })
    : { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null };
  return result;
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
      ['runtime-build', () => reapRuntimeBuildStaging(cacheBaseDir, scratchRoot, procRoot, ownerUid)],
      ['scratch', () => reapWorkerScratch(repoDir, scratchRoot, procRoot, ownerUid)],
    ];
    for (const [kind, run] of steps) {
      reclamation.push({ kind, ...await run() });
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
