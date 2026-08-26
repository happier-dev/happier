import { describe, expect, it } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES } from '@happier-dev/protocol';

import {
  buildTerminalBenchReportCliOutput,
  buildTerminalBenchRun,
  parseTerminalBenchArgs,
  writeTerminalBenchReport,
} from './benchCli';
import { buildTerminalBenchmarkReport, summarizeTerminalSample } from './report';

describe('terminal bench CLI helpers', () => {
  it('parses workload, repeat, frame, and output options', () => {
    expect(
      parseTerminalBenchArgs([
        '--workload',
        'ansi-burst',
        '--workload',
        'long-scrollback',
        '--repeat',
        '2',
        '--frame-bytes',
        '4096',
        '--out',
        '/tmp/terminal-report.json',
      ]),
    ).toEqual({
      workloads: ['ansi-burst', 'long-scrollback'],
      repeat: 2,
      frameBytes: 4096,
      out: '/tmp/terminal-report.json',
    });
  });

  it('builds a deterministic report through the canonical terminal base64 codec', () => {
    const first = buildTerminalBenchRun({
      workloads: ['ansi-burst'],
      repeat: 2,
      frameBytes: 1024,
      now: () => 1_000,
    });
    const second = buildTerminalBenchRun({
      workloads: ['ansi-burst'],
      repeat: 2,
      frameBytes: 1024,
      now: () => 1_000,
    });

    expect(first.samples).toHaveLength(2);
    expect(first.suite).toBe('terminal-canonical-base64-framing');
    expect(first.samples.every((sample) => sample.renderer === 'canonical-base64-codec')).toBe(true);
    expect(first.totals.decodedBytes).toBe(second.totals.decodedBytes);
    expect(first.samples.map((sample) => sample.loss)).toEqual(second.samples.map((sample) => sample.loss));
  });

  it('rejects a benchmark frame larger than the canonical terminal stream frame cap', () => {
    expect(() => buildTerminalBenchRun({
      workloads: ['ansi-burst'],
      frameBytes: TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES + 1,
    })).toThrow(/terminal stream frame bytes/i);
  });

  it('prints a benchmark comparison summary for two report files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-bench-'));
    const baselinePath = join(dir, 'baseline.json');
    const candidatePath = join(dir, 'candidate.json');
    const baseline = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'canonical-base64-codec',
          workloadId: 'ansi-burst',
          decodedBytes: 1024,
          durationMs: 10,
          ackLatenciesMs: [1],
        }),
      ],
    });
    const candidate = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'canonical-base64-codec',
          workloadId: 'ansi-burst',
          decodedBytes: 1024,
          durationMs: 11,
          ackLatenciesMs: [1],
        }),
      ],
    });
    writeTerminalBenchReport(baseline, baselinePath);
    writeTerminalBenchReport(candidate, candidatePath);

    expect(
      buildTerminalBenchReportCliOutput([
        '--compare',
        baselinePath,
        candidatePath,
        '--min-throughput-ratio',
        '0.5',
      ]),
    ).toContain('terminal benchmark comparison: passed');
  });
});
