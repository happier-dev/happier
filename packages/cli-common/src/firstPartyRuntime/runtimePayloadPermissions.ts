import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Runtime code is shared with native execution users; private state and scratch
// stay outside this tree. Never follow links or grant non-owner writes.
export async function publishRuntimePayloadPermissions(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) {
      await publishRuntimePayloadPermissions(join(path, name));
    }
  } else if (entry.isFile()) {
    await chmod(path, (entry.mode & 0o111) === 0 ? 0o644 : 0o755);
  }
}
