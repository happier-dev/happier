import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Outer workspace publishers own promotion; copying also works when compiler
// output and the publisher's temporary destination are on different devices.
export async function copyDirectoryContents(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    await cp(join(sourceDir, entry.name), join(destinationDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}
