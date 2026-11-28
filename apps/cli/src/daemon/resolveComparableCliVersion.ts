import { readFileSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

import { projectPath } from '@/projectPath';

type ResolveComparableCliVersionOptions = {
  fallbackVersion: string;
  projectRootPath?: string;
  readFileSyncImpl?: typeof readFileSync;
};

function createCliVersionReader(options: ResolveComparableCliVersionOptions, rereadOnChange: boolean): () => string {
  const fallbackVersion = String(options.fallbackVersion ?? '').trim();
  if (!fallbackVersion) {
    throw new Error('fallbackVersion is required');
  }

  const readFile = options.readFileSyncImpl ?? readFileSync;
  const projectRootPath = String(options.projectRootPath ?? projectPath()).trim();
  if (!projectRootPath) return () => fallbackVersion;
  const manifestPath = join(projectRootPath, 'package.json');
  let lastRead: { stat: BigIntStats; version: string } | undefined;

  return () => {
    try {
      // Follow the path on every beat so in-place upgrades and atomically replaced
      // files or directories are both visible at the existing recovery cadence.
      const stat = rereadOnChange ? statSync(manifestPath, { bigint: true }) : undefined;
      if (stat && lastRead &&
        stat.dev === lastRead.stat.dev && stat.ino === lastRead.stat.ino &&
        stat.size === lastRead.stat.size && stat.mtimeNs === lastRead.stat.mtimeNs &&
        stat.ctimeNs === lastRead.stat.ctimeNs) {
        return lastRead.version;
      }

      const packageJson = JSON.parse(readFile(manifestPath, 'utf-8')) as { version?: unknown };
      const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
      if (stat && version) lastRead = { stat, version };
      return version || fallbackVersion;
    } catch {
      // Installers can briefly leave the path absent or invalid. Retry the read on the next beat.
      lastRead = undefined;
      return fallbackVersion;
    }
  };
}

export function resolveComparableCliVersion(options: ResolveComparableCliVersionOptions): string {
  return createCliVersionReader(options, false)();
}

export function createInstalledCliVersionReader(options: ResolveComparableCliVersionOptions): () => string {
  return createCliVersionReader(options, true);
}
