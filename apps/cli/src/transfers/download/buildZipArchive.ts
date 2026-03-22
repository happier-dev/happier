import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, lstat } from 'fs/promises';
import { basename, dirname, join } from 'path';

function toZipEntryPath(parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}

export async function buildZipArchive(input: Readonly<{
  sourcePath: string;
  zipPath: string;
  excludedTopLevelDirs: readonly string[];
  maxEntryCount: number;
  maxTotalBytes: number;
  maxOutputBytes: number;
}>): Promise<void> {
  await mkdir(dirname(input.zipPath), { recursive: true });

  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = createWriteStream(input.zipPath);

  const closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
    output.on('close', () => resolvePromise());
    output.on('error', rejectPromise);
    archive.on('warning', (err: unknown) => {
      if ((err as { code?: string } | null)?.code === 'ENOENT') return;
      rejectPromise(err);
    });
    archive.on('error', rejectPromise);
  });

  archive.pipe(output);

  let entryCount = 0;
  let totalBytes = 0;

  const rootStats = await stat(input.sourcePath);
  const rootName = basename(input.sourcePath);

  const addFile = async (filePath: string, entryPath: string): Promise<void> => {
    const fileStats = await stat(filePath);
    totalBytes += fileStats.size;
    if (totalBytes > input.maxTotalBytes) {
      throw new Error('Zip exceeds total input size limit');
    }
    entryCount += 1;
    if (entryCount > input.maxEntryCount) {
      throw new Error('Zip exceeds entry count limit');
    }
    archive.file(filePath, { name: entryPath });
  };

  const walkDir = async (dirPath: string, relPrefix: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (!name) continue;

      if (dirPath === input.sourcePath && input.excludedTopLevelDirs.includes(name)) {
        continue;
      }

      const fullPath = join(dirPath, name);
      const relPath = relPrefix ? join(relPrefix, name) : name;
      const entryPath = toZipEntryPath([rootName, relPath]);

      const linkStats = await lstat(fullPath);
      if (linkStats.isSymbolicLink()) continue;

      if (linkStats.isDirectory()) {
        await walkDir(fullPath, relPath);
        continue;
      }
      if (linkStats.isFile()) {
        await addFile(fullPath, entryPath);
      }
    }
  };

  if (rootStats.isFile()) {
    await addFile(input.sourcePath, toZipEntryPath([rootName]));
  } else if (rootStats.isDirectory()) {
    await walkDir(input.sourcePath, '');
  } else {
    throw new Error('Unsupported path type for zip');
  }

  await archive.finalize();
  await closePromise;

  const zipStats = await stat(input.zipPath);
  if (zipStats.size > input.maxOutputBytes) {
    throw new Error('Zip exceeds output size limit');
  }
}
