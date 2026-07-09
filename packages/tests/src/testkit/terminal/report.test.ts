import { describe, expect, it } from 'vitest';

import {
  assertTerminalReportHasNoLoss,
  buildTerminalBenchmarkReport,
  compareTerminalBenchmarkReports,
  formatTerminalBenchmarkReportSummary,
  formatTerminalBenchmarkComparisonSummary,
  summarizeTerminalSample,
} from './report';

describe('terminal benchmark reports', () => {
  it('summarizes decoded bytes, throughput, ACK latency, and loss counters', () => {
    const sample = summarizeTerminalSample({
      renderer: 'xterm-web',
      workloadId: 'ansi-burst',
      decodedBytes: 1024 * 1024,
      durationMs: 500,
      ackLatenciesMs: [4, 8, 16, 32],
      gaps: 1,
      truncations: 2,
      droppedFrames: 3,
      memoryHighWaterBytes: 128 * 1024 * 1024,
    });

    expect(sample.throughputMiBps).toBe(2);
    expect(sample.ackLatency.p50Ms).toBe(8);
    expect(sample.ackLatency.p95Ms).toBe(32);
    expect(sample.loss).toEqual({ gaps: 1, truncations: 2, droppedFrames: 3 });
    expect(sample.memoryHighWaterBytes).toBe(128 * 1024 * 1024);
  });

  it('builds a machine-readable report with aggregate totals', () => {
    const report = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:02.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'machine-rpc-base64',
          workloadId: 'ansi-burst',
          decodedBytes: 1024,
          durationMs: 10,
          ackLatenciesMs: [1],
        }),
        summarizeTerminalSample({
          renderer: 'xterm-webview',
          workloadId: 'long-scrollback',
          decodedBytes: 2048,
          durationMs: 20,
          ackLatenciesMs: [2],
        }),
      ],
    });

    expect(report.totals.decodedBytes).toBe(3072);
    expect(report.totals.samples).toBe(2);
    expect(report.totals.loss).toEqual({ gaps: 0, truncations: 0, droppedFrames: 0 });
    expect(report.durationMs).toBe(2000);
  });

  it('fails the no-loss gate when gaps, truncation, or dropped frames are reported', () => {
    const report = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'xterm-web',
          workloadId: 'heavy-tui-redraw',
          decodedBytes: 100,
          durationMs: 10,
          ackLatenciesMs: [],
          gaps: 1,
        }),
      ],
    });

    expect(() => assertTerminalReportHasNoLoss(report)).toThrow(/terminal report recorded byte loss/i);
  });

  it('formats a concise human-readable report summary', () => {
    const report = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'machine-rpc-base64',
          workloadId: 'ansi-burst',
          decodedBytes: 1024,
          durationMs: 10,
          ackLatenciesMs: [1],
        }),
      ],
    });

    expect(formatTerminalBenchmarkReportSummary(report)).toContain('terminal-foundation: 1 sample');
    expect(formatTerminalBenchmarkReportSummary(report)).toContain('decoded=1024');
  });

  it('compares benchmark reports with explicit throughput and loss regression gates', () => {
    const baseline = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'synthetic-byte-roundtrip',
          workloadId: 'ansi-burst',
          decodedBytes: 1024 * 1024,
          durationMs: 100,
          ackLatenciesMs: [2],
        }),
      ],
    });
    const candidate = buildTerminalBenchmarkReport({
      suite: 'terminal-foundation',
      startedAt: '2026-06-13T10:00:00.000Z',
      endedAt: '2026-06-13T10:00:01.000Z',
      samples: [
        summarizeTerminalSample({
          renderer: 'synthetic-byte-roundtrip',
          workloadId: 'ansi-burst',
          decodedBytes: 1024 * 1024,
          durationMs: 400,
          ackLatenciesMs: [2],
          droppedFrames: 1,
        }),
      ],
    });

    const comparison = compareTerminalBenchmarkReports(baseline, candidate, {
      minThroughputRatio: 0.75,
      maxAdditionalLossEvents: 0,
    });

    expect(comparison.status).toBe('failed');
    expect(comparison.regressions.map((regression) => regression.metric)).toEqual([
      'throughputMiBps',
      'lossEvents',
    ]);
    expect(formatTerminalBenchmarkComparisonSummary(comparison)).toContain('failed');
  });
});
