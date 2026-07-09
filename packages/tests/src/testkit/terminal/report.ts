import type { TerminalWorkloadId } from './workloads';

export type TerminalRendererUnderTest =
  | 'machine-rpc-base64'
  | 'xterm-web'
  | 'xterm-webview'
  | 'ios-ghosttykit'
  | 'android-termux'
  | 'synthetic-byte-roundtrip';

export type TerminalLossCounters = Readonly<{
  gaps: number;
  truncations: number;
  droppedFrames: number;
}>;

export type TerminalAckLatencySummary = Readonly<{
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}>;

export type TerminalBenchmarkSample = Readonly<{
  renderer: TerminalRendererUnderTest;
  workloadId: TerminalWorkloadId;
  decodedBytes: number;
  durationMs: number;
  throughputMiBps: number;
  ackLatency: TerminalAckLatencySummary;
  loss: TerminalLossCounters;
  memoryHighWaterBytes?: number;
}>;

export type TerminalBenchmarkReport = Readonly<{
  suite: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  samples: readonly TerminalBenchmarkSample[];
  totals: Readonly<{
    samples: number;
    decodedBytes: number;
    loss: TerminalLossCounters;
  }>;
}>;

export type TerminalBenchmarkComparisonMetric =
  | 'throughputMiBps'
  | 'lossEvents'
  | 'missingSample';

export type TerminalBenchmarkComparisonRegression = Readonly<{
  metric: TerminalBenchmarkComparisonMetric;
  renderer: TerminalRendererUnderTest;
  workloadId: TerminalWorkloadId;
  baseline: number;
  candidate: number;
  threshold: number;
}>;

export type TerminalBenchmarkComparison = Readonly<{
  status: 'passed' | 'failed';
  baselineSuite: string;
  candidateSuite: string;
  comparedSamples: number;
  regressions: readonly TerminalBenchmarkComparisonRegression[];
}>;

export type TerminalBenchmarkComparisonThresholds = Readonly<{
  minThroughputRatio?: number;
  maxAdditionalLossEvents?: number;
  requireSameSampleSet?: boolean;
}>;

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer: ${value}`);
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}

function summarizeAckLatency(samples: readonly number[]): TerminalAckLatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

export function summarizeTerminalSample(params: Readonly<{
  renderer: TerminalRendererUnderTest;
  workloadId: TerminalWorkloadId;
  decodedBytes: number;
  durationMs: number;
  ackLatenciesMs: readonly number[];
  gaps?: number;
  truncations?: number;
  droppedFrames?: number;
  memoryHighWaterBytes?: number;
}>): TerminalBenchmarkSample {
  assertNonNegativeInteger('decodedBytes', params.decodedBytes);
  assertNonNegativeInteger('durationMs', params.durationMs);
  const gaps = params.gaps ?? 0;
  const truncations = params.truncations ?? 0;
  const droppedFrames = params.droppedFrames ?? 0;
  assertNonNegativeInteger('gaps', gaps);
  assertNonNegativeInteger('truncations', truncations);
  assertNonNegativeInteger('droppedFrames', droppedFrames);

  return {
    renderer: params.renderer,
    workloadId: params.workloadId,
    decodedBytes: params.decodedBytes,
    durationMs: params.durationMs,
    throughputMiBps: params.durationMs > 0
      ? (params.decodedBytes / (1024 * 1024)) / (params.durationMs / 1000)
      : 0,
    ackLatency: summarizeAckLatency(params.ackLatenciesMs),
    loss: {
      gaps,
      truncations,
      droppedFrames,
    },
    ...(params.memoryHighWaterBytes === undefined ? {} : { memoryHighWaterBytes: params.memoryHighWaterBytes }),
  };
}

function sumLoss(samples: readonly TerminalBenchmarkSample[]): TerminalLossCounters {
  return samples.reduce<TerminalLossCounters>(
    (total, sample) => ({
      gaps: total.gaps + sample.loss.gaps,
      truncations: total.truncations + sample.loss.truncations,
      droppedFrames: total.droppedFrames + sample.loss.droppedFrames,
    }),
    { gaps: 0, truncations: 0, droppedFrames: 0 },
  );
}

export function buildTerminalBenchmarkReport(params: Readonly<{
  suite: string;
  startedAt: string;
  endedAt: string;
  samples: readonly TerminalBenchmarkSample[];
}>): TerminalBenchmarkReport {
  const durationMs = Math.max(0, Date.parse(params.endedAt) - Date.parse(params.startedAt));
  return {
    suite: params.suite,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    durationMs,
    samples: params.samples,
    totals: {
      samples: params.samples.length,
      decodedBytes: params.samples.reduce((sum, sample) => sum + sample.decodedBytes, 0),
      loss: sumLoss(params.samples),
    },
  };
}

export function assertTerminalReportHasNoLoss(report: TerminalBenchmarkReport): void {
  const { gaps, truncations, droppedFrames } = report.totals.loss;
  if (gaps > 0 || truncations > 0 || droppedFrames > 0) {
    throw new Error(
      `terminal report recorded byte loss: gaps=${gaps} truncations=${truncations} droppedFrames=${droppedFrames}`,
    );
  }
}

export function formatTerminalBenchmarkReportSummary(report: TerminalBenchmarkReport): string {
  const sampleWord = report.totals.samples === 1 ? 'sample' : 'samples';
  return [
    `${report.suite}: ${report.totals.samples} ${sampleWord}`,
    `durationMs=${report.durationMs}`,
    `decoded=${report.totals.decodedBytes}`,
    `loss=${report.totals.loss.gaps}/${report.totals.loss.truncations}/${report.totals.loss.droppedFrames}`,
  ].join(' ');
}

type AggregatedSample = Readonly<{
  renderer: TerminalRendererUnderTest;
  workloadId: TerminalWorkloadId;
  averageThroughputMiBps: number;
  lossEvents: number;
}>;

function aggregateKey(sample: Pick<TerminalBenchmarkSample, 'renderer' | 'workloadId'>): string {
  return `${sample.renderer}:${sample.workloadId}`;
}

function countLossEvents(loss: TerminalLossCounters): number {
  return loss.gaps + loss.truncations + loss.droppedFrames;
}

function aggregateSamples(report: TerminalBenchmarkReport): Map<string, AggregatedSample> {
  const buckets = new Map<string, TerminalBenchmarkSample[]>();
  for (const sample of report.samples) {
    const key = aggregateKey(sample);
    buckets.set(key, [...(buckets.get(key) ?? []), sample]);
  }

  const aggregated = new Map<string, AggregatedSample>();
  for (const [key, samples] of buckets) {
    const [first] = samples;
    if (!first) continue;
    aggregated.set(key, {
      renderer: first.renderer,
      workloadId: first.workloadId,
      averageThroughputMiBps: samples.reduce((sum, sample) => sum + sample.throughputMiBps, 0) / samples.length,
      lossEvents: samples.reduce((sum, sample) => sum + countLossEvents(sample.loss), 0),
    });
  }
  return aggregated;
}

function assertRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number: ${value}`);
  }
}

export function compareTerminalBenchmarkReports(
  baseline: TerminalBenchmarkReport,
  candidate: TerminalBenchmarkReport,
  thresholds: TerminalBenchmarkComparisonThresholds = {},
): TerminalBenchmarkComparison {
  const minThroughputRatio = thresholds.minThroughputRatio ?? 0.75;
  const maxAdditionalLossEvents = thresholds.maxAdditionalLossEvents ?? 0;
  const requireSameSampleSet = thresholds.requireSameSampleSet ?? true;
  assertRatio('minThroughputRatio', minThroughputRatio);
  assertNonNegativeInteger('maxAdditionalLossEvents', maxAdditionalLossEvents);

  const baselineSamples = aggregateSamples(baseline);
  const candidateSamples = aggregateSamples(candidate);
  const regressions: TerminalBenchmarkComparisonRegression[] = [];
  let comparedSamples = 0;

  for (const [key, baselineSample] of baselineSamples) {
    const candidateSample = candidateSamples.get(key);
    if (!candidateSample) {
      if (requireSameSampleSet) {
        regressions.push({
          metric: 'missingSample',
          renderer: baselineSample.renderer,
          workloadId: baselineSample.workloadId,
          baseline: 1,
          candidate: 0,
          threshold: 1,
        });
      }
      continue;
    }

    comparedSamples += 1;
    const minCandidateThroughput = baselineSample.averageThroughputMiBps * minThroughputRatio;
    if (candidateSample.averageThroughputMiBps < minCandidateThroughput) {
      regressions.push({
        metric: 'throughputMiBps',
        renderer: baselineSample.renderer,
        workloadId: baselineSample.workloadId,
        baseline: baselineSample.averageThroughputMiBps,
        candidate: candidateSample.averageThroughputMiBps,
        threshold: minCandidateThroughput,
      });
    }

    const additionalLossEvents = candidateSample.lossEvents - baselineSample.lossEvents;
    if (additionalLossEvents > maxAdditionalLossEvents) {
      regressions.push({
        metric: 'lossEvents',
        renderer: baselineSample.renderer,
        workloadId: baselineSample.workloadId,
        baseline: baselineSample.lossEvents,
        candidate: candidateSample.lossEvents,
        threshold: baselineSample.lossEvents + maxAdditionalLossEvents,
      });
    }
  }

  return {
    status: regressions.length === 0 ? 'passed' : 'failed',
    baselineSuite: baseline.suite,
    candidateSuite: candidate.suite,
    comparedSamples,
    regressions,
  };
}

export function formatTerminalBenchmarkComparisonSummary(
  comparison: TerminalBenchmarkComparison,
): string {
  return [
    `terminal benchmark comparison: ${comparison.status}`,
    `baseline=${comparison.baselineSuite}`,
    `candidate=${comparison.candidateSuite}`,
    `compared=${comparison.comparedSamples}`,
    `regressions=${comparison.regressions.length}`,
  ].join(' ');
}
