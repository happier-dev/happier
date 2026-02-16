import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonExecutionRunMarkerSchema, type DaemonExecutionRunMarker } from '@happier-dev/protocol';

const ExecutionRunMarkerSchema = DaemonExecutionRunMarkerSchema;

export type ExecutionRunMarker = DaemonExecutionRunMarker;

function resolveExecutionRunMarkerDir(): string {
  return join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
}

function resolveExecutionRunMarkerPath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `run-${runId}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // Use a unique temp path per write to avoid cross-call corruption when multiple writers
  // update the same marker concurrently.
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          await unlink(filePath);
        } catch {
          // ignore
        }
        await rename(tmpPath, filePath);
        return;
      }
      throw e;
    }
  } catch (e) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function writeExecutionRunMarker(marker: Omit<ExecutionRunMarker, 'happyHomeDir'>): Promise<void> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const payload: ExecutionRunMarker = ExecutionRunMarkerSchema.parse({
    ...marker,
    happyHomeDir: configuration.happyHomeDir,
  });
  await writeJsonAtomic(resolveExecutionRunMarkerPath(payload.runId), payload);
}

export async function removeExecutionRunMarker(runId: string): Promise<void> {
  const path = resolveExecutionRunMarkerPath(runId);
  try {
    await unlink(path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[executionRunRegistry] Failed to remove marker run-${runId}.json`, e);
    }
  }
}

export async function listExecutionRunMarkers(): Promise<ExecutionRunMarker[]> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const entries = await readdir(dir);
  const out: ExecutionRunMarker[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('run-') || !entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = ExecutionRunMarkerSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      if (parsed.data.happyHomeDir !== configuration.happyHomeDir) continue;
      out.push(parsed.data);
    } catch {
      // ignore invalid marker
    }
  }

  out.sort((a, b) => a.startedAtMs - b.startedAtMs);
  return out;
}

export async function gcExecutionRunMarkers(params: Readonly<{
  nowMs: number;
  terminalTtlMs: number;
  isPidAlive: (pid: number) => boolean | Promise<boolean>;
  isPidSafeHappyProcess: (pid: number) => boolean | Promise<boolean>;
}>): Promise<{ removedRunIds: string[] }> {
  const markers = await listExecutionRunMarkers();
  const removedRunIds: string[] = [];

  for (const marker of markers) {
    const isTerminal = typeof marker.finishedAtMs === 'number' || marker.status !== 'running';
    if (isTerminal && typeof marker.finishedAtMs === 'number') {
      if (params.nowMs - marker.finishedAtMs > params.terminalTtlMs) {
        await removeExecutionRunMarker(marker.runId);
        removedRunIds.push(marker.runId);
        continue;
      }
    }

    const alive = await params.isPidAlive(marker.pid);
    if (!alive) {
      await removeExecutionRunMarker(marker.runId);
      removedRunIds.push(marker.runId);
      continue;
    }

    const safe = await params.isPidSafeHappyProcess(marker.pid);
    if (!safe) {
      await removeExecutionRunMarker(marker.runId);
      removedRunIds.push(marker.runId);
      continue;
    }
  }

  return { removedRunIds };
}
