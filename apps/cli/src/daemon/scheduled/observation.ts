import { isDeepStrictEqual } from 'node:util';
import type { MachineScheduledInputV1, MachineScheduledResultV1 } from '@happier-dev/protocol/machines/scheduled/scheduledV1';
import { createParkWatch } from '@/daemon/lifecycle/parkWatch';
import { readNativeScheduledSources, subscribeNativeScheduledChanges, type ScheduledSource } from './native';

/** One native observation per Machine. Closed views retain facts, never a scan loop. */
export function createScheduledObservation(adapter: Readonly<{
  read(options?: Readonly<{ signal?: AbortSignal }>): Promise<ScheduledSource[]>;
  subscribe(changed: () => void, unavailable: (source: string, reason: string) => void): () => void;
}> = { read: readNativeScheduledSources, subscribe: subscribeNativeScheduledChanges }) {
  type ObservedSource = ScheduledSource & Readonly<{ observation?: Readonly<{ kind: 'unavailable'; reason: string }> }>;
  let sources: ObservedSource[] | undefined;
  let revision = 0;
  let dirty = true;
  let disposed = false;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const unavailable = new Map<string, string>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  const watches = createParkWatch({ onWatcherCountChanged: count => { if (count && dirty) wake(); } });
  function changed() { if (!disposed) { dirty = true; if (watches.watcherCount()) wake(); } }
  function wake() { void refresh().catch(error => {
    sources = [{ source: 'native_observation', kind: 'unavailable', reason: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'native_read_failed' }];
    revision = Math.max(Date.now(), revision + 1);
    for (const listener of listeners) listener();
  }); }
  async function refresh(): Promise<void> {
    if (disposed) return;
    if (pending) return pending;
    if (!dirty) return;
    // Publish the shared read before native attachment can call back synchronously.
    pending = Promise.resolve().then(async () => {
      if (disposed) return;
      do {
        release ??= adapter.subscribe(changed, (source, reason) => { unavailable.set(source, reason); changed(); });
        dirty = false;
        const read = await adapter.read({ signal: lifetime.signal });
        if (disposed) return;
        const next: ObservedSource[] = read.map(source => unavailable.has(source.source)
          && source.kind === 'available' ? { ...source, observation: { kind: 'unavailable' as const, reason: unavailable.get(source.source)! } } : source);
        for (const [source, reason] of unavailable) if (!next.some(item => item.source === source)) next.push({ source, kind: 'unavailable', reason });
        if (!isDeepStrictEqual(sources, next)) {
          sources = next; revision = Math.max(Date.now(), revision + 1);
          for (const listener of listeners) listener();
        }
      } while (dirty && !disposed);
    }).finally(() => { pending = undefined; });
    return pending;
  }
  function page(input: MachineScheduledInputV1): MachineScheduledResultV1 {
    const offset = input.offset ?? 0;
    let seen = 0;
    const end = offset + input.pageSize;
    const projected = (sources ?? []).map(source => {
      if (source.kind === 'unavailable') return source;
      const start = seen; seen += source.jobs.length;
      return { ...source, totalJobs: source.jobs.length, jobs: source.jobs.slice(Math.max(0, offset - start), Math.max(0, end - start)) };
    });
    return { kind: 'snapshot', revision, sources: projected, nextOffset: seen > end ? end : null };
  }
  return {
    async list(input: MachineScheduledInputV1): Promise<MachineScheduledResultV1> {
      if (input.refresh) { release?.(); release = undefined; unavailable.clear(); dirty = true; }
      if (!pending) dirty = true;
      await refresh(); return page(input);
    },
    async watch(input: MachineScheduledInputV1, signal?: AbortSignal): Promise<MachineScheduledResultV1> {
      if (disposed || signal?.aborted) return { kind: 'unchanged' };
      await refresh();
      const result = await watches.parkWatch({ isNewer: () => input.sinceRevision !== revision,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        read: () => page(input), signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
      return result.changed ? result.snapshot : { kind: 'unchanged' };
    },
    dispose() { disposed = true; lifetime.abort(); release?.(); release = undefined; listeners.clear(); },
  };
}
