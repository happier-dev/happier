export type SurfaceInputCompletion = 'known' | 'unknown';
export type SurfaceInputRequester = 'agent' | 'human';
export type SurfaceInputAdmissionFailure = 'busy' | 'closed' | 'human_interrupted' | 'observation_required' | 'uncertain';

export type SurfaceInputExecutionResult<T> =
  | Readonly<{ ok: false; errorCode: SurfaceInputAdmissionFailure }>
  | Readonly<{ ok: true; value: T; interrupted: boolean; completion: SurfaceInputCompletion; reason?: string }>;

export type SurfaceInputControl = Readonly<{
  getStatus(): Readonly<{ controller: SurfaceInputRequester | 'idle'; controlEpoch: number; stopping: boolean; uncertain: boolean }>;
  getAdmissionFailure(requestedBy: SurfaceInputRequester): SurfaceInputAdmissionFailure | undefined;
  isClosed(): boolean;
  observe(controlEpoch: number): boolean;
  invalidateObservation(): void;
  isObservationHeld(): boolean;
  hasConfidentialityHold(): boolean;
  beginConfidentialityHold(): Promise<void>;
  /** Only the source owner may clear this after proving the confidential target is safe. */
  clearConfidentialityHold(): boolean;
  observeWhile<T>(read: () => Promise<T>): Promise<T | undefined>;
  registerConfidentialityDrain(drain: () => Promise<void>): () => void;
  execute<T>(input: Readonly<{
    requestedBy: SurfaceInputRequester;
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
export function createSurfaceInputControl(options: Readonly<{ requireObservation?: boolean; onStatusChange?: () => void }> = {}): SurfaceInputControl {
  let controlEpoch = 0;
  let humanHeld = false;
  let closed = false;
  let uncertain = false;
  let observationRequirement: 'required' | 'hand_back' | null = options.requireObservation ? 'required' : null;
  let active: ActiveInput | null = null;
  let confidentialityHeld = false;
  let confidentialityDrain: Promise<void> | null = null;
  let confidentialityDrained = false;
  const observations = new Set<Promise<unknown>>();
  const captureDrains = new Set<() => Promise<void>>();

  function getAdmissionFailure(requestedBy: SurfaceInputRequester): SurfaceInputAdmissionFailure | undefined {
    if (active) return 'busy';
    if (closed) return 'closed';
    if (requestedBy === 'agent' && confidentialityHeld) return 'observation_required';
    if (uncertain && requestedBy === 'agent' && observationRequirement !== 'hand_back') return 'uncertain';
    if (requestedBy === 'agent' && humanHeld) return 'human_interrupted';
    if (requestedBy === 'agent' && observationRequirement) return 'observation_required';
    return undefined;
  }

  return {
    getStatus: () => ({
      controller: humanHeld ? 'human' : active?.requestedBy ?? 'idle',
      controlEpoch,
      stopping: active?.abort.signal.aborted ?? false,
      uncertain,
    }),
    getAdmissionFailure,
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
    async observeWhile<T>(read: () => Promise<T>): Promise<T | undefined> {
      if (confidentialityHeld || closed) return undefined;
      const epoch = controlEpoch;
      const pending = read();
      observations.add(pending);
      try {
        const result = await pending;
        return confidentialityHeld || closed || epoch !== controlEpoch ? undefined : result;
      } catch (error) {
        if (confidentialityHeld || closed || epoch !== controlEpoch) return undefined;
        throw error;
      } finally { observations.delete(pending); }
    },
    registerConfidentialityDrain(drain) {
      captureDrains.add(drain);
      return () => { captureDrains.delete(drain); };
    },
    observe(epoch) {
      if (confidentialityHeld || closed || active || epoch !== controlEpoch || (uncertain && !humanHeld && observationRequirement !== 'hand_back')) return false;
      uncertain = false;
      observationRequirement = null;
      options.onStatusChange?.();
      return true;
    },
    invalidateObservation() { observationRequirement ??= 'required'; },
    async execute<T>(input: Readonly<{
      requestedBy: SurfaceInputRequester;
      signal?: AbortSignal;
      effect(signal: AbortSignal): Promise<T>;
      classifyCompletion(value: T, signal: AbortSignal): SurfaceInputCompletion;
    }>): Promise<SurfaceInputExecutionResult<T>> {
      const errorCode = getAdmissionFailure(input.requestedBy);
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
      if (!humanHeld) controlEpoch += 1;
      humanHeld = true;
      observationRequirement = 'required';
      const current = active;
      current?.abort.abort(reason);
      options.onStatusChange?.();
      return { active: current !== null, completion: current ? await current.drained : uncertain ? 'unknown' : 'known' };
    },
    handBack() {
      if (active || closed) return false;
      if (humanHeld) controlEpoch += 1;
      humanHeld = false;
      // Hand back changes admission, not the unsettled-effect fact. A fresh agent
      // observation must clear that fact before its next mutation.
      observationRequirement = 'hand_back';
      options.onStatusChange?.();
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
