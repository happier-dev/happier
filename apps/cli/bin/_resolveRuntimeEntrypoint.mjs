import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveRuntimeEntrypoint(projectRoot, relativePath) {
  const candidates = [join(projectRoot, 'dist', relativePath), join(projectRoot, 'package-dist', relativePath)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}
