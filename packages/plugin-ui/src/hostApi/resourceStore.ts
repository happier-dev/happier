import type { Disposable } from '@happier-dev/plugin-sdk';
import type {
  PluginUiHostApi,
  ResourceContent,
  ResourceSubscriptionEvent,
} from '@happier-dev/plugin-sdk/ui';

type PluginDiagnosticData = Parameters<PluginUiHostApi['diagnostic']>[0];

import {
  HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE,
  materializeHappierRenderableImage,
} from '../presentation/content/renderableImage.js';

export type PluginUiResourceReference = Parameters<PluginUiHostApi['readResource']>[0];

/**
 * The smallest client boundary the mounted Resource store needs. Surface host
 * APIs adapt to it at their private edge; contextual consumers bind the same
 * contract directly without manufacturing a Surface identity.
 */
export type PluginUiResourceClient = Readonly<{
  readResource: PluginUiHostApi['readResource'];
  /**
   * Contextual app clients may attach the daemon's admitted digest to the
   * disposable. The public Host API deliberately need not synthesize it.
   */
  watchResource?: (...args: Parameters<PluginUiHostApi['watchResource']>) => Promise<
    Disposable & Readonly<{ admittedDigest?: string }>
  >;
  /**
   * The author-facing diagnostic channel for this mount. A refused renderable
   * image is invisible on every user-facing surface by design, so without this
   * the author of the image has no way to learn that a bound rejected it.
   */
  diagnostic?: PluginUiHostApi['diagnostic'];
}>;

/**
 * Adapt the public Surface host API once at the surface boundary. The store
 * itself deliberately has no knowledge of `version()` or any unrelated host
 * method, so a non-Surface contextual mount uses the same Resource owner.
 *
 * Watch admission is deliberately NOT sampled from `version().methods` here.
 * The mounted host API outlives a daemon reconnect and narrows/re-advertises
 * its daemon-owned methods live, so a method set read once at mount is a
 * snapshot of *current* availability, never a capability fact; caching its
 * negative turns an outage at mount time into a session-long loss of live
 * Resources. Only the member's own absence is structural, and the host decides
 * the rest at each open attempt — `unsupported_method` when it can never serve
 * the subscription, a retryable failure while it merely cannot serve it yet.
 * Both transports refuse an unadvertised method locally, so this costs no
 * round trip.
 */
export function createPluginUiHostApiResourceClient(
  hostApi: PluginUiHostApi,
): PluginUiResourceClient {
  const watchResource = typeof hostApi.watchResource === 'function'
    ? hostApi.watchResource.bind(hostApi)
    : undefined;
  const diagnostic = typeof hostApi.diagnostic === 'function'
    ? hostApi.diagnostic.bind(hostApi)
    : undefined;
  return Object.freeze({
    readResource: hostApi.readResource.bind(hostApi),
    ...(watchResource ? { watchResource } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

export type PluginUiResourceError = Readonly<{
  code?: string;
  /**
   * Host-provided machine-readable detail for a generic public error code.
   * For example, the mounted `unavailable` envelope distinguishes an
   * undeclared Resource from an offline daemon transport here.
   */
  diagnostics?: readonly string[];
  message: string;
}>;

/**
 * The author-facing Resource state. Value, freshness, pending work, error and
 * subscription status are deliberately independent: a refresh failure must not
 * erase an admitted value just to express that it is stale.
 */
export type PluginUiResourceSnapshot = Readonly<{
  value?: ResourceContent;
  digest?: string;
  freshness: 'unknown' | 'fresh' | 'stale';
  pending: 'idle' | 'initial' | 'refresh';
  error?: PluginUiResourceError;
  subscription: 'unsupported' | 'establishing' | 'live' | 'reconnecting' | 'ended';
}>;

/** The artifact-local currentness facade consumed by this mounted Resource store. */
export type PluginUiResourceAccountLifetime = Readonly<{
  isCurrent(): boolean;
  onRetire(cancel: () => void): Disposable;
}>;

export type PluginUiResourceEntry = Readonly<{
  getSnapshot(): PluginUiResourceSnapshot;
  subscribe(listener: () => void, live: boolean): () => void;
  refresh(): void;
}>;

export type PluginUiResourceStore = Readonly<{
  getEntry(resource: PluginUiResourceReference): PluginUiResourceEntry;
  dispose(): void;
}>;

type MutableEntry = {
  readonly key: string;
  readonly resource: PluginUiResourceReference;
  readonly listeners: Set<() => void>;
  snapshot: PluginUiResourceSnapshot;
  subscriberCount: number;
  liveSubscriberCount: number;
  disposed: boolean;
  reading: boolean;
  readQueued: boolean;
  /** Whether every queued wakeup can retain an already-fresh LKG snapshot. */
  readQueuedRetainsFreshSnapshot: boolean;
  /**
   * An establishment digest can satisfy a queued resync when the in-flight
   * baseline read lands on those exact bytes. `null` means a normal refresh
   * must always run. Invalidations deliberately never populate this field:
   * their digest is only a convergence hint, not byte authority.
   */
  readQueuedExpectedDigest: string | null;
  readController: AbortController | null;
  watchController: AbortController | null;
  watch: Disposable | null;
  watchEstablishing: boolean;
  watchUnsupported: boolean;
  /** A terminal protocol/failure arm is not retried for this mount scope. */
  watchFailureTerminal: boolean;
  watchRetryTimer: ReturnType<typeof setTimeout> | null;
  watchRetryAttempts: number;
};

/** Retry only a failed initial open; established-watch recovery stays owner-local in the host adapter. */
const WATCH_OPEN_RETRY_BACKOFF_MS = [250, 1_000, 2_500, 5_000] as const;

/**
 * A bare Resource id is shorthand for the mounted plugin's contribution. Turn
 * it into that exact qualified identity before it reaches the store or host
 * API so alternate public spellings share one entry, read, watch, and
 * last-known-good/currentness owner. Without the mounted plugin identity,
 * preserve a bare id as distinct rather than guessing a cross-plugin alias.
 */
export function normalizePluginUiResourceReference(
  reference: PluginUiResourceReference,
  mountedPluginId: string | null,
): PluginUiResourceReference {
  if (typeof reference === 'string') {
    return mountedPluginId === null
      ? reference
      : Object.freeze({ pluginId: mountedPluginId, localId: reference });
  }
  return reference;
}

export function pluginUiResourceReferenceKey(
  reference: PluginUiResourceReference,
  mountedPluginId: string | null,
): string {
  const normalized = normalizePluginUiResourceReference(reference, mountedPluginId);
  return typeof normalized === 'string'
    ? `bare:${normalized}`
    : `qualified:${normalized.pluginId}\u0000${normalized.localId}`;
}

/** The author-readable name of a Resource; the entry key is a NUL-joined map key. */
function resourceLabel(reference: PluginUiResourceReference): string {
  return typeof reference === 'string'
    ? reference
    : `${reference.pluginId}/${reference.localId}`;
}

function readError(error: unknown): PluginUiResourceError {
  const candidate = error && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; diagnostics?: unknown; message?: unknown }>
    : null;
  // React Native adapters carry the bounded codes directly, while the
  // hosted-web SDK client preserves them in typed `PluginDiagnosticData`
  // objects. Normalize only that stable code in the Resource state so callers
  // can distinguish an undeclared Resource from a transport outage without a
  // second error parser or an adapter-specific branch.
  const diagnostics = Array.isArray(candidate?.diagnostics)
    ? candidate.diagnostics.flatMap((diagnostic) => {
      if (typeof diagnostic === 'string' && diagnostic.trim().length > 0) return [diagnostic];
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return [];
      const code = (diagnostic as Readonly<{ code?: unknown }>).code;
      return typeof code === 'string' && code.trim().length > 0 ? [code] : [];
    })
    : [];
  return Object.freeze({
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(diagnostics.length > 0 ? { diagnostics: Object.freeze(diagnostics) } : {}),
    message: typeof candidate?.message === 'string'
      ? candidate.message
      : 'Plugin UI resource is unavailable.',
  });
}

function classifyWatchOpenFailure(error: unknown): Readonly<{
  unsupported: boolean;
  retryable: boolean;
}> {
  const candidate = error && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; retryable?: unknown }>
    : null;
  const code = candidate?.code;
  const unsupported = code === 'unsupported_method'
    || code === 'unsupported_host_method'
    || code === 'plugin_ui_method_unavailable'
    || code === 'plugin_resource_transport_not_supported';
  return {
    unsupported,
    retryable: candidate?.retryable === false ? false : !unsupported,
  };
}

function sameError(
  left: PluginUiResourceError | undefined,
  right: PluginUiResourceError | undefined,
): boolean {
  return left === right || (
    left?.code === right?.code
    && left?.message === right?.message
    && left?.diagnostics?.length === right?.diagnostics?.length
    && left?.diagnostics?.every((diagnostic, index) => diagnostic === right?.diagnostics?.[index]) !== false
  );
}

function sameSnapshot(left: PluginUiResourceSnapshot, right: PluginUiResourceSnapshot): boolean {
  return left.value === right.value
    && left.digest === right.digest
    && left.freshness === right.freshness
    && left.pending === right.pending
    && left.subscription === right.subscription
    && sameError(left.error, right.error);
}

function initialSnapshot(): PluginUiResourceSnapshot {
  return Object.freeze({
    freshness: 'unknown' as const,
    pending: 'initial' as const,
    subscription: 'unsupported' as const,
  });
}

/**
 * Create the one Resource state owner for one mounted client. `client` is
 * intentionally retained by identity, not copied into an author-visible key;
 * a replacement controller cannot publish into the prior mount's store.
 */
export function createPluginUiResourceStore(input: Readonly<{
  client: PluginUiResourceClient;
  accountLifetime?: PluginUiResourceAccountLifetime | null;
  pluginId?: string;
}>): PluginUiResourceStore {
  const accountLifetime = input.accountLifetime ?? null;
  const pluginId = input.pluginId ?? null;
  const entries = new Map<string, MutableEntry>();
  let disposed = false;
  let accountRetirement: Readonly<{ dispose(): void }> | undefined;

  const isStoreCurrent = (): boolean => !disposed && (accountLifetime?.isCurrent() ?? true);
  const isEntryCurrent = (entry: MutableEntry): boolean => !entry.disposed && isStoreCurrent();

  /** Fire-and-forget: a diagnostic sink must never fail a Resource read. */
  function reportDiagnostic(data: PluginDiagnosticData): void {
    try {
      input.client.diagnostic?.(data);
    } catch {
      // The mounted host owns delivery; a sink failure cannot change the
      // Resource state this read just resolved.
    }
  }

  function publish(entry: MutableEntry, next: PluginUiResourceSnapshot): void {
    if (sameSnapshot(entry.snapshot, next)) return;
    entry.snapshot = Object.freeze(next);
    for (const listener of [...entry.listeners]) listener();
  }

  function snapshotForPending(entry: MutableEntry, pending: 'initial' | 'refresh'): PluginUiResourceSnapshot {
    const previous = entry.snapshot;
    const hasValue = previous.value !== undefined;
    return {
      ...(hasValue ? { value: previous.value, digest: previous.digest } : {}),
      freshness: hasValue ? 'stale' : 'unknown',
      pending,
      subscription: previous.subscription,
    };
  }

  function clearWatchRetry(entry: MutableEntry): void {
    if (entry.watchRetryTimer !== null) {
      clearTimeout(entry.watchRetryTimer);
      entry.watchRetryTimer = null;
    }
    entry.watchRetryAttempts = 0;
  }

  function stopWatch(entry: MutableEntry, terminal: boolean): void {
    const hadWatchLifecycle = entry.watch !== null
      || entry.watchEstablishing
      || entry.watchRetryTimer !== null;
    clearWatchRetry(entry);
    entry.watchController?.abort();
    entry.watchController = null;
    const watch = entry.watch;
    entry.watch = null;
    entry.watchEstablishing = false;
    try {
      watch?.dispose();
    } catch {
      // The mounted host owns transport cleanup; a local failure cannot retain
      // a stale entry or prevent Account retirement.
    }
    // `unsupported` is a capability fact, not a watch lifecycle phase. A
    // zero-consumer pause must not rewrite it as `ended`, because a later
    // subscriber still has a useful read-through snapshot source.
    if (terminal && hadWatchLifecycle && !entry.disposed && !entry.watchUnsupported) {
      publish(entry, { ...entry.snapshot, subscription: 'ended' });
    }
  }

  function disposeEntry(entry: MutableEntry, clearValue: boolean): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.readController?.abort();
    entry.readController = null;
    stopWatch(entry, false);
    if (clearValue) {
      publish(entry, Object.freeze({
        freshness: 'unknown',
        pending: 'idle',
        subscription: 'ended',
      }));
    }
    entries.delete(entry.key);
  }

  function deactivateEntry(entry: MutableEntry): void {
    if (entry.disposed) return;
    entry.readController?.abort();
    entry.readController = null;
    entry.reading = false;
    entry.readQueued = false;
    entry.readQueuedRetainsFreshSnapshot = false;
    entry.readQueuedExpectedDigest = null;
    stopWatch(entry, true);
  }

  function requestRead(
    entry: MutableEntry,
    requestedPending: 'initial' | 'refresh',
    options?: Readonly<{
      retainFreshSnapshot?: boolean;
      /** An establishment digest that can satisfy this queued baseline resync. */
      expectedDigest?: string;
    }>,
  ): void {
    if (!isEntryCurrent(entry)) return;
    const retainsFreshSnapshot = options?.retainFreshSnapshot === true
      && entry.snapshot.value !== undefined
      && entry.snapshot.freshness === 'fresh'
      && entry.snapshot.pending === 'idle';
    if (entry.reading) {
      const expectedDigest = options?.expectedDigest ?? null;
      if (entry.readQueued) {
        // A normal refresh and every invalidation must win over an
        // establishment-only digest optimization.
        entry.readQueuedRetainsFreshSnapshot = entry.readQueuedRetainsFreshSnapshot && retainsFreshSnapshot;
        // Only an establishment digest proves a baseline read crossed the
        // watch-open boundary. A caller refresh and every invalidation remain
        // unconditional canonical reads, even when their digest matches LKG.
        if (entry.readQueuedExpectedDigest !== null) {
          entry.readQueuedExpectedDigest = expectedDigest;
        }
      } else {
        entry.readQueuedRetainsFreshSnapshot = retainsFreshSnapshot;
        entry.readQueuedExpectedDigest = expectedDigest;
      }
      entry.readQueued = true;
      return;
    }
    entry.reading = true;
    if (!retainsFreshSnapshot) {
      publish(entry, snapshotForPending(entry, requestedPending));
    }
    const controller = new AbortController();
    entry.readController = controller;
    void input.client.readResource(entry.resource, { signal: controller.signal }).then(
      (value) => {
        if (!isEntryCurrent(entry) || controller.signal.aborted) return;
        const previous = entry.snapshot;
        // A new Uint8Array with the same canonical digest is not a semantic
        // Resource update. Preserve the LKG reference and avoid a rerender.
        const unchanged = previous.digest === value.digest && previous.value !== undefined;
        // Admission, not render, is where a renderable image becomes a platform
        // source. Encoding is linear in the byte length and the Resource
        // ceiling is 16 MiB, so a render that derived it would block the UI for
        // seconds. This resolution is already off the render path, and the
        // image owner alone decides the renderable type and the product size
        // and decode ceilings.
        if (!unchanged && value.contentType === HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE) {
          const admission = materializeHappierRenderableImage(value.bytes);
          if (!admission.admitted) {
            // A refused image is indistinguishable from an absent one on every
            // user-facing surface, so the only place an author can learn about
            // it is their own diagnostic channel. The owner decided the code,
            // severity and numbers; this adds the Resource identity, which is
            // the one fact only this entry knows.
            reportDiagnostic({
              ...admission.refusal,
              details: { ...admission.refusal.details, resource: resourceLabel(entry.resource) },
            });
          }
        }
        publish(entry, {
          value: unchanged ? previous.value : value,
          digest: value.digest,
          freshness: 'fresh',
          pending: 'idle',
          subscription: previous.subscription,
        });
      },
      (error) => {
        if (!isEntryCurrent(entry) || controller.signal.aborted) return;
        const previous = entry.snapshot;
        const hasValue = previous.value !== undefined;
        publish(entry, {
          ...(hasValue ? { value: previous.value, digest: previous.digest } : {}),
          freshness: hasValue ? 'stale' : 'unknown',
          pending: 'idle',
          error: readError(error),
          subscription: previous.subscription,
        });
      },
    ).finally(() => {
      if (entry.readController !== controller) return;
      entry.readController = null;
      entry.reading = false;
      if (!isEntryCurrent(entry) || !entry.readQueued) return;
      const queuedRetainsFreshSnapshot = entry.readQueuedRetainsFreshSnapshot;
      const queuedExpectedDigest = entry.readQueuedExpectedDigest;
      entry.readQueued = false;
      entry.readQueuedRetainsFreshSnapshot = false;
      entry.readQueuedExpectedDigest = null;
      // A contextual watch establishment gives us a real admission digest. If
      // this in-flight canonical read already returned those bytes, its
      // resync has happened without another transport round-trip. An
      // invalidation never reaches this branch with a digest because its
      // digest cannot prove current bytes.
      if (
        queuedExpectedDigest !== null
        && entry.snapshot.freshness === 'fresh'
        && entry.snapshot.digest === queuedExpectedDigest
      ) {
        return;
      }
      requestRead(
        entry,
        entry.snapshot.value === undefined ? 'initial' : 'refresh',
        queuedRetainsFreshSnapshot ? { retainFreshSnapshot: true } : undefined,
      );
    });
  }

  function receiveWatchEvent(entry: MutableEntry, event: ResourceSubscriptionEvent): void {
    if (!isEntryCurrent(entry)) return;
    if (event.kind === 'invalidated') {
      const retainsFreshSnapshot = (
        entry.snapshot.digest === event.digest
        && entry.snapshot.freshness === 'fresh'
        && entry.snapshot.pending === 'idle'
      );
      // An invalidation digest is only a convergence hint: it can be stale
      // relative to the canonical Resource bytes. Always reread. When the
      // hint matches an already-fresh snapshot, retain that presentation until
      // the read proves a semantic change, avoiding a stale/pending flash for
      // a genuinely duplicate wakeup.
      requestRead(
        entry,
        entry.snapshot.value === undefined ? 'initial' : 'refresh',
        {
          ...(retainsFreshSnapshot ? { retainFreshSnapshot: true } : {}),
        },
      );
      return;
    }
    const previous = entry.snapshot;
    const hasValue = previous.value !== undefined;
    entry.watchFailureTerminal = true;
    stopWatch(entry, false);
    if (event.kind === 'complete') {
      // `complete` is a graceful protocol arm, not a Resource failure. Keep
      // the already-admitted snapshot truthful and let the mount lifetime own
      // its eventual retirement.
      publish(entry, {
        ...(hasValue ? { value: previous.value, digest: previous.digest } : {}),
        freshness: previous.freshness,
        pending: 'idle',
        subscription: 'ended',
      });
      return;
    }
    publish(entry, {
      ...(hasValue ? { value: previous.value, digest: previous.digest } : {}),
      freshness: hasValue ? 'stale' : 'unknown',
      pending: 'idle',
      error: Object.freeze({
        ...(event.kind === 'error' ? { code: event.code } : {}),
        ...(event.kind === 'error' && event.diagnostics.length > 0
          ? { diagnostics: Object.freeze([...event.diagnostics]) }
          : {}),
        message: event.diagnostics.join(', ') || 'Plugin UI resource watch ended.',
      }),
      subscription: 'ended',
    });
  }

  function scheduleWatchOpenRetry(entry: MutableEntry): void {
    if (
      !isEntryCurrent(entry)
      || entry.liveSubscriberCount === 0
      || entry.watch !== null
      || entry.watchEstablishing
      || entry.watchUnsupported
      || entry.watchFailureTerminal
      || entry.watchRetryTimer !== null
    ) {
      return;
    }
    const delayMs = WATCH_OPEN_RETRY_BACKOFF_MS[
      Math.min(entry.watchRetryAttempts, WATCH_OPEN_RETRY_BACKOFF_MS.length - 1)
    ]!;
    entry.watchRetryAttempts += 1;
    entry.watchRetryTimer = setTimeout(() => {
      entry.watchRetryTimer = null;
      if (!isEntryCurrent(entry) || entry.liveSubscriberCount === 0) return;
      startWatch(entry);
    }, delayMs);
  }

  function startWatch(entry: MutableEntry): void {
    if (
      !isEntryCurrent(entry)
      || entry.liveSubscriberCount === 0
      || entry.watch
      || entry.watchEstablishing
      || entry.watchRetryTimer !== null
    ) return;
    if (entry.watchUnsupported || entry.watchFailureTerminal) return;
    const watchResource = input.client.watchResource;
    if (!watchResource) {
      entry.watchUnsupported = true;
      publish(entry, { ...entry.snapshot, subscription: 'unsupported' });
      return;
    }
    entry.watchEstablishing = true;
    publish(entry, { ...entry.snapshot, subscription: 'establishing' });
    const controller = new AbortController();
    entry.watchController = controller;
    void watchResource(
      entry.resource,
      (event) => { receiveWatchEvent(entry, event); },
      { signal: controller.signal },
    ).then(
      (watch) => {
        if (!isEntryCurrent(entry) || controller.signal.aborted || entry.liveSubscriberCount === 0) {
          try {
            watch.dispose();
          } catch {
            // A late establishment cannot make the retired store current.
          }
          return;
        }
        clearWatchRetry(entry);
        entry.watch = watch;
        entry.watchController = null;
        entry.watchEstablishing = false;
        publish(entry, { ...entry.snapshot, subscription: 'live' });
        // Establishment is a level-triggered resync boundary. Re-read current
        // bytes through the canonical authority. A contextual adapter carries
        // the admitted daemon digest, so an already-fresh matching snapshot
        // needs no duplicate read; generic Host APIs retain the unconditional
        // re-sync because they do not expose that fact.
        const snapshotAlreadyMatchesAdmission = !entry.reading
          && watch.admittedDigest !== undefined
          && entry.snapshot.freshness === 'fresh'
          && entry.snapshot.digest === watch.admittedDigest;
        if (!snapshotAlreadyMatchesAdmission) {
          requestRead(
            entry,
            entry.snapshot.value === undefined ? 'initial' : 'refresh',
            watch.admittedDigest === undefined ? undefined : { expectedDigest: watch.admittedDigest },
          );
        }
      },
      (error) => {
        if (!isEntryCurrent(entry) || controller.signal.aborted) return;
        entry.watchController = null;
        entry.watchEstablishing = false;
        const failure = classifyWatchOpenFailure(error);
        entry.watchUnsupported = failure.unsupported;
        entry.watchFailureTerminal = !failure.unsupported && !failure.retryable;
        const previous = entry.snapshot;
        const hasValue = previous.value !== undefined;
        publish(entry, {
          ...(hasValue ? { value: previous.value, digest: previous.digest } : {}),
          freshness: hasValue ? 'stale' : 'unknown',
          pending: previous.pending,
          ...(failure.unsupported ? {} : { error: readError(error) }),
          subscription: failure.unsupported
            ? 'unsupported'
            : failure.retryable
              ? 'reconnecting'
              : 'ended',
        });
        // The mount started its canonical read independently of watch
        // admission. Do not queue a second read merely because opening the
        // invalidation channel failed: if that baseline is still pending it
        // remains current, and if it has settled it is already authoritative.
        if (failure.unsupported || !failure.retryable) return;
        // A transient live transport failure never makes Resource bytes
        // unavailable. Keep one LKG owner, refresh it canonically, and retry
        // only the failed initial open at a bounded rate.
        scheduleWatchOpenRetry(entry);
      },
    );
  }

  function createEntry(resource: PluginUiResourceReference): MutableEntry {
    const canonicalResource = normalizePluginUiResourceReference(resource, pluginId);
    return {
      key: pluginUiResourceReferenceKey(canonicalResource, pluginId),
      resource: canonicalResource,
      listeners: new Set(),
      snapshot: initialSnapshot(),
      subscriberCount: 0,
      liveSubscriberCount: 0,
      disposed: false,
      reading: false,
      readQueued: false,
      readQueuedRetainsFreshSnapshot: false,
      readQueuedExpectedDigest: null,
      readController: null,
      watchController: null,
      watch: null,
      watchEstablishing: false,
      watchUnsupported: false,
      watchFailureTerminal: false,
      watchRetryTimer: null,
      watchRetryAttempts: 0,
    };
  }

  const store = Object.freeze({
    getEntry(resource: PluginUiResourceReference): PluginUiResourceEntry {
      const canonicalResource = normalizePluginUiResourceReference(resource, pluginId);
      const key = pluginUiResourceReferenceKey(canonicalResource, pluginId);
      let entry = entries.get(key);
      if (!entry) {
        entry = createEntry(canonicalResource);
        entries.set(key, entry);
      }
      return Object.freeze({
        getSnapshot: () => entry!.snapshot,
        subscribe(listener: () => void, live: boolean): () => void {
          if (!isEntryCurrent(entry!)) return () => {};
          const wasUnsubscribed = entry!.subscriberCount === 0;
          const hadNoLiveSubscribers = entry!.liveSubscriberCount === 0;
          entry!.listeners.add(listener);
          entry!.subscriberCount += 1;
          if (live) entry!.liveSubscriberCount += 1;
          if (wasUnsubscribed) {
            if (live) {
              // A live watch supplies invalidations, not the authoritative
              // snapshot. Start it before the baseline read so it cannot
              // miss a concurrent invalidation, but do not let a pending
              // admission suppress the mounted Resource's current bytes.
              if (!entry!.watchUnsupported && !entry!.watchFailureTerminal) {
                startWatch(entry!);
              }
              // A paused exact store retains its capability/terminal fact,
              // but a remount is still a new read-through observation. The
              // snapshot owner starts this read; watch admission never becomes
              // a competing route to Resource bytes.
              requestRead(entry!, entry!.snapshot.value === undefined ? 'initial' : 'refresh');
            } else {
              requestRead(entry!, entry!.snapshot.value === undefined ? 'initial' : 'refresh');
            }
          } else if (live && hadNoLiveSubscribers) {
            startWatch(entry!);
            // A static subscriber can keep the entry alive indefinitely. Its
            // old snapshot is not a live-admission baseline, so promote the
            // first live subscriber through the same canonical read path.
            requestRead(entry!, entry!.snapshot.value === undefined ? 'initial' : 'refresh');
          }
          let unsubscribed = false;
          return () => {
            if (unsubscribed) return;
            unsubscribed = true;
            entry!.listeners.delete(listener);
            entry!.subscriberCount -= 1;
            if (live) entry!.liveSubscriberCount -= 1;
            if (entry!.subscriberCount === 0) {
              // React may replace a useSyncExternalStore subscription without
              // recomputing the memoized entry wrapper (for example when a
              // hook switches from snapshot to live mode). Keep that wrapper
              // valid for this provider lifetime while stopping all
              // unobserved work.
              deactivateEntry(entry!);
            } else if (entry!.liveSubscriberCount === 0) {
              stopWatch(entry!, true);
            }
          };
        },
        refresh(): void {
          requestRead(entry!, entry!.snapshot.value === undefined ? 'initial' : 'refresh');
        },
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries.values()]) disposeEntry(entry, true);
      accountRetirement?.dispose();
    },
  } satisfies PluginUiResourceStore);

  accountRetirement = accountLifetime?.onRetire(() => { store.dispose(); });
  return store;
}
