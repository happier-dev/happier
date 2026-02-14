import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';

const ExecutionRunMarkerSchema = z.object({
  // Safety/filtering: only accept markers for the current happyHomeDir.
  happyHomeDir: z.string().min(1),

  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  happySessionId: z.string().min(1),

  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: z.enum(['review', 'plan', 'delegate', 'voice_agent']),
  backendId: z.string().min(1),

  runClass: z.enum(['bounded', 'long_lived']),
  ioMode: z.enum(['request_response', 'streaming']),
  retentionPolicy: z.enum(['ephemeral', 'resumable']),

  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timeout']),
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),

  summary: z.string().max(20_000).optional(),
  errorCode: z.string().max(200).optional(),
  childVendorSessionId: z.string().min(1).nullable().optional(),
});

export type ExecutionRunMarker = z.infer<typeof ExecutionRunMarkerSchema>;

function resolveExecutionRunMarkerDir(): string {
  return join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
}

function resolveExecutionRunMarkerPath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `run-${runId}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
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
