/** The incumbent worker tick owns one cursor and one source-processing budget. */
export async function runMemoryWorkerSourcesTick(input: Readonly<{
  sessionIds: readonly string[];
  externalSourceCount: number;
  prepareExternalSources?(): Promise<number>;
  finishTick?(): Promise<void>;
  cursor: number;
  advanceCursor?(cursor: number): void;
  signal?: AbortSignal;
  maxSessions: number;
  syncSessions(sessionIds: readonly string[]): Promise<void>;
  syncExternalSources(maxSources: number): Promise<void>;
}>): Promise<number> {
  input.signal?.throwIfAborted();
  let sourceFailure: { error: unknown } | null = null;
  let externalSourceCount = input.externalSourceCount;
  if (input.prepareExternalSources) {
    try { externalSourceCount = await input.prepareExternalSources(); }
    catch (error) {
      input.signal?.throwIfAborted();
      sourceFailure = { error };
      externalSourceCount = 0;
    }
  }
  const selected: string[] = [];
  const total = input.sessionIds.length + externalSourceCount;
  let cursor = total ? input.cursor % total : 0;
  let externalAllowance = 0;
  for (let i = 0; i < Math.min(input.maxSessions, total); i++) {
    if (cursor < input.sessionIds.length) selected.push(input.sessionIds[cursor]!);
    else externalAllowance++;
    cursor = (cursor + 1) % total;
  }
  // Selection consumes the incumbent turn even if a selected source fails.
  input.advanceCursor?.(cursor);
  if (externalAllowance) {
    try { await input.syncExternalSources(externalAllowance); }
    catch (error) {
      input.signal?.throwIfAborted();
      sourceFailure = { error };
    }
  }
  input.signal?.throwIfAborted();
  if (selected.length) {
    try { await input.syncSessions(selected); }
    catch (error) {
      input.signal?.throwIfAborted();
      sourceFailure ??= { error };
    }
  }
  input.signal?.throwIfAborted();
  if (input.finishTick) {
    try { await input.finishTick(); }
    catch (error) {
      input.signal?.throwIfAborted();
      if (sourceFailure) throw new AggregateError([sourceFailure.error, error], 'memory_worker_tick_failed');
      throw error;
    }
  }
  input.signal?.throwIfAborted();
  if (sourceFailure) throw sourceFailure.error;
  return cursor;
}
