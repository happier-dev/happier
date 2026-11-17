import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { deliverManagedNativeArchive, type ManagedNativeFileDeliveryIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { JsonValue } from '@happier-dev/protocol';

/** Filesystem source adapter for the shared native archive delivery owner. */
export async function deliverManagedNativeFile(input: Readonly<{
  localPath: string; guestPath: string; resource: JsonValue; signal?: AbortSignal;
  onProgress?(progress: Readonly<{ transferredBytes: number; totalBytes: number }>): void;
}>, native: ManagedNativeFileDeliveryIO): Promise<void> {
  input.signal?.throwIfAborted();
  const totalBytes = (await stat(input.localPath)).size;
  const chunks = createReadStream(input.localPath, { signal: input.signal });
  try {
    await deliverManagedNativeArchive({ ...input, chunks, totalBytes }, native);
  } finally { chunks.destroy(); }
}
