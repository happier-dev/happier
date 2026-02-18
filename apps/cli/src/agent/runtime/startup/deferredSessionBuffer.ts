export type DeferredSessionBufferLimits = Readonly<{
  maxEntries: number;
  maxBytes: number;
}>;

export type DeferredSessionBufferEntry<TTarget> = Readonly<{
  approxBytes: number;
  flush: (target: TTarget) => void | Promise<void>;
  onDrop?: () => void;
}>;

export type DeferredSessionBufferStats = Readonly<{
  entryCount: number;
  approxBytes: number;
  overflowed: boolean;
}>;
