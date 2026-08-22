import type { RunDirs } from '../../runDir';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StressErrorBuckets, StressLatencySummary } from '../scenarios/stressScenarioRuntime';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { writeStressRunSummary, type StressScenarioStatus } from './writeStressRunSummary';
import { writeStressScenarioManifest } from './writeStressScenarioManifest';

function serializeError(error: unknown): { name?: string; message: string; stack?: string } | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    message: String(error),
  };
}

function classifyFailure(error: unknown): 'none' | 'flaky' | 'deterministic' | 'unknown' {
  if (!error) return 'none';
  if (error instanceof Error && /^FLAKY:/u.test(error.message)) {
    return 'flaky';
  }
  if (error instanceof Error && /^DETERMINISTIC:/u.test(error.message)) {
    return 'deterministic';
  }
  return 'unknown';
}

function shouldPreserveTopologyOnFailure(config: StressConfig): boolean {
  return config.artifacts.keepTopologyOnFailure || config.artifacts.saveArtifactsOnSuccess;
}

export async function finalizeStressScenario(params: {
  run: RunDirs;
  testDir: string;
  testName: string;
  target: StartedStressTarget;
  config: StressConfig;
  startedAt: string;
  endedAt?: string;
  sessionIds?: string[];
  seed?: number;
  env?: Record<string, string | undefined>;
  status: StressScenarioStatus;
  counts: Record<string, number>;
  latencies?: Partial<StressLatencySummary>;
  failures?: Record<string, number>;
  errors?: StressErrorBuckets;
  metrics?: Record<string, unknown>;
  error?: unknown;
}): Promise<{ summaryFile: string; manifestFile: string }> {
  const endedAt = params.endedAt ?? new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(params.startedAt));
  const failureClassification = params.status === 'passed' ? 'none' : classifyFailure(params.error);

  const summaryFile = writeStressRunSummary({
    testDir: params.testDir,
    scenarioName: params.testName,
    targetMode: params.target.mode,
    baseUrl: params.target.baseUrl,
    seed: params.seed,
    status: params.status,
    startedAt: params.startedAt,
    endedAt,
    durationMs,
    resolvedConfig: params.config as unknown as Record<string, unknown>,
    counts: params.counts,
    latencies: params.latencies,
    failures: params.failures,
    errors: params.errors,
    metrics: params.metrics,
    error: serializeError(params.error),
    summaryOutputPath: params.config.artifacts.summaryOutputPath,
  });

  if (params.status === 'failed' || params.config.artifacts.saveArtifactsOnSuccess) {
    await params.target.collectDiagnostics();
  }

  if (params.status === 'failed') {
    if (shouldPreserveTopologyOnFailure(params.config)) {
      params.target.preserveForInspection();
    }
  }

  const manifestFile = writeStressScenarioManifest({
    run: params.run,
    testDir: params.testDir,
    testName: params.testName,
    target: params.target,
    config: params.config,
    startedAt: params.startedAt,
    endedAt,
    sessionIds: params.sessionIds,
    seed: params.seed,
    env: params.env,
    summaryFile,
    status: params.status,
    failureClassification,
    latencies: params.latencies,
    errors: params.errors,
  });

  return { summaryFile, manifestFile };
}
