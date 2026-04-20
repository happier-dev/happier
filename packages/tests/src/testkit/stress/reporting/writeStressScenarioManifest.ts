import type { RunDirs } from '../../runDir';
import type { StressErrorBuckets, StressLatencySummary } from '../scenarios/stressScenarioRuntime';
import { writeTestManifest } from '../../manifest';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import type { StressScenarioStatus } from './writeStressRunSummary';

export function writeStressScenarioManifest(params: {
  run: RunDirs;
  testDir: string;
  testName: string;
  target: StartedStressTarget;
  config: StressConfig;
  startedAt: string;
  endedAt: string;
  sessionIds?: string[];
  seed?: number;
  env?: Record<string, string | undefined>;
  summaryFile?: string;
  status?: StressScenarioStatus | 'running';
  failureClassification?: 'none' | 'flaky' | 'deterministic' | 'unknown';
  latencies?: Partial<StressLatencySummary>;
  errors?: StressErrorBuckets;
}): string {
  return writeTestManifest(params.testDir, {
    startedAt: params.startedAt,
    runId: params.run.runId,
    testName: params.testName,
    seed: params.seed,
    baseUrl: params.target.baseUrl,
    sessionIds: params.sessionIds,
    env: params.env,
    targetMode: params.target.mode,
    topology: params.target.topology,
    scenario: {
      name: params.testName,
      resolvedConfig: params.config as unknown as Record<string, unknown>,
    },
    artifacts: {
      composeFile: params.target.artifacts?.composeFile,
      gatewayConfigFile: params.target.artifacts?.gatewayConfigFile,
      summaryFile: params.summaryFile,
      dockerLogsFile: params.target.artifacts?.dockerLogsFile,
      ...(params.target.artifacts?.dockerPsFile ? { dockerPsFile: params.target.artifacts.dockerPsFile } : {}),
    },
    results: {
      status: params.status ?? 'running',
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      failureClassification: params.failureClassification ?? 'unknown',
      ...(params.latencies ? { latency: params.latencies } : {}),
      ...(params.errors ? { errors: params.errors } : {}),
    },
  });
}
