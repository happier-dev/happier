import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { writeJsonArtifact } from '../../artifacts';
import {
  flattenStressErrorBuckets,
  type StressErrorBuckets,
  summarizeLatencySamples,
  type StressLatencySummary,
} from '../scenarios/stressScenarioRuntime';

export type StressScenarioStatus = 'passed' | 'failed';

export function writeStressRunSummary(params: {
  testDir: string;
  scenarioName: string;
  targetMode: 'light' | 'full-compose' | 'external';
  baseUrl: string;
  seed?: number;
  status: StressScenarioStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  resolvedConfig: Record<string, unknown>;
  counts: Record<string, number>;
  latencies?: Partial<StressLatencySummary>;
  failures?: Record<string, number>;
  errors?: StressErrorBuckets;
  metrics?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
  summaryOutputPath?: string;
}): string {
  const summary = {
    scenarioName: params.scenarioName,
    targetMode: params.targetMode,
    baseUrl: params.baseUrl,
    seed: params.seed,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    durationMs: params.durationMs,
    resolvedConfig: params.resolvedConfig,
    counts: params.counts,
    latencies: normalizeLatencies(params.latencies),
    failures: params.failures ?? flattenStressErrorBuckets(params.errors),
    errors: params.errors ?? {},
    metrics: params.metrics ?? {},
    ...(params.error ? { error: params.error } : {}),
  };

  const summaryPath = writeJsonArtifact(params.testDir, 'stress-summary.json', summary);
  if (params.summaryOutputPath) {
    const mirroredPath = resolve(params.summaryOutputPath);
    mkdirSync(dirname(mirroredPath), { recursive: true });
    writeFileSync(mirroredPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  return summaryPath;
}

function normalizeLatencies(latencies: Partial<StressLatencySummary> | undefined): StressLatencySummary {
  if (!latencies) {
    return summarizeLatencySamples([]);
  }

  const canonical = summarizeLatencySamples([]);
  return {
    p50Ms: latencies.p50Ms ?? canonical.p50Ms,
    p95Ms: latencies.p95Ms ?? canonical.p95Ms,
    p99Ms: latencies.p99Ms ?? canonical.p99Ms,
    maxMs: latencies.maxMs ?? canonical.maxMs,
  };
}
