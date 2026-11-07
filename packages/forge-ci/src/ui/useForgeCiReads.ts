import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePluginHostApi, usePluginHostReadiness, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { Disposable, PluginEphemeralSharedValueLease } from '@happier-dev/plugin-sdk';
import type { PluginUiReadAuthorityReference } from '@happier-dev/plugin-sdk/ui';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiAdapterV1 } from '../runtime/adapter.js';
import {
  createForgeCiReadsV1, forgeCiReadQueryKeyV1,
  type ForgeCiReadDemandV1, type ForgeCiReadLeaseV1, type ForgeCiReadOperationV1, type ForgeCiReadsV1,
} from '../runtime/reads.js';

/** The host refused this mount's read authority (no reachable sign-in or Machine); the failure the surfaces show. */
const READ_AUTHORITY_REFUSED: TriageSourceFailureV1 = { class: 'transient', code: 'ci_read_authority_unavailable' };
/** The host settled that this mount's Machine cannot run reads now (offline or not admitted). */
const EXECUTION_UNAVAILABLE: TriageSourceFailureV1 = { class: 'transient', code: 'ci_execution_unavailable' };

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
  // An explicit Retry on a refused mount asks the host for read authority again; nothing retries on its own.
  const [admissionAttempt, setAdmissionAttempt] = useState(0);
  useEffect(() => {
    // The host owns admission and its push-driven re-acquisition edge. Issuing
    // the authority watch while it is pending would settle a premature refusal
    // with no later wake when the same physical mount becomes ready.
    if (readiness.pending || options.signal?.aborted || options.readAuthority === null) { setHeld(null); return; }
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
    const create = (authorityFailure: TriageSourceFailureV1 | null = null) => {
      const reads = createForgeCiReadsV1({ ...options, authorityFailure });
      return { value: reads, dispose: () => reads.retire() };
    };
    const acquire = (refusal: TriageSourceFailureV1 | null = null) => {
      if (observation.signal.aborted) return;
      // A refused mount keeps its own unshared reads: every query settles to the refusal (the surfaces' one failure
      // state) and reads nothing, while an admitted mount of the same scope still shares its reads.
      lease = refusal === null ? scope?.acquireExecutionBound?.(`forge-ci/reads/v1/${options.scopeKey}`, () => create()) ?? null : null;
      if (refusal === null && scope && !lease) { setHeld(null); return; }
      local = lease ? null : create(refusal);
      const reads = lease?.value ?? local!.value;
      const demandForMount = (demand?: ForgeCiReadDemandV1): ForgeCiReadDemandV1 => {
        const signal = options.signal?.aborted ? options.signal : demand?.signal ?? options.signal;
        return { ...demand, adapter: options.adapter, ...(signal === undefined ? {} : { signal }) };
      };
      // The shared controller owns the Demand set. This facade contributes only
      // this physical mount's current transport and existing renderer lifetime.
      function bindLease<T extends Readonly<{ release(): void; refresh(): Promise<void> }>>(admitted: T): T {
        const query = refusal === null ? admitted
          : { ...admitted, refresh: () => { setAdmissionAttempt(attempt => attempt + 1); return Promise.resolve(); } };
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
    // A settled outage (the host says this Machine cannot run reads) is a failure with Retry, never a skeleton; the
    // host's re-admission revision re-runs this effect when the Machine comes back.
    if (readiness.ready === false) acquire(EXECUTION_UNAVAILABLE);
    else if (options.readAuthority) {
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
      }, () => { if (!observation.signal.aborted) acquire(READ_AUTHORITY_REFUSED); });
    } else acquire();
    if (options.signal?.aborted) retire();
    return () => { options.signal?.removeEventListener('abort', retire); release(); };
  }, [host, scope, options.adapter, options.scopeKey, options.signal, options.readAuthority,
    readiness.pending, readiness.ready, readiness.revision, admissionAttempt]);
  return !readiness.pending && held?.readinessRevision === readiness.revision
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
