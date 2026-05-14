import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

const DEFAULT_TRANSIENT_SESSION_MEDIA_READ_ALLOWANCE_TTL_MS = 60_000;

export type TransientSessionMediaReadFileGrant = Readonly<{
  path: string;
  realPath: string;
}>;

export type TransientSessionMediaReadAllowance = Readonly<{
  grantReadFiles: (files: readonly string[]) => void;
  readAllowedReadFiles: () => readonly TransientSessionMediaReadFileGrant[];
  clear: () => void;
}>;

function normalizeReadFile(value: string): TransientSessionMediaReadFileGrant | null {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed) || trimmed.includes('\0')) return null;
  const normalized = normalize(trimmed);
  try {
    const realPath = normalize(realpathSync(normalized));
    return statSync(realPath).isFile() ? { path: normalized, realPath } : null;
  } catch {
    return null;
  }
}

export function createTransientSessionMediaReadAllowance(params?: Readonly<{
  ttlMs?: number;
  now?: () => number;
}>): TransientSessionMediaReadAllowance {
  const ttlMs =
    typeof params?.ttlMs === 'number' && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.trunc(params.ttlMs)
      : DEFAULT_TRANSIENT_SESSION_MEDIA_READ_ALLOWANCE_TTL_MS;
  const now = params?.now ?? (() => Date.now());
  const allowedFilesByPath = new Map<string, Readonly<{
    grant: TransientSessionMediaReadFileGrant;
    expiresAtMs: number;
  }>>();

  const pruneExpired = (): void => {
    const currentTime = now();
    for (const [file, entry] of allowedFilesByPath) {
      if (entry.expiresAtMs <= currentTime) {
        allowedFilesByPath.delete(file);
      }
    }
  };

  return {
    grantReadFiles: (files) => {
      pruneExpired();
      const expiresAtMs = now() + ttlMs;
      for (const file of files) {
        const normalized = normalizeReadFile(file);
        if (normalized) {
          allowedFilesByPath.set(normalized.path, { grant: normalized, expiresAtMs });
        }
      }
    },
    readAllowedReadFiles: () => {
      pruneExpired();
      return [...allowedFilesByPath.values()]
        .map((entry) => entry.grant)
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    clear: () => {
      allowedFilesByPath.clear();
    },
  };
}
