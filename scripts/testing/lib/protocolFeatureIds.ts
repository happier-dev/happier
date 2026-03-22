import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function extractFeatureIds(catalogText: string): string[] {
  const ids = new Set<string>();
  const matches = catalogText.matchAll(/^\s{2}(?:'([^']+)'|([A-Za-z][A-Za-z0-9.]*)):\s*\{$/gm);
  for (const match of matches) {
    const featureId = match[1] ?? match[2];
    if (featureId) {
      ids.add(featureId);
    }
  }
  return [...ids];
}

export const FEATURE_IDS = Object.freeze(
  extractFeatureIds(
    readFileSync(join(process.cwd(), 'packages/protocol/src/features/catalog.ts'), 'utf8'),
  ),
);
