import { getTerminalWorkload, type TerminalWorkloadId } from './workloads';

export type TerminalRendererUnderTest =
  | 'machine-rpc-base64'
  | 'xterm-web'
  | 'xterm-webview'
  | 'ios-ghosttykit'
  | 'android-termux'
  | 'canonical-base64-codec';

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
  timingBoundary: 'parser-write-complete' | 'display-observed';
  observationSource: 'transport-process' | 'automated-browser' | 'loaded-device';
  throughputMiBps: number;
  ackLatency: TerminalAckLatencySummary;
  loss: TerminalLossCounters;
  memoryHighWaterBytes?: number;
  environment?: Readonly<{
    platform: string;
    targetId: string;
    applicationId?: string;
    buildEvidenceId?: string;
  }>;
}>;

export type TerminalBenchmarkReport = Readonly<{
  measurementScope: 'transport-codec' | 'renderer';
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

export type TerminalRendererComparison = Readonly<{
  status: 'passed' | 'failed';
  baselineRenderer: TerminalRendererUnderTest;
  candidateRenderer: TerminalRendererUnderTest;
  timingBoundary: TerminalBenchmarkSample['timingBoundary'];
  minThroughputRatio: number;
  minSamplesPerWorkload: number;
  comparedWorkloads: number;
  regressions: readonly Readonly<{
    workloadId: TerminalWorkloadId;
    reason: 'missing-baseline' | 'missing-candidate' | 'insufficient-samples' | 'environment-mismatch' | 'throughput-ratio';
    observedRatio: number;
  }>[];
}>;

const TERMINAL_RENDERERS = new Set<TerminalRendererUnderTest>([
  'machine-rpc-base64',
  'xterm-web',
  'xterm-webview',
  'ios-ghosttykit',
  'android-termux',
  'canonical-base64-codec',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

/** Parses benchmark artifacts at the evidence boundary instead of trusting a TypeScript cast. */
export function parseTerminalBenchmarkReport(value: unknown): TerminalBenchmarkReport {
  if (!isRecord(value) || value.measurementScope !== 'renderer' || typeof value.suite !== 'string'
    || !Number.isFinite(Date.parse(String(value.startedAt)))
    || !Number.isFinite(Date.parse(String(value.endedAt)))
    || !Number.isInteger(value.durationMs) || (value.durationMs as number) < 0
    || !Array.isArray(value.samples) || !isRecord(value.totals)) {
    throw new Error('invalid terminal benchmark report root');
  }
  const expectedDuration = Math.max(0, Date.parse(String(value.endedAt)) - Date.parse(String(value.startedAt)));
  if (value.durationMs !== expectedDuration) throw new Error('terminal benchmark duration does not match its interval');

  const samples = value.samples.map((sample, index): TerminalBenchmarkSample => {
    if (!isRecord(sample) || !TERMINAL_RENDERERS.has(sample.renderer as TerminalRendererUnderTest)) {
      throw new Error(`invalid terminal benchmark renderer at sample ${index}`);
    }
    try { getTerminalWorkload(sample.workloadId as TerminalWorkloadId); } catch {
      throw new Error(`invalid terminal benchmark workload at sample ${index}`);
    }
    if (!Number.isInteger(sample.decodedBytes) || (sample.decodedBytes as number) < 0
      || !Number.isInteger(sample.durationMs) || (sample.durationMs as number) <= 0
      || (sample.timingBoundary !== 'parser-write-complete' && sample.timingBoundary !== 'display-observed')
      || !['transport-process', 'automated-browser', 'loaded-device'].includes(String(sample.observationSource))
      || !isFiniteNonNegative(sample.throughputMiBps)
      || !isRecord(sample.ackLatency) || !isRecord(sample.loss)) {
      throw new Error(`invalid terminal benchmark sample ${index}`);
    }
    const expectedThroughput = ((sample.decodedBytes as number) / (1024 * 1024)) / ((sample.durationMs as number) / 1000);
    if (!sameNumber(sample.throughputMiBps, expectedThroughput)) {
      throw new Error(`terminal benchmark throughput is not derived from bytes/duration at sample ${index}`);
    }
    for (const key of ['samples', 'p50Ms', 'p95Ms', 'maxMs'] as const) {
      if (!isFiniteNonNegative(sample.ackLatency[key])) throw new Error(`invalid ACK latency at sample ${index}`);
    }
    for (const key of ['gaps', 'truncations', 'droppedFrames'] as const) {
      if (!Number.isInteger(sample.loss[key]) || (sample.loss[key] as number) < 0) {
        throw new Error(`invalid loss counter at sample ${index}`);
      }
    }
    if (sample.environment !== undefined && (!isRecord(sample.environment)
      || typeof sample.environment.platform !== 'string'
      || typeof sample.environment.targetId !== 'string'
      || (sample.environment.applicationId !== undefined && typeof sample.environment.applicationId !== 'string')
      || (sample.environment.buildEvidenceId !== undefined && typeof sample.environment.buildEvidenceId !== 'string'))) {
      throw new Error(`invalid terminal benchmark environment at sample ${index}`);
    }
    return sample as TerminalBenchmarkSample;
  });

  const loss = sumLoss(samples);
  const decodedBytes = samples.reduce((sum, sample) => sum + sample.decodedBytes, 0);
  if (value.totals.samples !== samples.length || value.totals.decodedBytes !== decodedBytes
    || !isRecord(value.totals.loss)
    || value.totals.loss.gaps !== loss.gaps
    || value.totals.loss.truncations !== loss.truncations
    || value.totals.loss.droppedFrames !== loss.droppedFrames) {
    throw new Error('terminal benchmark totals do not match samples');
  }
  return value as TerminalBenchmarkReport;
}

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
  timingBoundary?: TerminalBenchmarkSample['timingBoundary'];
  observationSource?: TerminalBenchmarkSample['observationSource'];
  environment?: TerminalBenchmarkSample['environment'];
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
    timingBoundary: params.timingBoundary ?? 'parser-write-complete',
    observationSource: params.observationSource ?? 'transport-process',
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
    ...(params.environment === undefined ? {} : { environment: params.environment }),
  };
}

export function compareTerminalRenderers(
  report: TerminalBenchmarkReport,
  input: Readonly<{
    baselineRenderer: TerminalRendererUnderTest;
    candidateRenderer: TerminalRendererUnderTest;
    timingBoundary: TerminalBenchmarkSample['timingBoundary'];
    minThroughputRatio: number;
    minSamplesPerWorkload?: number;
  }>,
): TerminalRendererComparison {
  assertRatio('minThroughputRatio', input.minThroughputRatio);
  const minSamplesPerWorkload = input.minSamplesPerWorkload ?? 3;
  assertNonNegativeInteger('minSamplesPerWorkload', minSamplesPerWorkload);
  if (minSamplesPerWorkload < 1) throw new Error('minSamplesPerWorkload must be at least 1');

  const regressions: TerminalRendererComparison['regressions'][number][] = [];
  let comparedWorkloads = 0;
  for (const workloadId of new Set(report.samples.map((sample) => sample.workloadId))) {
    const baseline = report.samples.filter((sample) => sample.renderer === input.baselineRenderer
      && sample.workloadId === workloadId && sample.timingBoundary === input.timingBoundary);
    const candidate = report.samples.filter((sample) => sample.renderer === input.candidateRenderer
      && sample.workloadId === workloadId && sample.timingBoundary === input.timingBoundary);
    if (baseline.length === 0) {
      regressions.push({ workloadId, reason: 'missing-baseline', observedRatio: 0 });
      continue;
    }
    if (candidate.length === 0) {
      regressions.push({ workloadId, reason: 'missing-candidate', observedRatio: 0 });
      continue;
    }
    if (baseline.length < minSamplesPerWorkload || candidate.length < minSamplesPerWorkload) {
      regressions.push({ workloadId, reason: 'insufficient-samples', observedRatio: 0 });
      continue;
    }
    const environmentKey = (sample: TerminalBenchmarkSample) => JSON.stringify(sample.environment ?? null);
    if (new Set([...baseline, ...candidate].map(environmentKey)).size !== 1) {
      regressions.push({ workloadId, reason: 'environment-mismatch', observedRatio: 0 });
      continue;
    }
    const average = (samples: readonly TerminalBenchmarkSample[]) => (
      samples.reduce((sum, sample) => sum + sample.throughputMiBps, 0) / samples.length
    );
    const baselineThroughput = average(baseline);
    const observedRatio = baselineThroughput > 0 ? average(candidate) / baselineThroughput : 0;
    comparedWorkloads += 1;
    if (observedRatio < input.minThroughputRatio) {
      regressions.push({ workloadId, reason: 'throughput-ratio', observedRatio });
    }
  }
  return {
    status: regressions.length === 0 ? 'passed' : 'failed',
    baselineRenderer: input.baselineRenderer,
    candidateRenderer: input.candidateRenderer,
    timingBoundary: input.timingBoundary,
    minThroughputRatio: input.minThroughputRatio,
    minSamplesPerWorkload,
    comparedWorkloads,
    regressions,
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
  measurementScope?: TerminalBenchmarkReport['measurementScope'];
  suite: string;
  startedAt: string;
  endedAt: string;
  samples: readonly TerminalBenchmarkSample[];
}>): TerminalBenchmarkReport {
  const durationMs = Math.max(0, Date.parse(params.endedAt) - Date.parse(params.startedAt));
  return {
    measurementScope: params.measurementScope ?? 'renderer',
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
    `scope=${report.measurementScope}`,
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
  if (baseline.measurementScope !== candidate.measurementScope) {
    throw new Error(
      `terminal benchmark scope mismatch: baseline=${baseline.measurementScope} candidate=${candidate.measurementScope}`,
    );
  }
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
