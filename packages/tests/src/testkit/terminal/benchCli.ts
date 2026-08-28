import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
  TerminalStreamBytesFrameSchema,
  decodeTerminalStreamBytesFrame,
  encodeTerminalStreamBytes,
} from '@happier-dev/protocol';

import { concatBytes, splitBytes } from './ansi';
import {
  buildTerminalBenchmarkReport,
  compareTerminalBenchmarkReports,
  formatTerminalBenchmarkComparisonSummary,
  formatTerminalBenchmarkReportSummary,
  summarizeTerminalSample,
  type TerminalBenchmarkReport,
  type TerminalBenchmarkComparisonThresholds,
} from './report';
import {
  getTerminalWorkload,
  listTerminalWorkloads,
  type TerminalWorkloadId,
} from './workloads';

export type TerminalBenchOptions = Readonly<{
  workloads: readonly TerminalWorkloadId[];
  repeat: number;
  frameBytes: number;
  out?: string;
}>;

function parsePositiveInteger(name: string, raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(name: string, raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseWorkloadId(raw: string | undefined): TerminalWorkloadId {
  if (!raw) {
    throw new Error('--workload requires a workload id');
  }
  if (!listTerminalWorkloads().some((workload) => workload.id === raw)) {
    throw new Error(`Unknown terminal workload: ${raw}`);
  }
  return raw as TerminalWorkloadId;
}

function parseNonNegativeRatio(name: string, raw: string | undefined): number {
  const value = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

export function parseTerminalBenchArgs(args: readonly string[]): TerminalBenchOptions {
  const workloads: TerminalWorkloadId[] = [];
  let repeat = 1;
  let frameBytes = 64_000;
  let out: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--workload') {
      index += 1;
      workloads.push(parseWorkloadId(args[index]));
      continue;
    }
    if (arg === '--repeat') {
      index += 1;
      repeat = parsePositiveInteger('--repeat', args[index]);
      continue;
    }
    if (arg === '--frame-bytes') {
      index += 1;
      frameBytes = parsePositiveInteger('--frame-bytes', args[index]);
      continue;
    }
    if (arg === '--out') {
      index += 1;
      out = args[index];
      if (!out) {
        throw new Error('--out requires a path');
      }
      continue;
    }
    throw new Error(`Unknown terminal bench argument: ${arg}`);
  }

  return {
    workloads: workloads.length > 0 ? workloads : listTerminalWorkloads().map((workload) => workload.id),
    repeat,
    frameBytes,
    ...(out ? { out } : {}),
  };
}

function assertCanonicalTerminalFrameBytes(frameBytes: number): number {
  if (!Number.isInteger(frameBytes) || frameBytes < 1 || frameBytes > TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES) {
    throw new Error(
      'terminal stream frame bytes must be an integer from 1 to ' + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
    );
  }
  return frameBytes;
}

function runCanonicalBase64Framing(bytes: Uint8Array, frameBytes: number): Readonly<{
  decodedBytes: number;
  durationMs: number;
  droppedFrames: number;
}> {
  const startedAt = performance.now();
  let byteOffset = 0;
  const decodedFrames = splitBytes(bytes, frameBytes).map((frame, seq) => {
    const currentByteOffset = byteOffset;
    byteOffset += frame.byteLength;
    return decodeTerminalStreamBytesFrame(TerminalStreamBytesFrameSchema.parse({
      t: 'bytes',
      terminalId: 'terminal-bench',
      seq,
      byteOffset: currentByteOffset,
      byteLength: frame.byteLength,
      encoding: 'base64',
      data: encodeTerminalStreamBytes(frame),
    }));
  });
  const decoded = concatBytes(decodedFrames);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const droppedFrames = Buffer.compare(Buffer.from(decoded), Buffer.from(bytes)) === 0 ? 0 : 1;
  return {
    decodedBytes: decoded.byteLength,
    durationMs,
    droppedFrames,
  };
}

export function buildTerminalBenchRun(params: Readonly<{
  workloads?: readonly TerminalWorkloadId[];
  repeat?: number;
  frameBytes?: number;
  now?: () => number;
}>): TerminalBenchmarkReport {
  const workloadIds = params.workloads ?? listTerminalWorkloads().map((workload) => workload.id);
  const repeat = params.repeat ?? 1;
  const frameBytes = assertCanonicalTerminalFrameBytes(params.frameBytes ?? 64_000);
  const now = params.now ?? Date.now;
  const startedAtMs = now();
  const samples = [];

  for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
    for (const workloadId of workloadIds) {
      const workload = getTerminalWorkload(workloadId);
      const roundtrip = runCanonicalBase64Framing(workload.bytes, frameBytes);
      samples.push(summarizeTerminalSample({
        renderer: 'canonical-base64-codec',
        workloadId,
        decodedBytes: roundtrip.decodedBytes,
        durationMs: roundtrip.durationMs,
        ackLatenciesMs: [],
        droppedFrames: roundtrip.droppedFrames,
      }));
    }
  }

  const endedAtMs = now();
  return buildTerminalBenchmarkReport({
    measurementScope: 'transport-codec',
    suite: 'terminal-canonical-base64-framing',
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    samples,
  });
}

export function writeTerminalBenchReport(report: TerminalBenchmarkReport, outPath: string): string {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolved;
}

export function readTerminalBenchReport(path: string): TerminalBenchmarkReport {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TerminalBenchmarkReport;
  const samples = parsed.samples.map((sample) => ({
    ...sample,
    timingBoundary: sample.timingBoundary ?? 'parser-write-complete',
    observationSource: sample.observationSource ?? 'transport-process',
  }));
  if (parsed.measurementScope === 'transport-codec' || parsed.measurementScope === 'renderer') {
    return { ...parsed, samples };
  }
  const inferredScope = samples.every((sample) => sample.renderer === 'canonical-base64-codec')
    ? 'transport-codec'
    : 'renderer';
  return { ...parsed, samples, measurementScope: inferredScope };
}

function parseCompareArgs(args: readonly string[]): Readonly<{
  baselinePath: string;
  candidatePath: string;
  thresholds: TerminalBenchmarkComparisonThresholds;
}> {
  const [, baselinePath, candidatePath, ...rest] = args;
  if (!baselinePath || !candidatePath) {
    throw new Error('Usage: report.mjs --compare <baseline.json> <candidate.json>');
  }

  const thresholds: {
    minThroughputRatio?: number;
    maxAdditionalLossEvents?: number;
  } = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--min-throughput-ratio') {
      index += 1;
      thresholds.minThroughputRatio = parseNonNegativeRatio('--min-throughput-ratio', rest[index]);
      continue;
    }
    if (arg === '--max-additional-loss-events') {
      index += 1;
      thresholds.maxAdditionalLossEvents = parseNonNegativeInteger('--max-additional-loss-events', rest[index]);
      continue;
    }
    throw new Error(`Unknown terminal bench report argument: ${arg}`);
  }

  return {
    baselinePath,
    candidatePath,
    thresholds,
  };
}

function buildTerminalBenchReportCliResult(args: readonly string[]): Readonly<{
  output: string;
  failed: boolean;
}> {
  if (args[0] === '--compare') {
    const { baselinePath, candidatePath, thresholds } = parseCompareArgs(args);
    const comparison = compareTerminalBenchmarkReports(
      readTerminalBenchReport(baselinePath),
      readTerminalBenchReport(candidatePath),
      thresholds,
    );
    return {
      output: `${formatTerminalBenchmarkComparisonSummary(comparison)}\n`,
      failed: comparison.status === 'failed',
    };
  }

  const [reportPath] = args;
  if (!reportPath) {
    throw new Error('Usage: report.mjs <terminal-report.json>');
  }
  return {
    output: `${formatTerminalBenchmarkReportSummary(readTerminalBenchReport(reportPath))}\n`,
    failed: false,
  };
}

export function buildTerminalBenchReportCliOutput(args: readonly string[]): string {
  return buildTerminalBenchReportCliResult(args).output;
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const options = parseTerminalBenchArgs(args);
  const report = buildTerminalBenchRun(options);
  if (options.out) {
    writeTerminalBenchReport(report, options.out);
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function reportMain(args: readonly string[] = process.argv.slice(2)): void {
  const result = buildTerminalBenchReportCliResult(args);
  process.stdout.write(result.output);
  if (result.failed) {
    throw new Error('terminal benchmark comparison failed');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
