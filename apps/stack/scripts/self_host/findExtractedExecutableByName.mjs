import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function findExtractedExecutableByName({
  rootDir,
  binaryName,
  platform = process.platform,
}) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExtractedExecutableByName({
        rootDir: fullPath,
        binaryName,
        platform,
      });
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name !== binaryName) continue;
    if (platform === 'win32') return fullPath;
    const info = await stat(fullPath);
    if ((info.mode & 0o111) !== 0) return fullPath;
  }
  return '';
}
