import { readFileSync } from 'node:fs';

import { flattenStressErrorBuckets, type StressErrorBuckets } from '../scenarios/stressScenarioRuntime';

type StressSummary = Readonly<{
  counts?: Record<string, number>;
  latencies?: Record<string, number>;
  failures?: Record<string, number>;
  errors?: StressErrorBuckets;
}>;

function readSummary(path: string): StressSummary {
  return JSON.parse(readFileSync(path, 'utf8')) as StressSummary;
}

export function compareStressRuns(params: {
  baselineSummaryPath: string;
  candidateSummaryPath: string;
}): Readonly<{
  countsDelta: Record<string, number>;
  latencyDelta: Record<string, number>;
  failureDelta: Record<string, number>;
  errorDelta: Record<string, number>;
}> {
  const baseline = readSummary(params.baselineSummaryPath);
  const candidate = readSummary(params.candidateSummaryPath);

  return {
    countsDelta: diffNumericRecord(baseline.counts, candidate.counts),
    latencyDelta: diffNumericRecord(baseline.latencies, candidate.latencies),
    failureDelta: diffNumericRecord(baseline.failures, candidate.failures),
    errorDelta: diffNumericRecord(flattenStressErrorBuckets(baseline.errors), flattenStressErrorBuckets(candidate.errors)),
  };
}

function diffNumericRecord(
  baseline: Record<string, number> | undefined,
  candidate: Record<string, number> | undefined,
): Record<string, number> {
  const keys = new Set([...Object.keys(baseline ?? {}), ...Object.keys(candidate ?? {})]);
  return Object.fromEntries(
    [...keys].sort().map((key) => [key, (candidate?.[key] ?? 0) - (baseline?.[key] ?? 0)]),
  );
}
