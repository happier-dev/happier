export type VoiceAudioSessionMode = 'dictation' | 'conversation' | 'playback';
export type VoiceAudioSessionAec = 'required' | 'preferred' | 'off';
export type VoiceAudioCaptureOwnership = 'host_managed' | 'provider_managed_exclusive';

export type VoiceAudioSessionRequest = Readonly<{
  ownerId: string;
  mode: VoiceAudioSessionMode;
  input: boolean;
  output: boolean;
  aec: VoiceAudioSessionAec;
  capture: VoiceAudioCaptureOwnership;
}>;

export type VoiceAudioSessionConfiguration = Readonly<{
  mode: VoiceAudioSessionMode;
  input: boolean;
  output: boolean;
  aec: VoiceAudioSessionAec;
  capture: VoiceAudioCaptureOwnership;
}>;

export type VoiceAudioSessionCapabilities = Readonly<{
  aecAvailable: boolean;
  aecActive: boolean;
  route: string | null;
}>;

export type VoiceAudioSessionApplyRequest = Readonly<{
  generation: number;
  configuration: VoiceAudioSessionConfiguration;
}>;

export type VoiceAudioSessionApplyResult = Readonly<{
  generation: number;
  aecAvailable: boolean;
  aecActive: boolean;
  route: string | null;
}>;

export type VoiceAudioSessionPlatformEvent =
  | Readonly<{ generation: number; kind: 'interruption_began' }>
  | Readonly<{ generation: number; kind: 'interruption_ended'; shouldResume: boolean }>
  | Readonly<{ generation: number; kind: 'focus_changed'; state: 'gained' | 'lost_transient' | 'lost_permanent' }>
  | Readonly<{ generation: number; kind: 'route_changed'; route: string }>
  | Readonly<{ generation: number; kind: 'lifecycle_changed'; state: 'foreground' | 'background' }>
  | Readonly<{ generation: number; kind: 'capabilities_changed'; aecAvailable: boolean; aecActive: boolean }>
  | Readonly<{ generation: number; kind: 'restoration_completed' }>
  | Readonly<{ generation: number; kind: 'restoration_failed'; reason: string }>;

export type VoiceAudioSessionPlatform = Readonly<{
  apply: (request: VoiceAudioSessionApplyRequest) => Promise<VoiceAudioSessionApplyResult>;
  restore: (request: Readonly<{ generation: number }>) => Promise<void>;
  subscribe?: (
    listener: (event: VoiceAudioSessionPlatformEvent) => void,
  ) => Readonly<{ remove: () => void }>;
}>;

export type VoiceAudioSessionLease = Readonly<{
  id: string;
  capabilities: VoiceAudioSessionCapabilities;
  release: () => Promise<void>;
}>;

export type VoiceAudioSessionSnapshot = Readonly<{
  generation: number;
  leaseCount: number;
  /**
   * Releases whose platform restoration failed. They remain coordinator-owned
   * and are retried with bounded backoff and before a subsequent acquisition.
   */
  pendingReleaseCount: number;
  configuration: VoiceAudioSessionConfiguration | null;
  capabilities: VoiceAudioSessionCapabilities | null;
}>;

export type VoiceAudioSessionCoordinator = Readonly<{
  acquire: (request: VoiceAudioSessionRequest) => Promise<VoiceAudioSessionLease>;
  subscribe: (
    listener: (event: VoiceAudioSessionPlatformEvent) => void,
  ) => Readonly<{ remove: () => void }>;
  getSnapshot: () => VoiceAudioSessionSnapshot;
  dispose: () => Promise<void>;
}>;

export class VoiceAudioSessionCoordinatorError extends Error {
  readonly code: 'invalid_request' | 'exclusive_capture_conflict' | 'aec_required_unavailable';

  constructor(code: VoiceAudioSessionCoordinatorError['code'], message: string) {
    super(message);
    this.name = 'VoiceAudioSessionCoordinatorError';
    this.code = code;
  }
}

type ActiveLease = Readonly<{
  id: string;
  request: VoiceAudioSessionRequest;
}>;

const MODE_PRIORITY: Readonly<Record<VoiceAudioSessionMode, number>> = {
  playback: 0,
  dictation: 1,
  conversation: 2,
};

const AEC_PRIORITY: Readonly<Record<VoiceAudioSessionAec, number>> = {
  off: 0,
  preferred: 1,
  required: 2,
};

const RELEASE_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

function validateRequest(request: VoiceAudioSessionRequest): void {
  if (request.ownerId.trim().length === 0 || (!request.input && !request.output)) {
    throw new VoiceAudioSessionCoordinatorError(
      'invalid_request',
      'A voice audio session request requires an owner and at least one input/output direction.',
    );
  }
}

function assertCaptureCompatibility(
  leases: ReadonlyMap<string, ActiveLease>,
  next: VoiceAudioSessionRequest,
): void {
  const hasExclusive = [...leases.values()].some(
    (lease) => lease.request.capture === 'provider_managed_exclusive',
  );
  if (
    (next.capture === 'provider_managed_exclusive' && leases.size > 0)
    || (next.capture !== 'provider_managed_exclusive' && hasExclusive)
  ) {
    throw new VoiceAudioSessionCoordinatorError(
      'exclusive_capture_conflict',
      'Provider-managed exclusive capture cannot overlap another native audio lease.',
    );
  }
}

function mergeRequests(leases: ReadonlyMap<string, ActiveLease>): VoiceAudioSessionConfiguration | null {
  if (leases.size === 0) return null;
  const requests = [...leases.values()].map((lease) => lease.request);
  const mode = requests.reduce<VoiceAudioSessionMode>(
    (current, request) => MODE_PRIORITY[request.mode] > MODE_PRIORITY[current] ? request.mode : current,
    'playback',
  );
  const aec = requests.reduce<VoiceAudioSessionAec>(
    (current, request) => AEC_PRIORITY[request.aec] > AEC_PRIORITY[current] ? request.aec : current,
    'off',
  );
  return {
    mode,
    input: requests.some((request) => request.input),
    output: requests.some((request) => request.output),
    aec,
    capture: requests.some((request) => request.capture === 'provider_managed_exclusive')
      ? 'provider_managed_exclusive'
      : 'host_managed',
  };
}

export function createVoiceAudioSessionCoordinator(options: Readonly<{
  platform: VoiceAudioSessionPlatform;
  createLeaseId?: () => string;
}>): VoiceAudioSessionCoordinator {
  const leases = new Map<string, ActiveLease>();
  const listeners = new Set<(event: VoiceAudioSessionPlatformEvent) => void>();
  let generation = 0;
  let configuration: VoiceAudioSessionConfiguration | null = null;
  let capabilities: VoiceAudioSessionCapabilities | null = null;
  let leaseSequence = 0;
  let disposalRequested = false;
  let disposed = false;
  let platformSubscriptionRemoved = false;
  let mutationTail: Promise<void> = Promise.resolve();
  const pendingReleaseIds = new Set<string>();
  const pendingReleaseRetries = new Map<string, number>();
  const pendingReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const platformSubscription = options.platform.subscribe?.((event) => {
    if (disposalRequested || event.generation !== generation) return;
    if (
      leases.size === 0
      && event.kind !== 'restoration_completed'
      && event.kind !== 'restoration_failed'
    ) return;
    if (event.kind === 'capabilities_changed') {
      capabilities = {
        aecAvailable: event.aecAvailable,
        aecActive: event.aecActive,
        route: capabilities?.route ?? null,
      };
    } else if (event.kind === 'route_changed' && capabilities) {
      capabilities = { ...capabilities, route: event.route };
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Native lifecycle delivery is a shared boundary. One broken observer
        // must not prevent the remaining owners from receiving the event.
      }
    }
  }) ?? null;

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    mutationTail = mutationTail
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await operation());
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  };

  const applyCurrent = async (): Promise<VoiceAudioSessionCapabilities | null> => {
    generation += 1;
    const targetGeneration = generation;
    const target = mergeRequests(leases);
    if (!target) {
      await options.platform.restore({ generation: targetGeneration });
      configuration = null;
      capabilities = null;
      return null;
    }
    const applied = await options.platform.apply({ generation: targetGeneration, configuration: target });
    if (applied.generation !== targetGeneration) {
      throw new Error('voice_audio_session_generation_mismatch');
    }
    if (target.aec === 'required' && (!applied.aecAvailable || !applied.aecActive)) {
      throw new VoiceAudioSessionCoordinatorError(
        'aec_required_unavailable',
        'Echo cancellation is required but unavailable for this native audio route.',
      );
    }
    configuration = target;
    capabilities = {
      aecAvailable: applied.aecAvailable,
      aecActive: applied.aecActive,
      route: applied.route,
    };
    return capabilities;
  };

  const clearPendingRelease = (id: string): void => {
    pendingReleaseIds.delete(id);
    pendingReleaseRetries.delete(id);
    const timer = pendingReleaseTimers.get(id);
    if (timer) clearTimeout(timer);
    pendingReleaseTimers.delete(id);
  };

  const releaseActiveLease = async (id: string): Promise<void> => {
    const current = leases.get(id);
    if (!current) {
      clearPendingRelease(id);
      return;
    }
    leases.delete(id);
    try {
      await applyCurrent();
      clearPendingRelease(id);
    } catch (error) {
      // A rejected transition did not release the platform resource. Restore
      // the logical lease before the caller observes the error; the coordinator
      // keeps retry ownership even if that caller has already gone away.
      leases.set(id, current);
      try {
        await applyCurrent();
      } catch {
        // Preserve the release failure that triggered rollback.
      }
      throw error;
    }
  };

  const schedulePendingReleaseRetry = (id: string): void => {
    if (disposalRequested || !pendingReleaseIds.has(id) || pendingReleaseTimers.has(id)) return;
    const retryIndex = pendingReleaseRetries.get(id) ?? 0;
    const delay = RELEASE_RETRY_DELAYS_MS[retryIndex];
    if (delay === undefined) return;
    pendingReleaseRetries.set(id, retryIndex + 1);
    const timer = setTimeout(() => {
      pendingReleaseTimers.delete(id);
      void serialize(async () => {
        if (disposalRequested || !pendingReleaseIds.has(id)) return;
        try {
          await releaseActiveLease(id);
        } catch {
          // The failed release remains visible in the snapshot and will retry
          // again on bounded backoff or synchronously before the next acquire.
          schedulePendingReleaseRetry(id);
        }
      });
    }, delay);
    pendingReleaseTimers.set(id, timer);
  };

  const retainFailedRelease = (id: string): void => {
    pendingReleaseIds.add(id);
    schedulePendingReleaseRetry(id);
  };

  const retryPendingReleasesBeforeAcquire = async (): Promise<void> => {
    for (const id of [...pendingReleaseIds]) {
      try {
        await releaseActiveLease(id);
      } catch (error) {
        retainFailedRelease(id);
        throw error;
      }
    }
  };

  const acquire = async (request: VoiceAudioSessionRequest): Promise<VoiceAudioSessionLease> => {
    validateRequest(request);
    return serialize(async () => {
      if (disposalRequested) throw new Error('voice_audio_session_coordinator_disposed');
      // A failed release keeps its logical lease deliberately. Retrying here
      // prevents a finished playback caller from indefinitely blocking a later
      // exclusive capture request after its lease object became unreachable.
      await retryPendingReleasesBeforeAcquire();
      assertCaptureCompatibility(leases, request);
      const id = options.createLeaseId?.() ?? `voice-audio-${++leaseSequence}`;
      const active: ActiveLease = { id, request: { ...request, ownerId: request.ownerId.trim() } };
      leases.set(id, active);
      let applied: VoiceAudioSessionCapabilities;
      try {
        const next = await applyCurrent();
        if (!next) throw new Error('voice_audio_session_apply_missing');
        applied = next;
      } catch (error) {
        leases.delete(id);
        try {
          await applyCurrent();
        } catch {
          // Preserve the original acquisition failure. The platform boundary emits
          // restoration_failed when recovery itself cannot restore a known state.
        }
        throw error;
      }

      let releaseAttempt: Promise<void> | null = null;
      return {
        id,
        capabilities: applied,
        release: async () => {
          if (releaseAttempt) return releaseAttempt;
          const attempt = serialize(async () => {
            try {
              await releaseActiveLease(id);
            } catch (error) {
              retainFailedRelease(id);
              throw error;
            }
          });
          releaseAttempt = attempt;
          try {
            await attempt;
          } catch (error) {
            releaseAttempt = null;
            throw error;
          }
        },
      };
    });
  };

  return {
    acquire,
    subscribe: (listener) => {
      if (disposalRequested) return { remove: () => undefined };
      listeners.add(listener);
      return { remove: () => { listeners.delete(listener); } };
    },
    getSnapshot: () => ({
      generation,
      leaseCount: leases.size,
      pendingReleaseCount: pendingReleaseIds.size,
      configuration,
      capabilities,
    }),
    dispose: async () => {
      await serialize(async () => {
        if (disposed) return;
        disposalRequested = true;
        for (const timer of pendingReleaseTimers.values()) clearTimeout(timer);
        pendingReleaseTimers.clear();
        pendingReleaseIds.clear();
        pendingReleaseRetries.clear();
        leases.clear();
        try {
          await applyCurrent();
          disposed = true;
        } finally {
          if (!platformSubscriptionRemoved) {
            platformSubscriptionRemoved = true;
            platformSubscription?.remove();
          }
          listeners.clear();
        }
      });
    },
  };
}
