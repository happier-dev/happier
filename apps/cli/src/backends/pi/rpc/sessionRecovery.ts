import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  doesPiSessionFileNameMatchSessionId,
  isBarePiSessionId,
} from '@happier-dev/plugins-pi/agent/sessionFiles';

import { asNonEmptyString } from './rpcSupport';
import type { PiRpcStreamReader } from './streamReaders';

export function createPiSessionNotMaterializedError(expectedSessionId: string): Error {
  return Object.assign(
    new Error(`Pi session '${expectedSessionId}' was not found or has not materialized in Pi's session store yet`),
    { code: 'PI_SESSION_NOT_MATERIALIZED' as const },
  );
}

export async function resolvePiSessionFileForSessionId(params: Readonly<{
  expectedSessionId: string;
  env: Record<string, string>;
  sessionFile: string | null;
}>): Promise<string | null> {
  const candidateDirs = new Set<string>();
  const fromSessionEnv = asNonEmptyString(params.env.PI_CODING_AGENT_SESSION_DIR);
  if (fromSessionEnv) {
    candidateDirs.add(fromSessionEnv);
  }
  const fromEnv = asNonEmptyString(params.env.PI_CODING_AGENT_DIR);
  if (fromEnv) {
    candidateDirs.add(fromEnv);
    candidateDirs.add(join(fromEnv, 'sessions'));
  }
  if (params.sessionFile) candidateDirs.add(dirname(params.sessionFile));

  const matches: Array<{ path: string; mtimeMs: number }> = [];
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [];
  const maxDepth = 4;
  const enqueue = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    queue.push({ dir, depth });
  };
  for (const dir of candidateDirs) enqueue(dir, 0);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    try {
      const entries = await readdir(next.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (next.depth < maxDepth) enqueue(join(next.dir, entry.name), next.depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!doesPiSessionFileNameMatchSessionId(entry.name, params.expectedSessionId)) continue;
        const path = join(next.dir, entry.name);
        try {
          const result = await stat(path);
          matches.push({ path, mtimeMs: typeof result.mtimeMs === 'number' ? result.mtimeMs : 0 });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path));
  return matches[0]?.path ?? null;
}

export function resolvePiAuthJsonPath(env: Record<string, string>): string | null {
  const agentDir = asNonEmptyString(env.PI_CODING_AGENT_DIR);
  if (!agentDir) return null;
  return join(agentDir, 'auth.json');
}

export async function readPiAuthJsonMtimeMs(authPath: string): Promise<number | null> {
  try {
    const result = await stat(authPath);
    return typeof result.mtimeMs === 'number' && Number.isFinite(result.mtimeMs) ? result.mtimeMs : null;
  } catch {
    return null;
  }
}

export async function stopPiRpcProcess(params: Readonly<{
  process: ChildProcessWithoutNullStreams | null;
  stdoutLineReader: PiRpcStreamReader | null;
  stderrLineReader: PiRpcStreamReader | null;
}>): Promise<void> {
  params.stdoutLineReader?.close();
  params.stderrLineReader?.close();

  const child = params.process;
  if (!child) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 2_000);
    timeout.unref?.();

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}
