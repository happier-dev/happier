import { describe, expect, it } from 'vitest';

import {
  buildTerminalBenchmarkReport,
  compareTerminalRenderers,
  summarizeTerminalSample,
} from '../../../src/testkit/terminal/report';

describe('terminal renderer performance evidence', () => {
  it('compares display-observed native and xterm samples on the same loaded device', () => {
    const samples = Array.from({ length: 3 }, (_, index) => [
      summarizeTerminalSample({
        renderer: 'xterm-webview', workloadId: 'ansi-burst', decodedBytes: 1024,
        durationMs: 100 + index, ackLatenciesMs: [40], timingBoundary: 'display-observed',
        observationSource: 'loaded-device', environment: { platform: 'android', targetId: 'emulator-5554', applicationId: 'dev.happier.qa', buildEvidenceId: 'build-1' },
      }),
      summarizeTerminalSample({
        renderer: 'android-termux', workloadId: 'ansi-burst', decodedBytes: 1024,
        durationMs: 50 + index, ackLatenciesMs: [20], timingBoundary: 'display-observed',
        observationSource: 'loaded-device', environment: { platform: 'android', targetId: 'emulator-5554', applicationId: 'dev.happier.qa', buildEvidenceId: 'build-1' },
      }),
    ]).flat();
    const comparison = compareTerminalRenderers(buildTerminalBenchmarkReport({
      suite: 'loaded-android', startedAt: '2026-08-28T10:00:00Z', endedAt: '2026-08-28T10:01:00Z', samples,
    }), {
      baselineRenderer: 'xterm-webview', candidateRenderer: 'android-termux',
      timingBoundary: 'display-observed', minThroughputRatio: 1.25, minSamplesPerWorkload: 3,
    });
    expect(comparison.status).toBe('passed');
    expect(comparison.comparedWorkloads).toBe(1);
  });

  it('rejects parser-only, cross-device, or undersampled comparison data', () => {
    const report = buildTerminalBenchmarkReport({
      suite: 'invalid-loaded-ios', startedAt: '2026-08-28T10:00:00Z', endedAt: '2026-08-28T10:01:00Z',
      samples: [
        summarizeTerminalSample({ renderer: 'xterm-webview', workloadId: 'ansi-burst', decodedBytes: 10, durationMs: 2, ackLatenciesMs: [], timingBoundary: 'display-observed', observationSource: 'loaded-device', environment: { platform: 'ios', targetId: 'sim-a' } }),
        summarizeTerminalSample({ renderer: 'ios-ghosttykit', workloadId: 'ansi-burst', decodedBytes: 10, durationMs: 1, ackLatenciesMs: [], timingBoundary: 'parser-write-complete', observationSource: 'loaded-device', environment: { platform: 'ios', targetId: 'sim-b' } }),
      ],
    });
    const comparison = compareTerminalRenderers(report, {
      baselineRenderer: 'xterm-webview', candidateRenderer: 'ios-ghosttykit',
      timingBoundary: 'display-observed', minThroughputRatio: 0.75, minSamplesPerWorkload: 3,
    });
    expect(comparison.status).toBe('failed');
    expect(comparison.regressions.some((item) => item.reason === 'missing-candidate')).toBe(true);
  });
});
