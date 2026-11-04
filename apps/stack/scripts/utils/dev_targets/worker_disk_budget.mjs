import { lstatSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import { measureReplicaSourceBytes } from './replica_source_bytes.mjs';
import { measureColdDependencyBytes } from './dependency_materialization.mjs';
import { HEAVYWEIGHT_COMMAND_RESOURCES, LEGACY_VALIDATION_ADMISSION_CLASSES } from './command_resources.mjs';
import { getHappierTempRootForUid, prepareHappierTempDirOwnerCleanup, readHappierTempDirOwnerForDirectory,
  readHappierTempDirOwnerLiveness } from '../../../../../packages/cli-common/tempDirOwnership.mjs';

const writeRootsByClass = {
  validation: ['repoDir'],
  'source-replica': ['repoDir'],
  'dependency-install': ['repoDir', 'cacheBaseDir'],
  'package-dist': ['repoDir'],
  'runtime-build': ['repoDir', 'cacheBaseDir', 'scratchRoot'],
  'source-bundle': ['cacheBaseDir'],
  'source-web-export': ['cacheBaseDir', 'scratchRoot'],
  compilation: ['repoDir'],
};

// Largest observed validation TMPDIR on mac2-linux (2026-11-01):
// 1,886,444 KiB allocated. Leave room for another run before placing work.
const measuredValidationScratchBytes = 1_931_718_656;

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

// Refuse exhaustion and measured additional writes. Resident
// dependencies, caches and other jobs' outputs are not additional demand.
export async function inspectWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass = 'runtime-build', scratchRoot = tmpdir(), requiredAdditionalBytes = 0, observeFilesystem = observeWorkerFilesystem }) {
  if (!Number.isSafeInteger(requiredAdditionalBytes) || requiredAdditionalBytes < 0) {
    throw new Error('worker additional-write measurement must be a nonnegative safe integer');
  }
  // The same catalog owns memory and disk demand. Keep only historical
  // transport labels here; new admission classes declare their disk shape once.
  commandClass = HEAVYWEIGHT_COMMAND_RESOURCES[commandClass]?.diskClass
    ?? (LEGACY_VALIDATION_ADMISSION_CLASSES.includes(commandClass) ? 'validation' : commandClass);
  if (commandClass === 'validation') requiredAdditionalBytes = Math.max(requiredAdditionalBytes, measuredValidationScratchBytes);
  if (!Object.hasOwn(writeRootsByClass, commandClass)) throw new Error(`unknown worker disk class: ${commandClass}`);
  const observations = new Map();
  const roots = { repoDir, cacheBaseDir, scratchRoot };
  for (const root of writeRootsByClass[commandClass]) {
    const path = roots[root];
    const fs = observeFilesystem(path);
    observations.set(fs.device, { ...fs, path });
  }
  const filesystems = [...observations.values()];
  const admitted = filesystems.every(fs => fs.availableBytes > requiredAdditionalBytes);
  return { admitted, commandClass, filesystems, reason: admitted ? 'ready'
    : filesystems.some(fs => fs.availableBytes === 0) ? 'worker write filesystem exhausted'
      : `worker disk headroom below measured additional writes (requires>${requiredAdditionalBytes} bytes free)` };
}

export async function admitWorkerDiskBudget({ repoDir, cacheBaseDir, commandClass, scratchRoot = tmpdir(), additionalScratchRoots = [], requiredAdditionalBytes = 0, procRoot = '/proc', ownerUid = process.getuid(), observeFilesystem = observeWorkerFilesystem, maintenance = false }) {
  const options = { repoDir, cacheBaseDir, commandClass, scratchRoot, requiredAdditionalBytes, observeFilesystem };
  const initial = await inspectWorkerDiskBudget(options);
  const reclamation = [];
  let current = initial;
  // Maintenance enforces age retention even on roomy workers. Admission only
  // spends time reclaiming when the measured containing filesystem is short.
  // A command-replica marker, age and process absence do not establish that
  // the controller-owned Mutagen session is inactive. This worker therefore
  // has no authority to reclaim command replicas, including in maintenance.
  if ((!initial.admitted || maintenance) && process.platform === 'linux') {
    const steps = [
      ['runtime-build', () => reapRuntimeBuildStaging(cacheBaseDir, scratchRoot, procRoot, ownerUid)],
      ['scratch', () => {
        const result = { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null };
        // Custody's tmpdir is command-private; historical jobs are its siblings
        // beneath the configured CLI home, even with an explicit TMPDIR.
        for (const parent of new Set([scratchRoot, join(dirname(cacheBaseDir), 'tmp'), ...additionalScratchRoots])) {
          if (!directory(parent)) continue;
          const sweep = reapHistoricalTempRoots(parent, procRoot, { ownerUid });
          for (const key of ['reclaimedBytes', 'reclaimedRoots', 'retainedRoots']) result[key] += sweep[key];
          result.observationUnavailable ??= sweep.observationUnavailable;
        }
        return result;
      }],
    ];
    for (const [kind, run] of steps) {
      reclamation.push({ kind, ...await run() });
      // Reobserve the same write filesystems after custody-safe reclamation.
      current = await inspectWorkerDiskBudget(options);
      if (current.admitted && !maintenance) break;
    }
  }
  return { ...current,
    reclaimedBytes: reclamation.reduce((sum, step) => sum + step.reclaimedBytes, 0), reclamation };
}

export async function runWorkerDiskBudgetCommand(args = process.argv.slice(2)) {
  const value = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  try {
    const options = { repoDir: value('repo') ?? process.cwd(), cacheBaseDir: value('cache') ?? process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR,
      commandClass: value('class') ?? 'runtime-build',
      requiredAdditionalBytes: Number(value('required-additional-bytes') ?? 0),
      // Historical source-runtime jobs also used the persistent system temp
      // root. Its age/UID/inode/live-use policy remains the same reaper's.
      additionalScratchRoots: process.platform === 'linux' ? ['/var/tmp'] : [],
      ...(value('owner-uid') ? { ownerUid: Number(value('owner-uid')) } : {}) };
    if (!options.cacheBaseDir) throw new Error('configured worker cache owner unavailable');
    // A failed first transition may already contain package.json. Reuse the
    // same source membership for its resident bytes; the difference is a
    // demonstrated minimum, not a replacement/staging/concurrency peak.
    if (args.includes('--source-materialization') && directory(options.repoDir)) {
      options.requiredAdditionalBytes = Math.max(0, options.requiredAdditionalBytes
        - await measureReplicaSourceBytes(options.repoDir));
    }
    const footprint = args.includes('--cold-dependencies')
      ? await measureColdDependencyBytes({ repoDir: options.repoDir }) : null;
    if (footprint) {
      options.requiredAdditionalBytes = Math.max(options.requiredAdditionalBytes, footprint.requiredAdditionalBytes);
      for (const warning of footprint.warnings) {
        process.stderr.write(`[preferred-execution] warning ${JSON.stringify(warning)}\n`);
      }
      // This is an additional pre-bootstrap check. The containing command
      // already owns ordinary disk admission: no measured demand must not add
      // another filesystem gate for pnpm, a warm tree or an unmatched identity.
      if (options.requiredAdditionalBytes === 0) {
        process.stdout.write(JSON.stringify({ admitted: true, commandClass: options.commandClass,
          filesystems: [], reason: 'no measured additional dependency writes', reclaimedBytes: 0,
          reclamation: [], warnings: footprint.warnings }) + '\n');
        process.exitCode = 0;
        return;
      }
    }
    const result = args.includes('--admit') || args.includes('--maintenance')
      ? await admitWorkerDiskBudget({ ...options, maintenance: args.includes('--maintenance') }) : await inspectWorkerDiskBudget(options);
    if (footprint?.warnings.length) result.warnings = footprint.warnings;
    if (args.includes('--admit')) {
      process.stderr.write(`[preferred-execution] worker disk class=${result.commandClass}; ${result.filesystems.map(fs => `free=${fs.availableBytes}/${fs.totalBytes} path=${fs.path}`).join('; ')}; reclaimed=${result.reclaimedBytes} bytes; ${result.reason}\n`);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.admitted ? 0 : 76;
    } else {
      process.stdout.write(JSON.stringify(result) + '\n');
      // Placement consumes the same class decision without reclaiming or
      // entering admission. Status/diagnostic callers retain their JSON API.
      if (args.includes('--check')) process.exitCode = result.admitted ? 0 : 76;
    }
  } catch (error) {
    process.stderr.write(`[preferred-execution] worker disk observation unavailable: ${error.message}\n`);
    process.exitCode = 76;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWorkerDiskBudgetCommand();
