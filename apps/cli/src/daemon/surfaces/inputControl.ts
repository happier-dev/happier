export type SurfaceInputCompletion = 'known' | 'unknown';
export type SurfaceInputRequester = 'agent' | 'human';
export type SurfaceInputAdmissionFailure = 'busy' | 'closed' | 'human_interrupted' | 'observation_required' | 'observation_held' | 'uncertain';

export type SurfaceInputExecutionResult<T> =
  | Readonly<{ ok: false; errorCode: SurfaceInputAdmissionFailure }>
  | Readonly<{ ok: true; value: T; interrupted: boolean; completion: SurfaceInputCompletion; reason?: string }>;

export type SurfaceInputControl = Readonly<{
  getStatus(): Readonly<{ controller: SurfaceInputRequester | 'idle'; controlEpoch: number; stopping: boolean; uncertain: boolean }>;
  getAdmissionFailure(requestedBy: SurfaceInputRequester): SurfaceInputAdmissionFailure | undefined;
  getObservationFailure(requestedBy: SurfaceInputRequester): 'closed' | 'observation_held' | undefined;
  isClosed(): boolean;
  observe(controlEpoch: number): boolean;
  invalidateObservation(): void;
  isObservationHeld(): boolean;
  hasConfidentialityHold(): boolean;
  beginConfidentialityHold(): Promise<void>;
  /** Only the source owner may clear this after proving the confidential target is safe. */
  clearConfidentialityHold(): boolean;
  /** Retain a non-input operation through confidentiality drain without changing the controller. */
  drainWhile<T>(effect: () => Promise<T>): Promise<T>;
  observeWhile<T>(read: () => Promise<T>, classifyCompletion?: (value: T) => SurfaceInputCompletion): Promise<T | undefined>;
  registerConfidentialityDrain(drain: () => Promise<void>): () => void;
  execute<T>(input: Readonly<{
    requestedBy: SurfaceInputRequester;
    /** Page-independent effects need no locator observation; hand-back recovery still does. */
    requiresObservation?: boolean;
    signal?: AbortSignal;
    effect(signal: AbortSignal): Promise<T>;
    classifyCompletion(value: T, signal: AbortSignal): SurfaceInputCompletion;
  }>): Promise<SurfaceInputExecutionResult<T>>;
  takeOver(reason?: string): Promise<Readonly<{ active: boolean; completion: SurfaceInputCompletion }>>;
  handBack(): boolean;
  close(reason?: string): Promise<SurfaceInputCompletion>;
}>;

type ActiveInput = Readonly<{
  requestedBy: SurfaceInputRequester;
  abort: AbortController;
  drained: Promise<SurfaceInputCompletion>;
}>;

/** One instance belongs to one actual input target. The transport owns target lookup and authority. */
export function createSurfaceInputControl({ previousControl, ...options }: Readonly<{
  requireObservation?: boolean;
  onStatusChange?: () => void;
  /** Accepted observations are activity even when the controller status is unchanged. */
  onObservation?: () => void;
  /** Replacing a drained source is not Hand back. Only its human hold survives. */
  previousControl?: SurfaceInputControl;
}> = {}): SurfaceInputControl {
  let controlEpoch = 0;
  let humanHeld = previousControl?.getStatus().controller === 'human';
  let closed = false;
  let uncertain = false;
  let observationRequirement: 'required' | 'hand_back' | null = options.requireObservation ? 'required' : null;
  let active: ActiveInput | null = null;
  let confidentialityHeld = false;
  let confidentialityDrain: Promise<void> | null = null;
  let confidentialityDrained = false;
  const observations = new Set<Promise<unknown>>();
  const captureDrains = new Set<() => Promise<void>>();

  function getObservationFailure(requestedBy: SurfaceInputRequester): 'closed' | 'observation_held' | undefined {
    if (closed) return 'closed';
    return requestedBy === 'agent' && confidentialityHeld ? 'observation_held' : undefined;
  }

  function getAdmissionFailure(requestedBy: SurfaceInputRequester, requiresObservation = true): SurfaceInputAdmissionFailure | undefined {
    if (active) return 'busy';
    const observationFailure = getObservationFailure(requestedBy);
    if (observationFailure) return observationFailure;
    if (uncertain && (requestedBy === 'human' || observationRequirement !== 'hand_back')) return 'uncertain';
    if (requestedBy === 'agent' && humanHeld) return 'human_interrupted';
    if (requestedBy === 'agent' && observationRequirement && (requiresObservation || observationRequirement === 'hand_back')) return 'observation_required';
    return undefined;
  }

  async function drainWhile<T>(effect: () => Promise<T>): Promise<T> {
    const pending = effect();
    observations.add(pending);
    try { return await pending; }
    finally { observations.delete(pending); }
  }

  return {
    getStatus: () => ({
      controller: humanHeld ? 'human' : active?.requestedBy ?? 'idle',
      controlEpoch,
      stopping: active?.abort.signal.aborted ?? false,
      uncertain,
    }),
    getAdmissionFailure,
    getObservationFailure,
    isClosed: () => closed,
    isObservationHeld: () => confidentialityHeld || closed,
    hasConfidentialityHold: () => confidentialityHeld,
    beginConfidentialityHold() {
      if (confidentialityDrain) return confidentialityDrain;
      confidentialityHeld = true;
      confidentialityDrained = false;
      controlEpoch += 1;
      observationRequirement = 'required';
      const current = active;
      if (current?.requestedBy === 'agent') current.abort.abort('confidential_input');
      options.onStatusChange?.();
      confidentialityDrain = (async () => {
        await Promise.all([
          ...[...observations].map(read => read.then(() => undefined, () => undefined)),
          ...(current?.requestedBy === 'agent' ? [current.drained] : []),
        ]);
        await Promise.all([...captureDrains].map(drain => drain()));
        confidentialityDrained = true;
      })();
      return confidentialityDrain;
    },
    clearConfidentialityHold() {
      if (active || closed || !confidentialityHeld || !confidentialityDrained) return false;
      confidentialityHeld = false;
      confidentialityDrain = null;
      observationRequirement = 'required';
      options.onStatusChange?.();
      return true;
    },
    drainWhile,
    async observeWhile<T>(read: () => Promise<T>, classifyCompletion?: (value: T) => SurfaceInputCompletion): Promise<T | undefined> {
      if (getObservationFailure('agent')) return undefined;
      const epoch = controlEpoch;
      try {
        const result = await drainWhile(read);
        // A read may dismiss a dialog. Settle that physical effect even if its observation
        // became private or stale while awaiting the boundary acknowledgement.
        if (classifyCompletion?.(result) === 'unknown') {
          uncertain = true;
          options.onStatusChange?.();
        }
        return confidentialityHeld || closed || epoch !== controlEpoch ? undefined : result;
      } catch (error) {
        if (confidentialityHeld || closed || epoch !== controlEpoch) return undefined;
        throw error;
      }
    },
    registerConfidentialityDrain(drain) {
      captureDrains.add(drain);
      return () => { captureDrains.delete(drain); };
    },
    observe(epoch) {
      if (confidentialityHeld || closed || active || epoch !== controlEpoch || (uncertain && !humanHeld && observationRequirement !== 'hand_back')) return false;
      const statusChanged = uncertain;
      uncertain = false;
      observationRequirement = null;
      options.onObservation?.();
      if (statusChanged) options.onStatusChange?.();
      return true;
    },
    invalidateObservation() { observationRequirement ??= 'required'; },
    async execute<T>(input: Readonly<{
      requestedBy: SurfaceInputRequester;
      requiresObservation?: boolean;
      signal?: AbortSignal;
      effect(signal: AbortSignal): Promise<T>;
      classifyCompletion(value: T, signal: AbortSignal): SurfaceInputCompletion;
    }>): Promise<SurfaceInputExecutionResult<T>> {
      const errorCode = getAdmissionFailure(input.requestedBy, input.requiresObservation !== false);
      if (errorCode) return { ok: false, errorCode };

      const abort = new AbortController();
      let resolveDrained: (completion: SurfaceInputCompletion) => void = () => undefined;
      const drained = new Promise<SurfaceInputCompletion>((resolve) => { resolveDrained = resolve; });
      active = { requestedBy: input.requestedBy, abort, drained };
      options.onStatusChange?.();
      const cancelFromCaller = () => { observationRequirement = 'required'; abort.abort('user_canceled'); options.onStatusChange?.(); };
      if (input.signal?.aborted) cancelFromCaller();
      else input.signal?.addEventListener('abort', cancelFromCaller, { once: true });

      let completion: SurfaceInputCompletion = 'unknown';
      try {
        // Await the real train, including boundary-owned held-input cleanup. Racing abort would
        // release admission while the previous action can still send input.
        const value = await input.effect(abort.signal);
        completion = input.classifyCompletion(value, abort.signal);
        return { ok: true, value, interrupted: abort.signal.aborted, completion,
          ...(abort.signal.aborted ? { reason: String(abort.signal.reason) } : {}) };
      } finally {
        input.signal?.removeEventListener('abort', cancelFromCaller);
        if (completion === 'unknown') uncertain = true;
        active = null;
        resolveDrained(completion);
        options.onStatusChange?.();
      }
    },
    async takeOver(reason = 'user_canceled') {
      const statusChanged = !humanHeld || Boolean(active && !active.abort.signal.aborted);
      if (!humanHeld) controlEpoch += 1;
      humanHeld = true;
      observationRequirement = 'required';
      const current = active;
      current?.abort.abort(reason);
      if (statusChanged) options.onStatusChange?.();
      return { active: current !== null, completion: current ? await current.drained : uncertain ? 'unknown' : 'known' };
    },
    handBack() {
      if (active || closed) return false;
      const statusChanged = humanHeld;
      if (humanHeld) controlEpoch += 1;
      humanHeld = false;
      // Hand back changes admission, not the unsettled-effect fact. A fresh agent
      // observation must clear that fact before its next mutation.
      observationRequirement = 'hand_back';
      if (statusChanged) options.onStatusChange?.();
      return true;
    },
    async close(reason = 'closed') {
      closed = true;
      const current = active;
      current?.abort.abort(reason);
      options.onStatusChange?.();
      return current ? await current.drained : uncertain ? 'unknown' : 'known';
    },
  };
}
