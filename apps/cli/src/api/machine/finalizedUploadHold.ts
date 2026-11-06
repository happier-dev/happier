import { rm } from 'node:fs/promises';

/**
 * Holds a finalized upload's temp file until its consuming RPC takes it, so a
 * client that vanishes between `finalize` and `transcribe` cannot strand the
 * file. The transfer store owns session lifetime up to finalize; this owns the
 * short window after it, once for every voice upload family.
 */
export type FinalizedUploadHold<T extends Readonly<{ path: string }>> = Readonly<{
  hold(uploadId: string, value: T): void;
  peek(uploadId: string): T | undefined;
  /** Remove the entry and its timer; the consumer now owns deleting the file. */
  take(uploadId: string): T | undefined;
  /** Remove the entry and delete its file. */
  discard(uploadId: string): Promise<void>;
  discardAll(): Promise<void>;
}>;

export function createFinalizedUploadHold<T extends Readonly<{ path: string }>>(
  ttlMs: number,
): FinalizedUploadHold<T> {
  const held = new Map<string, Readonly<{ value: T; timer: ReturnType<typeof setTimeout> }>>();

  const take = (uploadId: string): T | undefined => {
    const entry = held.get(uploadId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    held.delete(uploadId);
    return entry.value;
  };
  const discard = async (uploadId: string): Promise<void> => {
    const value = take(uploadId);
    if (value) await rm(value.path, { force: true }).catch(() => undefined);
  };

  return {
    hold(uploadId, value) {
      take(uploadId);
      const timer = setTimeout(() => { void discard(uploadId); }, ttlMs);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      held.set(uploadId, { value, timer });
    },
    peek: (uploadId) => held.get(uploadId)?.value,
    take,
    discard,
    async discardAll() {
      await Promise.all([...held.keys()].map(discard));
    },
  };
}
