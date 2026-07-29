import type { FileHandle } from 'node:fs/promises';

export async function writeFileHandleFully(input: Readonly<{
  fileHandle: FileHandle;
  buffer: Uint8Array;
  position: number;
}>): Promise<void> {
  let offset = 0;
  while (offset < input.buffer.byteLength) {
    const remaining = input.buffer.byteLength - offset;
    const { bytesWritten } = await input.fileHandle.write(
      input.buffer,
      offset,
      remaining,
      input.position + offset,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error('File write made no progress');
    }
    offset += bytesWritten;
  }
}
