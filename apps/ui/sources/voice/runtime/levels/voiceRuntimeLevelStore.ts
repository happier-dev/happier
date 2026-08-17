export type VoiceRuntimeLevelChannel = 'input' | 'output';

export type VoiceRuntimeLevelSnapshot = Readonly<{
  inputLevel: number;
  outputLevel: number;
  inputSourceActive: boolean;
  outputSourceActive: boolean;
}>;

export type VoiceRuntimeLevelChannelSnapshot = Readonly<{
  level: number;
  sourceActive: boolean;
}>;

export type VoiceRuntimeLevelSourceActivity = Readonly<{
  inputSourceActive: boolean;
  outputSourceActive: boolean;
}>;

type VoiceRuntimeLevelStoreOptions = Readonly<{
  staleAfterMs?: number;
  setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>;

export type VoiceRuntimeLevelWriter = Readonly<{
  write(level: number): void;
  reset(): void;
  close(): void;
}>;

export type VoiceRuntimeLevelStore = Readonly<{
  open(args: Readonly<{ channel: VoiceRuntimeLevelChannel; sourceId: string }>): VoiceRuntimeLevelWriter;
  getSnapshot(): VoiceRuntimeLevelSnapshot;
  getSourceActivitySnapshot(): VoiceRuntimeLevelSourceActivity;
  subscribe(channel: VoiceRuntimeLevelChannel, listener: (snapshot: VoiceRuntimeLevelChannelSnapshot) => void): () => void;
  subscribeSourceActivity(listener: (snapshot: VoiceRuntimeLevelSourceActivity) => void): () => void;
}>;

const DEFAULT_STALE_AFTER_MS = 180;
const ATTACK = 0.65;
const RELEASE = 0.25;

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function smoothLevel(previous: number, sample: number): number {
  if (sample === 0) return 0;
  const coefficient = sample > previous ? ATTACK : RELEASE;
  return clampLevel(previous + (sample - previous) * coefficient);
}

export function createVoiceRuntimeLevelStore(
  options: VoiceRuntimeLevelStoreOptions = {},
): VoiceRuntimeLevelStore {
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && Number(options.staleAfterMs) >= 0
    ? Number(options.staleAfterMs)
    : DEFAULT_STALE_AFTER_MS;
  const setTimer = options.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const listeners: Record<VoiceRuntimeLevelChannel, Set<(snapshot: VoiceRuntimeLevelChannelSnapshot) => void>> = {
    input: new Set(),
    output: new Set(),
  };
  const sourceActivityListeners = new Set<(snapshot: VoiceRuntimeLevelSourceActivity) => void>();
  const activeToken: Record<VoiceRuntimeLevelChannel, symbol | null> = {
    input: null,
    output: null,
  };
  const staleTimer: Record<VoiceRuntimeLevelChannel, ReturnType<typeof setTimeout> | null> = {
    input: null,
    output: null,
  };
  let snapshot: VoiceRuntimeLevelSnapshot = Object.freeze({
    inputLevel: 0,
    outputLevel: 0,
    inputSourceActive: false,
    outputSourceActive: false,
  });
  let sourceActivitySnapshot: VoiceRuntimeLevelSourceActivity = Object.freeze({
    inputSourceActive: false,
    outputSourceActive: false,
  });

  const read = (channel: VoiceRuntimeLevelChannel): VoiceRuntimeLevelChannelSnapshot => channel === 'input'
    ? { level: snapshot.inputLevel, sourceActive: snapshot.inputSourceActive }
    : { level: snapshot.outputLevel, sourceActive: snapshot.outputSourceActive };

  const publish = (channel: VoiceRuntimeLevelChannel, next: VoiceRuntimeLevelChannelSnapshot): void => {
    const previous = read(channel);
    if (Object.is(previous.level, next.level) && previous.sourceActive === next.sourceActive) return;
    snapshot = Object.freeze(channel === 'input'
      ? { ...snapshot, inputLevel: next.level, inputSourceActive: next.sourceActive }
      : { ...snapshot, outputLevel: next.level, outputSourceActive: next.sourceActive });
    const published = Object.freeze({ ...next });
    for (const listener of listeners[channel]) listener(published);
    if (previous.sourceActive !== next.sourceActive) {
      sourceActivitySnapshot = Object.freeze({
        inputSourceActive: snapshot.inputSourceActive,
        outputSourceActive: snapshot.outputSourceActive,
      });
      for (const listener of sourceActivityListeners) listener(sourceActivitySnapshot);
    }
  };

  const cancelStaleTimer = (channel: VoiceRuntimeLevelChannel): void => {
    const timer = staleTimer[channel];
    if (timer !== null) clearTimer(timer);
    staleTimer[channel] = null;
  };

  const resetIfOwned = (channel: VoiceRuntimeLevelChannel, token: symbol): void => {
    if (activeToken[channel] !== token) return;
    cancelStaleTimer(channel);
    publish(channel, { level: 0, sourceActive: true });
  };

  return Object.freeze({
    open: ({ channel, sourceId }) => {
      const normalizedSourceId = sourceId.trim();
      if (!normalizedSourceId) throw new Error('voice_level_source_id_required');
      const token = Symbol(`${channel}:${normalizedSourceId}`);
      cancelStaleTimer(channel);
      activeToken[channel] = token;
      publish(channel, { level: 0, sourceActive: true });

      return Object.freeze({
        write: (sample: number) => {
          if (activeToken[channel] !== token) return;
          cancelStaleTimer(channel);
          const next = smoothLevel(read(channel).level, clampLevel(sample));
          publish(channel, { level: next, sourceActive: true });
          if (next > 0) {
            staleTimer[channel] = setTimer(() => {
              staleTimer[channel] = null;
              if (activeToken[channel] === token) publish(channel, { level: 0, sourceActive: true });
            }, staleAfterMs);
          }
        },
        reset: () => resetIfOwned(channel, token),
        close: () => {
          if (activeToken[channel] !== token) return;
          cancelStaleTimer(channel);
          activeToken[channel] = null;
          publish(channel, { level: 0, sourceActive: false });
        },
      });
    },
    getSnapshot: () => snapshot,
    getSourceActivitySnapshot: () => sourceActivitySnapshot,
    subscribe: (channel, listener) => {
      listeners[channel].add(listener);
      return () => listeners[channel].delete(listener);
    },
    subscribeSourceActivity: (listener) => {
      sourceActivityListeners.add(listener);
      return () => sourceActivityListeners.delete(listener);
    },
  });
}

export const voiceRuntimeLevelStore = createVoiceRuntimeLevelStore();
