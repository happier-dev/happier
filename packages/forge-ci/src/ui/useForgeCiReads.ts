import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePluginHostApi, usePluginHostReadiness, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { Disposable, PluginEphemeralSharedValueLease } from '@happier-dev/plugin-sdk';
import type { PluginUiReadAuthorityReference } from '@happier-dev/plugin-sdk/ui';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiAdapterV1 } from '../runtime/adapter.js';
import {
  createForgeCiReadsV1, forgeCiReadQueryKeyV1,
  type ForgeCiReadDemandV1, type ForgeCiReadLeaseV1, type ForgeCiReadOperationV1, type ForgeCiReadsV1,
} from '../runtime/reads.js';

/** Acquire host sharing only after commit; a retired scope never gets a fallback. */
export function useForgeCiReadsV1(options: Readonly<{
  adapter: ForgeCiAdapterV1; scopeKey: string; signal?: AbortSignal;
  /** Exact declared read/purpose to admit before retaining credential-scoped facts. Null disables demand. */
  readAuthority?: PluginUiReadAuthorityReference | null;
}>): ForgeCiReadsV1 | null {
  const host = usePluginHostApi();
  const scope = usePluginUiEphemeralSharedScope();
  const readiness = usePluginHostReadiness();
  const [held, setHeld] = useState<Readonly<{ scope: typeof scope; options: typeof options; readinessRevision: number; reads: ForgeCiReadsV1 }> | null>(null);
  useEffect(() => {
    // The host owns admission and its push-driven re-acquisition edge. Issuing
    // the authority watch while it is pending would settle a premature refusal
    // with no later wake when the same physical mount becomes ready.
    if (readiness.pending || readiness.ready === false || options.signal?.aborted || options.readAuthority === null) { setHeld(null); return; }
    const observation = new AbortController();
    let watch: Disposable | undefined;
    let lease: PluginEphemeralSharedValueLease<ForgeCiReadsV1> | null = null;
    let local: Readonly<{ value: ForgeCiReadsV1; dispose(): void }> | null = null;
    const release = () => {
      if (observation.signal.aborted) return;
      observation.abort();
      void watch?.dispose();
      lease?.release(); local?.dispose();
    };
    const retire = () => { release(); setHeld(null); };
    options.signal?.addEventListener('abort', retire, { once: true });
    const create = () => {
      const reads = createForgeCiReadsV1(options);
      return { value: reads, dispose: () => reads.retire() };
    };
    const acquire = () => {
      if (observation.signal.aborted) return;
      lease = scope?.acquireExecutionBound?.(`forge-ci/reads/v1/${options.scopeKey}`, create) ?? null;
      if (scope && !lease) { setHeld(null); return; }
      local = scope ? null : create();
      const reads = lease?.value ?? local!.value;
      const demandForMount = (demand?: ForgeCiReadDemandV1): ForgeCiReadDemandV1 => {
        const signal = options.signal?.aborted ? options.signal : demand?.signal ?? options.signal;
        return { ...demand, adapter: options.adapter, ...(signal === undefined ? {} : { signal }) };
      };
      // The shared controller owns the Demand set. This facade contributes only
      // this physical mount's current transport and existing renderer lifetime.
      function bindLease<T extends Readonly<{ release(): void }>>(query: T): T {
        if (!options.signal) return query;
        const release = () => { options.signal?.removeEventListener('abort', release); query.release(); };
        options.signal.addEventListener('abort', release, { once: true });
        if (options.signal.aborted) release();
        return { ...query, release };
      }
      const bound: ForgeCiReadsV1 = {
        ...reads,
        acquire: (operation, input, demand) => bindLease(reads.acquire(operation, input, demandForMount(demand))),
        acquirePaged: (operation, input, demand) => bindLease(reads.acquirePaged(operation, input, demandForMount(demand))),
        acquireBranchCounts: (input, demand) => bindLease(reads.acquireBranchCounts(input, demandForMount(demand))),
      };
      setHeld({ scope, options, readinessRevision: readiness.revision, reads: bound });
    };
    if (options.readAuthority) {
      void host.watchResource(options.readAuthority, event => {
        if (observation.signal.aborted || event.kind !== 'error') return;
        // Revocation ends this open observation, not finite work already
        // admitted by the Action owner. Later reads admit independently.
        void watch?.dispose();
        watch = undefined;
      }, { signal: observation.signal }).then(subscription => {
        if (observation.signal.aborted) { void subscription.dispose(); return; }
        watch = subscription;
        acquire();
      }, () => { if (!observation.signal.aborted) { release(); setHeld(null); } });
    } else acquire();
    if (options.signal?.aborted) retire();
    return () => { options.signal?.removeEventListener('abort', retire); release(); };
  }, [host, scope, options.adapter, options.scopeKey, options.signal, options.readAuthority,
    readiness.pending, readiness.ready, readiness.revision]);
  return !readiness.pending && readiness.ready !== false && held?.readinessRevision === readiness.revision
    && held.scope === scope && held.options.adapter === options.adapter && held.options.scopeKey === options.scopeKey
    && held.options.signal === options.signal && held.options.readAuthority === options.readAuthority
    && options.signal?.aborted !== true ? held.reads : null;
}

/** A query lease is separate from its semantic and freshness subscriptions. */
export function useForgeCiQueryV1<K extends ForgeCiReadOperationV1>(
  reads: ForgeCiReadsV1 | null,
  operation: K,
  input: ForgeCiActionInputByOperationV1[K] | null,
  enabled = true,
): ForgeCiReadLeaseV1<K> | null {
  const { active } = usePluginSurfaceActivity();
  const key = input === null ? null : forgeCiReadQueryKeyV1(operation, input);
  const [held, setHeld] = useState<Readonly<{ reads: ForgeCiReadsV1; key: string; lease: ForgeCiReadLeaseV1<K> }> | null>(null);
  useEffect(() => {
    if (!reads || input === null || key === null || !enabled) { setHeld(null); return; }
    const lease = reads.acquire(operation, input, { active });
    setHeld({ reads, key, lease });
    return () => { lease.release(); };
  }, [reads, operation, key, enabled]);
  const lease = held?.reads === reads && held.key === key && enabled ? held.lease : null;
  useEffect(() => { lease?.setActive(active); }, [lease, active]);
  return lease;
}

const noSubscription = () => () => {};
const noValue = () => null;

/** Only semantic changes wake rows; explicit Refresh busy state is independent. */
export function useForgeCiQueryValueV1<T>(lease: Readonly<{
  getValue(): T;
  subscribeValue(listener: () => void): () => void;
}> | null): T | null {
  return useSyncExternalStore<T | null>(lease?.subscribeValue ?? noSubscription, lease?.getValue ?? noValue, lease?.getValue ?? noValue);
}

export function useForgeCiQueryStatusV1<K extends ForgeCiReadOperationV1>(lease: ForgeCiReadLeaseV1<K> | null) {
  const snapshot = useSyncExternalStore(lease?.subscribe ?? noSubscription, lease?.getSnapshot ?? noValue, lease?.getSnapshot ?? noValue);
  const refresh = useCallback(() => lease?.refresh() ?? Promise.resolve(), [lease]);
  return { snapshot, refresh };
}
