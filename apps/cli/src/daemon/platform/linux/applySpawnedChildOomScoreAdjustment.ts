import { writeFile } from 'node:fs/promises';

const SPAWNED_CHILD_OOM_SCORE_ADJ_ENV_KEY = 'HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ';

function clampOomScoreAdjustment(value: number): number {
  return Math.min(1000, Math.max(-1000, Math.trunc(value)));
}

export function resolveSpawnedChildOomScoreAdjustmentValue(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = String(env[SPAWNED_CHILD_OOM_SCORE_ADJ_ENV_KEY] ?? '').trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  const normalized = clampOomScoreAdjustment(parsed);
  if (normalized <= 0) return null;
  return normalized;
}

export async function applySpawnedChildOomScoreAdjustment(params: Readonly<{
  pid: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
  logDebug?: (message: string, context?: unknown) => void;
  startupSource?: string;
}>): Promise<boolean> {
  const platform = params.platform ?? process.platform;
  if (platform !== 'linux') return false;
  if (!Number.isInteger(params.pid) || params.pid <= 0) return false;

  const value = resolveSpawnedChildOomScoreAdjustmentValue(params.env ?? process.env);
  if (value === null) return false;

  const writeFileImpl = params.writeFile ?? writeFile;
  try {
    await writeFileImpl(`/proc/${params.pid}/oom_score_adj`, `${value}\n`, 'utf8');
    params.logDebug?.('[DAEMON RUN] Applied spawned-child OOM score adjustment', {
      pid: params.pid,
      value,
      startupSource: params.startupSource ?? null,
    });
    return true;
  } catch (error) {
    params.logDebug?.('[DAEMON RUN] Failed to apply spawned-child OOM score adjustment', {
      pid: params.pid,
      value,
      startupSource: params.startupSource ?? null,
      error,
    });
    return false;
  }
}
