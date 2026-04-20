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
  targetMode?: 'light' | 'full-compose' | 'external';
  topology?: {
    kind: 'light' | 'full-compose' | 'external';
    composeProjectName?: string;
    services?: string[];
    expectedApiReplicas?: number;
    expectedWorkerReplicas?: number;
    resolvedApiReplicas?: number;
    resolvedWorkerReplicas?: number;
    baseUrl?: string;
    ports?: Record<string, number | undefined>;
  };
  scenario?: {
    name: string;
    resolvedConfig?: Record<string, unknown>;
  };
  artifacts?: {
    composeFile?: string;
    gatewayConfigFile?: string;
    summaryFile?: string;
    dockerLogsFile?: string;
    dockerPsFile?: string;
  };
  results?: {
    status: 'passed' | 'failed' | 'running';
    startedAt: string;
    endedAt?: string;
    failureClassification?: 'none' | 'flaky' | 'deterministic' | 'unknown';
  };
};

export function writeTestManifest(testDir: string, manifest: TestManifest): string {
  const path = resolve(testDir, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}
