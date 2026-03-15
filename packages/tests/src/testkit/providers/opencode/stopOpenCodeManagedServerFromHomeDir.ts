import { unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { terminateProcessTreeByPid } from '../../process/processTree';

type ManagedServerState = Readonly<{
  baseUrl: string;
  pid: number;
  startedAtMs: number;
}>;

function parseState(raw: string): ManagedServerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const baseUrl = typeof (parsed as any).baseUrl === 'string' ? String((parsed as any).baseUrl).trim() : '';
    const pid = typeof (parsed as any).pid === 'number' ? (parsed as any).pid : Number((parsed as any).pid);
    const startedAtMs =
      typeof (parsed as any).startedAtMs === 'number' ? (parsed as any).startedAtMs : Number((parsed as any).startedAtMs);
    if (!baseUrl) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
    return { baseUrl, pid: Math.trunc(pid), startedAtMs: Math.trunc(startedAtMs) };
  } catch {
    return null;
  }
}

export async function stopOpenCodeManagedServerFromHomeDir(happyHomeDir: string): Promise<void> {
  const statePath = join(happyHomeDir, 'opencode', 'managed-server.json');
  const lockPath = `${statePath}.lock`;

  const raw = await readFile(statePath, 'utf8').catch(() => null);
  if (!raw) return;
  const state = parseState(raw);
  if (!state) return;

  await terminateProcessTreeByPid(state.pid, { graceMs: 5_000, pollMs: 100 }).catch(() => {});

  await unlink(statePath).catch(() => {});
  await unlink(lockPath).catch(() => {});
}

