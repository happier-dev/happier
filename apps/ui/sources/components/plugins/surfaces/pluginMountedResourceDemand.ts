import { retainDeep } from '@/sync/domains/state/structuralSharing';

/** Mounted subjects only. Resource leases, transport, cancellation and refresh remain with the contextual owner. */
export function createPluginMountedResourceDemand<Demand, Value>() {
  const mounted = new Map<string, { count: number; demand: Demand }>();
  const values = new Map<string, Value>();
  const demandListeners = new Set<() => void>();
  const valueListeners = new Map<string, Set<() => void>>();
  let revision = 0;
  const changed = () => { revision++; for (const listener of demandListeners) listener(); };
  return {
    mount(key: string, demand: Demand): () => void {
      const current = mounted.get(key);
      if (current) current.count++;
      else { mounted.set(key, { count: 1, demand }); changed(); }
      return () => {
        const current = mounted.get(key);
        if (!current || --current.count > 0) return;
        mounted.delete(key);
        values.delete(key);
        changed();
      };
    },
    demands: (): IterableIterator<Demand> => Array.from(mounted.values(), row => row.demand).values(),
    getRevision: () => revision,
    subscribeDemand(listener: () => void): () => void {
      demandListeners.add(listener);
      return () => { demandListeners.delete(listener); };
    },
    read: (key: string): Value | null => values.get(key) ?? null,
    publish(key: string, value: Value): void {
      if (!mounted.has(key)) return;
      const previous = values.get(key);
      const next = retainDeep(previous, value);
      if (previous === next) return;
      values.set(key, next);
      for (const listener of valueListeners.get(key) ?? []) listener();
    },
    subscribe(key: string, listener: () => void): () => void {
      let listeners = valueListeners.get(key);
      if (!listeners) { listeners = new Set(); valueListeners.set(key, listeners); }
      listeners.add(listener);
      return () => { listeners.delete(listener); if (listeners.size === 0) valueListeners.delete(key); };
    },
  };
}
