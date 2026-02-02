import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type TestManifest = {
  startedAt: string;
  runId?: string;
  testName?: string;
  seed?: number;
  ports?: { server?: number };
  baseUrl?: string;
  sessionIds?: string[];
  env?: Record<string, string | undefined>;
};

export function writeTestManifest(testDir: string, manifest: TestManifest): string {
  const path = resolve(testDir, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

