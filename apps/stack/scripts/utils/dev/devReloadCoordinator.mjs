import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { watchDebounced } from '../proc/watch.mjs';
export { resolveDevReloadPollIntervalMs } from './reloadPollInterval.mjs';

const RESTART_ORDER = ['server', 'daemon'];

export function appendWatchSignatureEntries(path, entries) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    let names = [];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort();
    } catch {
      return true;
    }
    for (const name of names) {
      appendWatchSignatureEntries(join(path, name), entries);
    }
    return true;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    entries.push(`${path}\0file\0${stats.size}\0${Math.trunc(stats.mtimeMs)}`);
    return true;
  }

  entries.push(`${path}\0other\0${Math.trunc(stats.mtimeMs)}`);
  return true;
}

export function readDevReloadWatchChangeSignature(paths) {
  const entries = [];
  let observed = false;
  for (const path of Array.isArray(paths) ? paths : []) {
    observed = appendWatchSignatureEntries(path, entries) || observed;
  }
  return observed ? entries.join('\n') : null;
}

function normalizeDescriptors(descriptors) {
  const byId = new Map();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    if (!descriptor?.id || !descriptor?.target) continue;
    const paths = (Array.isArray(descriptor.paths) ? descriptor.paths : []).filter(Boolean);
    const existing = byId.get(descriptor.id);
    if (!existing) {
      byId.set(descriptor.id, {
        ...descriptor,
        paths,
        readSignatures: [descriptor.readSignature].filter((reader) => typeof reader === 'function'),
      });
      continue;
    }

    const readers = [
      ...(Array.isArray(existing.readSignatures) ? existing.readSignatures : [existing.readSignature]),
      descriptor.readSignature,
    ].filter((reader) => typeof reader === 'function');
    const mergedPaths = Array.from(new Set([...existing.paths, ...paths]));
    byId.set(descriptor.id, {
      ...existing,
      target: existing.target === 'shared' || descriptor.target === 'shared' ? 'shared' : existing.target,
      paths: mergedPaths,
      readSignatures: readers,
      readSignature: () => readers.length
        ? readers.map((reader) => reader()).join('\n')
        : readDevReloadWatchChangeSignature(mergedPaths),
    });
  }
  return Array.from(byId.values());
}

function readDescriptorSignatures(descriptors) {
  const signatures = new Map();
  for (const descriptor of descriptors) {
    let signature = null;
    try {
      signature = typeof descriptor.readSignature === 'function'
        ? descriptor.readSignature(descriptor)
        : readDevReloadWatchChangeSignature(descriptor.paths);
    } catch (error) {
      signature = `error:${error instanceof Error ? error.message : String(error)}`;
    }
    signatures.set(descriptor.id, signature ?? null);
  }
  return signatures;
}

function serializeDescriptorSignatures(descriptors, signatures) {
  return descriptors.map((descriptor) => `${descriptor.id}\0${signatures.get(descriptor.id) ?? ''}`).join('\n');
}

function createExecutorMap(executors) {
  const map = new Map();
  for (const executor of Array.isArray(executors) ? executors : []) {
    if (executor?.target && !map.has(executor.target)) {
      map.set(executor.target, executor);
    }
  }
  return map;
}

function classifyChangedTargets({ descriptors, previous, next, executorsByTarget }) {
  const targets = new Set();
  const changedDescriptors = [];
  for (const descriptor of descriptors) {
    const before = previous.get(descriptor.id) ?? null;
    const after = next.get(descriptor.id) ?? null;
    if (before === after) continue;
    changedDescriptors.push(descriptor.id);
    if (descriptor.target === 'shared') {
      for (const target of RESTART_ORDER) {
        if (executorsByTarget.has(target)) targets.add(target);
      }
    } else if (executorsByTarget.has(descriptor.target)) {
      targets.add(descriptor.target);
    }
  }
  return { targets: RESTART_ORDER.filter((target) => targets.has(target)), changedDescriptors };
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function startDevReloadCoordinator(
  {
    enabled = true,
    descriptors,
    executors,
    debounceMs = 500,
    pollIntervalMs = 0,
    isShuttingDown,
    logger = console,
  } = {},
  { watchDebouncedImpl = watchDebounced } = {},
) {
  if (!enabled) return null;

  const normalizedDescriptors = normalizeDescriptors(descriptors);
  const executorsByTarget = createExecutorMap(executors);
  if (!normalizedDescriptors.length || !executorsByTarget.size) return null;

  const watchPaths = Array.from(new Set(
    normalizedDescriptors.flatMap((descriptor) => descriptor.paths).filter(Boolean).map((p) => resolve(p)),
  ));
  if (!watchPaths.length) return null;

  let lastSignatures = readDescriptorSignatures(normalizedDescriptors);
  let inFlight = false;
  let pending = false;
  let cycle = 0;

  const runCycle = async () => {
    if (isShuttingDown?.()) return;
    const nextSignatures = readDescriptorSignatures(normalizedDescriptors);
    const { targets, changedDescriptors } = classifyChangedTargets({
      descriptors: normalizedDescriptors,
      previous: lastSignatures,
      next: nextSignatures,
      executorsByTarget,
    });
    if (!targets.length) {
      lastSignatures = nextSignatures;
      return;
    }

    cycle += 1;
    const context = { cycle, targets, changedDescriptors, signatures: nextSignatures };

    try {
      for (const target of targets) {
        if (isShuttingDown?.()) return;
        await executorsByTarget.get(target)?.build?.(context);
      }
    } catch (error) {
      logger.error?.('[local] watch: reload build/preflight failed; keeping existing services running.');
      logger.error?.(formatError(error));
      return;
    }

    for (const target of targets) {
      try {
        if (isShuttingDown?.()) return;
        await executorsByTarget.get(target)?.restart?.(context);
      } catch (error) {
        logger.error?.(`[local] watch: ${target} reload failed; keeping coordinator alive (will retry on next change).`);
        logger.error?.(formatError(error));
        return;
      }
    }

    lastSignatures = nextSignatures;
  };

  const onChange = async () => {
    if (isShuttingDown?.()) return;
    if (inFlight) {
      pending = true;
      return;
    }

    inFlight = true;
    try {
      do {
        pending = false;
        await runCycle();
      } while (pending && !isShuttingDown?.());
    } catch (error) {
      logger.error?.('[local] watch: unexpected reload coordinator error (continuing):');
      logger.error?.(formatError(error));
    } finally {
      inFlight = false;
    }
  };

  return watchDebouncedImpl({
    paths: watchPaths,
    debounceMs,
    onChange,
    pollIntervalMs,
    readSignature: () => serializeDescriptorSignatures(
      normalizedDescriptors,
      readDescriptorSignatures(normalizedDescriptors),
    ),
  });
}
