import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProtectedLocalStateDirectory,
  writeProtectedLocalStateFileAtomic,
} from './protectedLocalState';

export type ProtectedTempTextArtifact = Readonly<{
  path: string;
  cleanup: () => Promise<void>;
}>;

export async function materializeProtectedTempTextArtifact(params: Readonly<{
  prefix: string;
  contents: string;
}>): Promise<ProtectedTempTextArtifact> {
  const directory = await createProtectedLocalStateDirectory(join(tmpdir(), params.prefix));
  const path = join(directory, 'text-artifact.txt');
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await writeProtectedLocalStateFileAtomic(path, params.contents);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { path, cleanup };
}
