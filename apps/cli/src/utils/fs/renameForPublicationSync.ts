import { renameSync } from 'node:fs';

const retryWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type RenameSync = (sourcePath: string, destinationPath: string) => void;

export function renameForPublicationSync(
  sourcePath: string,
  destinationPath: string,
  {
    renameImpl = renameSync,
    waitImpl = (delayMs: number) => {
      Atomics.wait(retryWaitArray, 0, 0, delayMs);
    },
    retryableCodes = new Set(['EACCES', 'EBUSY', 'EPERM']),
    maxRetries = 8,
    initialDelayMs = 25,
    maxDelayMs = 400,
  }: Readonly<{
    renameImpl?: RenameSync;
    waitImpl?: (delayMs: number) => void;
    retryableCodes?: ReadonlySet<string>;
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  }> = {},
): void {
  let retry = 0;
  while (true) {
    try {
      renameImpl(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !retryableCodes.has(code) || retry >= maxRetries) {
        throw error;
      }
      waitImpl(Math.min(initialDelayMs * (2 ** retry), maxDelayMs));
      retry += 1;
    }
  }
}
