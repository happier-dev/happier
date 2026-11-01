/**
 * Atomic file write utility
 * Ensures file writes are atomic using temp file + rename pattern
 */

import { writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

export async function atomicFileWrite(
  filePath: string,
  content: string | ((temporaryPath: string) => Promise<void>),
): Promise<void> {
  const tmpFile = `${filePath}.${randomUUID()}.tmp`;
  
  try {
    // The callback lets streamed writers use the same publication and cleanup lifecycle.
    if (typeof content === 'string') {
      await writeFile(tmpFile, content);
    } else {
      await content(tmpFile);
    }
    
    // Atomic rename (on POSIX systems)
    await rename(tmpFile, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tmpFile);
    } catch {}
    throw error;
  }
}
