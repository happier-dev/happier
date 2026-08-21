import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProtectedLocalStateDirectory,
  writeProtectedLocalStateFileAtomic,
} from './protectedLocalState';

export type ProtectedTempTextArtifact = Readonly<{
  /** Path to the materialized text file (0600, inside a 0700 per-artifact directory). */
  path: string;
  /** Idempotent removal of the artifact directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
}>;

/**
 * Materialize text as a protected temporary file and return its path plus an idempotent
 * cleanup.
 *
 * Use when a subprocess flag must carry potentially large or private text (`--flag <text>`
 * vs `--flag <path>` where the tool re-reads an existing path): argv is process-list-visible
 * and subject to platform argument-length limits, a protected file is neither.
 *
 * The directory (0700) and file (0600) use the protected-local-state owners, including
 * Windows ACL handling. The artifact is retained until `cleanup()` — a reader that reloads
 * the file later (e.g. pi re-reads `--append-system-prompt` sources on resource reload)
 * keeps working for the whole subprocess lifetime. Callers clean up through their normal
 * terminal paths (dispose/exit), exactly like the Claude MCP config materializer.
 */
export async function materializeProtectedTempTextArtifact(params: Readonly<{
  /** mkdtemp prefix; include a trailing dash and a producer-identifying name. */
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
