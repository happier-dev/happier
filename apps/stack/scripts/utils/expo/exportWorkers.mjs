import { SOURCE_WEB_EXPORT_MEMORY } from '../dev_targets/command_resources.mjs';

// One argument policy for Expo and the admission owner that reserves its tree.
// 2026-10-23 nl1 cold Metro exports with the installed serializer correction:
// 47 threads took 199,741 ms at 32,907,788 KiB whole-tree RSS; eight took
// 203,103 ms at 11,940,272 KiB RSS. Eight is within 1.7% of 47's Metro time.
// Four threads with installed upstream Expo55.0.13 took 1,504,725 ms at
// 9,993,744 KiB RSS (zero hits / 20,642 misses). Its serializer/source basis
// differs; it does not qualify for the observed eight/47-thread plateau.
// More default threads add measured memory pressure without useful speedup.
const EXPORT_DEFAULT_THREAD_KNEE = SOURCE_WEB_EXPORT_MEMORY.intermediateThreads;

export function resolveExpoExportWorkers(args, env, { interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  // Expo's scalar argument parser uses the last occurrence.
  const flagIndex = args.findLastIndex(arg => arg === '--max-workers' || (typeof arg === 'string' && arg.startsWith('--max-workers=')));
  if (flagIndex !== -1) {
    const flag = args[flagIndex];
    const raw = flag === '--max-workers' ? args[flagIndex + 1] : flag.slice('--max-workers='.length);
    const value = Number(raw);
    return { explicit: true, workers: Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : null };
  }
  const rawOverride = String(env?.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS ?? '').trim();
  if (rawOverride) {
    const value = Number(rawOverride);
    return { explicit: true, workers: Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : null };
  }
  const rawBudget = String(env?.GOMAXPROCS ?? '').trim();
  const budget = Number(rawBudget);
  return { explicit: false, workers: !interactive && /^\d+$/.test(rawBudget) && Number.isSafeInteger(budget) && budget > 0 ? Math.min(budget, EXPORT_DEFAULT_THREAD_KNEE) : null };
}

export function applyExpoExportMaxWorkersArgs(args, env) {
  const next = Array.isArray(args) ? [...args] : [];
  if (next[0] !== 'export') return next;
  if (next.some(arg => arg === '--max-workers' || (typeof arg === 'string' && arg.startsWith('--max-workers=')))) return next;
  const { workers } = resolveExpoExportWorkers(next, env);
  if (workers !== null) next.push('--max-workers', String(workers));
  return next;
}
