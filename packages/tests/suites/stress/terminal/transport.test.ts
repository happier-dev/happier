import { describe, expect, it } from 'vitest';

import { createRunDirs } from '../../../src/testkit/runDir';
import {
  assertTerminalReportHasNoLoss,
  formatTerminalBenchmarkReportSummary,
} from '../../../src/testkit/terminal/report';
import {
  buildTerminalBenchRun,
  writeTerminalBenchReport,
} from '../../../src/testkit/terminal/benchCli';

const run = createRunDirs({ runLabel: 'terminal-stress' });

describe('stress: terminal local byte/base64 transport fixtures', () => {
  it('round-trips every TERM workload through bounded base64 frames without byte loss', () => {
    const report = buildTerminalBenchRun({
      repeat: 1,
      frameBytes: 8 * 1024,
    });

    assertTerminalReportHasNoLoss(report);
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.totals.decodedBytes).toBeGreaterThan(0);
    expect(formatTerminalBenchmarkReportSummary(report)).toContain('terminal-local-byte-base64');
    writeTerminalBenchReport(report, `${run.testDir('transport')}/terminal-local-byte-base64.json`);
  });
});
