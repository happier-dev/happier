import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonExecutionRunMarkerSchema, type DaemonExecutionRunMarker } from '@happier-dev/protocol';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';

const ExecutionRunMarkerSchema = DaemonExecutionRunMarkerSchema;

export type ExecutionRunMarker = DaemonExecutionRunMarker;

function resolveExecutionRunMarkerDir(): string {
  return join(
    configuration.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('daemon-execution-runs', configuration.publicReleaseRing),
  );
}

function resolveExecutionRunMarkerPath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `run-${runId}.json`);
}

function isExecutionRunMarkerEntry(entry: string): boolean {
  if (!entry.startsWith('run-')) return false;
  return entry.endsWith('.json') || entry.includes('.json.tmp-');
}

function isCanonicalExecutionRunMarkerEntry(entry: string): boolean {
  return entry.startsWith('run-') && entry.endsWith('.json');
}

async function readExecutionRunMarkerFile(path: string): Promise<ExecutionRunMarker | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = ExecutionRunMarkerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.happyHomeDir !== configuration.happyHomeDir) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function shouldReplaceRecoveredMarker(params: Readonly<{
  current: ExecutionRunMarker;
  currentIsCanonical: boolean;
  next: ExecutionRunMarker;
  nextIsCanonical: boolean;
}>): boolean {
  if (params.next.updatedAtMs !== params.current.updatedAtMs) {
    return params.next.updatedAtMs > params.current.updatedAtMs;
  }
  if (params.nextIsCanonical !== params.currentIsCanonical) {
    return params.nextIsCanonical;
  }
  return false;
}

function isTerminalMarker(marker: ExecutionRunMarker): boolean {
  if (marker.status !== 'running') return true;
  return typeof (marker as any).finishedAtMs === 'number';
}

function isRunningMarker(marker: ExecutionRunMarker): boolean {
  return marker.status === 'running' && typeof (marker as any).finishedAtMs !== 'number';
}

async function shouldSkipOverwriteForTerminalMarker(filePath: string, next: ExecutionRunMarker): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = ExecutionRunMarkerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    if (parsed.data.happyHomeDir !== next.happyHomeDir) return false;
    if (isTerminalMarker(parsed.data) && isRunningMarker(next)) return true;
  } catch {
    // ignore read/parse issues
  }
  return false;
}

async function writeJsonAtomic(filePath: string, value: ExecutionRunMarker): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      if (await shouldSkipOverwriteForTerminalMarker(filePath, value)) {
        try {
          await unlink(tmpPath);
        } catch {
          // ignore
        }
        return;
      }
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        if (await shouldSkipOverwriteForTerminalMarker(filePath, value)) {
          try {
            await unlink(tmpPath);
          } catch {
            // ignore
          }
          return;
        }
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
  const dir = resolveExecutionRunMarkerDir();
  try {
    await unlink(resolveExecutionRunMarkerPath(runId));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[executionRunRegistry] Failed to remove marker run-${runId}.json`, e);
    }
  }

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`run-${runId}.json.tmp-`))
        .map(async (entry) => {
          try {
            await unlink(join(dir, entry));
          } catch (error) {
            const unlinkErr = error as NodeJS.ErrnoException;
            if (unlinkErr?.code !== 'ENOENT') {
              logger.debug(`[executionRunRegistry] Failed to remove temp marker ${entry}`, error);
            }
          }
        }),
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[executionRunRegistry] Failed to scan temp markers for run-${runId}.json`, e);
    }
  }
}

export async function listExecutionRunMarkers(): Promise<ExecutionRunMarker[]> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const entries = await readdir(dir);
  const recovered = new Map<string, Readonly<{ marker: ExecutionRunMarker; isCanonical: boolean }>>();
  for (const entry of entries) {
    if (!isExecutionRunMarkerEntry(entry)) continue;
    const path = join(dir, entry);
    const marker = await readExecutionRunMarkerFile(path);
    if (!marker) continue;

    const current = recovered.get(marker.runId);
    const nextIsCanonical = isCanonicalExecutionRunMarkerEntry(entry);
    if (!current) {
      recovered.set(marker.runId, { marker, isCanonical: nextIsCanonical });
      continue;
    }
    if (
      shouldReplaceRecoveredMarker({
        current: current.marker,
        currentIsCanonical: current.isCanonical,
        next: marker,
        nextIsCanonical,
      })
    ) {
      recovered.set(marker.runId, { marker, isCanonical: nextIsCanonical });
    }
  }

  const out = Array.from(recovered.values(), (entry) => entry.marker);
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
