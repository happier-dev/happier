import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isPidPresent } from '@happier-dev/cli-common/process';
import {
  reclaimJsonOwnerFileLockSnapshot,
  withJsonOwnerFileLock,
} from '@/utils/fs/jsonOwnerFileLock';

import type { PluginStorePaths } from './paths';

const PLUGIN_STORE_LOCK_TIMEOUT_MS_ENV = 'HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS';
const PLUGIN_STORE_LOCK_STALE_AFTER_MS_ENV = 'HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS';

const DEFAULT_PLUGIN_STORE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_PLUGIN_STORE_LOCK_STALE_AFTER_MS = 120_000;

export const MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME = 'marketplace-source-registry.v1.lock';
export const NPM_REGISTRY_PROFILES_LOCK_NAME = 'npm-registry-profiles.v1.lock';
export const NPM_REGISTRY_SECRETS_LOCK_NAME = 'npm-registry-secrets.v1.lock';
export const NPM_REGISTRY_AUTHORITY_LOCK_NAME = 'npm-registry-authority.v1.lock';

type PredecessorPluginStoreLockRecord = Readonly<{
  pid: number;
  createdAtMs: number;
}>;

// Compatibility basis: the pre-consolidation plugin-store writer persisted exactly this shape.
// Remove after supported mixed-version CLIs can no longer leave these records for a newer CLI.
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parsePredecessorPluginStoreLock(raw: string): PredecessorPluginStoreLockRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, ['pid', 'createdAtMs'])) return null;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (!Number.isSafeInteger(record.createdAtMs) || (record.createdAtMs as number) < 0) return null;
    return {
      pid: record.pid as number,
      createdAtMs: Math.trunc(record.createdAtMs as number),
    };
  } catch {
    return null;
  }
}

async function waitForPredecessorPluginStoreLock(params: Readonly<{
  lockFilePath: string;
  deadlineMs: number;
  errorCode: string;
}>): Promise<void> {
  for (;;) {
    let raw: string;
    try {
      raw = await readFile(params.lockFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      throw error;
    }

    const predecessor = parsePredecessorPluginStoreLock(raw);
    if (!predecessor) return;

    if (!isPidPresent(predecessor.pid)) {
      const reclaimed = await reclaimJsonOwnerFileLockSnapshot(params.lockFilePath, raw);
      if (reclaimed === 'ownership_unknown') {
        throw new Error(`${params.errorCode}_compromised`);
      }
      continue;
    }

    const remainingMs = params.deadlineMs - Date.now();
    if (remainingMs <= 0) throw new Error(params.errorCode);
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remainingMs)));
  }
}

function resolvePositiveEnvInt(params: Readonly<{
  envName: string;
  defaultValue: number;
  maxValue: number;
}>): number {
  const raw = process.env[params.envName]?.trim();
  if (!raw) {
    return params.defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${params.envName} value: ${raw}`);
  }

  return Math.min(Math.floor(parsed), params.maxValue);
}

function resolvePluginStoreLockTimeoutMs(): number {
  return resolvePositiveEnvInt({
    envName: PLUGIN_STORE_LOCK_TIMEOUT_MS_ENV,
    defaultValue: DEFAULT_PLUGIN_STORE_LOCK_TIMEOUT_MS,
    maxValue: 60_000,
  });
}

function resolvePluginStoreLockStaleAfterMs(): number {
  return resolvePositiveEnvInt({
    envName: PLUGIN_STORE_LOCK_STALE_AFTER_MS_ENV,
    defaultValue: DEFAULT_PLUGIN_STORE_LOCK_STALE_AFTER_MS,
    maxValue: 3_600_000,
  });
}

export async function withPluginStoreLock<T>(params: Readonly<{
  paths: PluginStorePaths;
  lockName: string;
  fn: () => Promise<T>;
}>): Promise<T> {
  const timeoutMs = resolvePluginStoreLockTimeoutMs();
  const staleAfterMs = resolvePluginStoreLockStaleAfterMs();
  const lockFilePath = join(params.paths.locksDir, params.lockName);
  const deadlineMs = Date.now() + timeoutMs;
  const errorCode = `Timeout acquiring plugin store lock '${params.lockName}' after ${timeoutMs}ms`;

  await waitForPredecessorPluginStoreLock({
    lockFilePath,
    deadlineMs,
    errorCode,
  });

  const remainingTimeoutMs = deadlineMs - Date.now();
  if (remainingTimeoutMs <= 0) throw new Error(errorCode);
  return await withJsonOwnerFileLock({
    lockPath: lockFilePath,
    timeoutMs: remainingTimeoutMs,
    // A predecessor can publish after the compatibility read and before canonical publication.
    // Require any newly published unrecognized record to age for longer than this bounded attempt;
    // exact current-schema dead owners remain reclaimable through PID/process-start evidence.
    staleAfterMs: Math.max(staleAfterMs, remainingTimeoutMs + 1),
    errorCode,
  }, params.fn);
}
