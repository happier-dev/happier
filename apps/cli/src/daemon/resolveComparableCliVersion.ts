import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectPath } from '@/projectPath';

type ResolveComparableCliVersionOptions = {
  fallbackVersion: string;
  projectRootPath?: string;
  readFileSyncImpl?: typeof readFileSync;
};

export function resolveComparableCliVersion(options: ResolveComparableCliVersionOptions): string {
  const fallbackVersion = String(options.fallbackVersion ?? '').trim();
  if (!fallbackVersion) {
    throw new Error('fallbackVersion is required');
  }

  const readFile = options.readFileSyncImpl ?? readFileSync;
  const projectRootPath = String(options.projectRootPath ?? projectPath()).trim();
  if (!projectRootPath) return fallbackVersion;

  try {
    const packageJson = JSON.parse(readFile(join(projectRootPath, 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    const diskVersion = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
    return diskVersion || fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}
