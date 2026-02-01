import { runWithConcurrencyLimit } from '../proc/parallel.mjs';

/**
 * Run a list of "slice jobs" with:
 * - a mandatory sequential first job (preflight)
 * - parallel execution for the remainder (bounded by `limit`)
 * - stable, input-order results
 * - optional early-abort after the first job (e.g. auth/credits missing)
 */
export async function runSlicedJobs({ items, limit = 1, run, shouldAbortEarly } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  if (typeof run !== 'function') throw new Error('[review] runSlicedJobs: missing run()');

  const concurrency = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;

  const out = [];
  // Always run the first item sequentially so we can fail fast on auth/credits problems
  // before spinning up many long-running review jobs.
  // eslint-disable-next-line no-await-in-loop
  const firstRes = await run(list[0]);
  out.push(firstRes);
  if (typeof shouldAbortEarly === 'function' && shouldAbortEarly(firstRes)) {
    return out;
  }

  if (list.length === 1) return out;

  const rest = list.slice(1);
  const restRes = await runWithConcurrencyLimit({
    items: rest,
    limit: concurrency,
    fn: async (item) => await run(item),
  });

  // Preserve input order.
  return [...out, ...restRes];
}

