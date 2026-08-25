import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const RENAME_ATTEMPTS = 3;

function isRetryableRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST' || code === 'EPERM';
}

async function publishByRename(sourcePath: string, destinationPath: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableRenameConflict(error) || attempt === RENAME_ATTEMPTS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

export async function writeGeneratedTextAtomicallyIfChanged(params: Readonly<{
  path: string;
  contents: string;
  mode: number;
}>): Promise<void> {
  const existing = await readFile(params.path, 'utf8').catch(() => null);
  if (existing === params.contents) return;

  const temporaryPath = join(
    dirname(params.path),
    `.${basename(params.path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(temporaryPath, params.contents, { mode: params.mode });
    if (process.platform !== 'win32') await chmod(temporaryPath, params.mode);
    await publishByRename(temporaryPath, params.path);
    if (process.platform !== 'win32') await chmod(params.path, params.mode);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
