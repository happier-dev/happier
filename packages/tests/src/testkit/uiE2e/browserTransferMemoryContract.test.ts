import { describe, expect, it } from 'vitest';

import {
  evaluateBrowserTransferMemoryContract,
  type BrowserTransferMemoryWindow,
} from './browserTransferMemoryContract';

const MIB = 1024 * 1024;

function window(input: Readonly<{
  baselineJs?: number;
  maxJsGrowth?: number;
  settledJsGrowth?: number;
  baselineBrowserRss?: number | null;
  maxBrowserRssGrowth?: number;
  settledBrowserRssGrowth?: number;
  baselineDaemonRss?: number | null;
  maxDaemonRssGrowth?: number;
  settledDaemonRssGrowth?: number;
}>): BrowserTransferMemoryWindow {
  const baselineJs = input.baselineJs ?? 200 * MIB;
  const baselineBrowserRss = input.baselineBrowserRss === undefined ? 1_000 * MIB : input.baselineBrowserRss;
  const baselineDaemonRss = input.baselineDaemonRss === undefined ? 500 * MIB : input.baselineDaemonRss;
  return {
    baseline: {
      jsHeapUsedBytes: baselineJs,
      browserProcessTreeRssBytes: baselineBrowserRss,
      daemonRssBytes: baselineDaemonRss,
    },
    maxJsHeapUsedBytes: baselineJs + (input.maxJsGrowth ?? 0),
    maxBrowserProcessTreeRssBytes: baselineBrowserRss === null ? null : baselineBrowserRss + (input.maxBrowserRssGrowth ?? 0),
    maxDaemonRssBytes: baselineDaemonRss === null ? null : baselineDaemonRss + (input.maxDaemonRssGrowth ?? 0),
    settledAfterGc: {
      jsHeapUsedBytes: baselineJs + (input.settledJsGrowth ?? 0),
      browserProcessTreeRssBytes: baselineBrowserRss === null ? null : baselineBrowserRss + (input.settledBrowserRssGrowth ?? 0),
      daemonRssBytes: baselineDaemonRss === null ? null : baselineDaemonRss + (input.settledDaemonRssGrowth ?? 0),
    },
  };
}

function evaluate(input?: Readonly<{
  control?: BrowserTransferMemoryWindow;
  firstDownload?: BrowserTransferMemoryWindow;
  secondDownload?: BrowserTransferMemoryWindow;
}>) {
  return evaluateBrowserTransferMemoryContract({
    control: input?.control ?? window({ maxJsGrowth: 120 * MIB, maxBrowserRssGrowth: 230 * MIB, maxDaemonRssGrowth: 190 * MIB }),
    firstDownload: input?.firstDownload ?? window({ maxJsGrowth: 41 * MIB, settledJsGrowth: -2 * MIB, maxBrowserRssGrowth: 240 * MIB, maxDaemonRssGrowth: 64 * MIB }),
    secondDownload: input?.secondDownload ?? window({ maxJsGrowth: 40 * MIB, settledJsGrowth: 1 * MIB, maxBrowserRssGrowth: 135 * MIB, maxDaemonRssGrowth: 54 * MIB }),
    maxRetainedJsHeapGrowthBytes: 20 * MIB,
    maxBrowserProcessTreeRssGrowthBytes: 128 * MIB,
    maxDaemonRssGrowthBytes: 128 * MIB,
  });
}

describe('evaluateBrowserTransferMemoryContract', () => {
  it('accepts bounded post-GC retention and transfer peaks below the no-transfer control frontier', () => {
    expect(evaluate()).toEqual([]);
  });

  it('rejects post-GC retained JS growth even when transient control growth is larger', () => {
    const violations = evaluate({
      firstDownload: window({ maxJsGrowth: 40 * MIB, settledJsGrowth: 21 * MIB }),
    });

    expect(violations.map((violation) => violation.id)).toContain('first_download_retained_js');
  });

  it('ignores collector-timing-dependent raw JS peaks while rejecting settled accumulation', () => {
    const firstDownload = window({ baselineJs: 200 * MIB, maxJsGrowth: 40 * MIB, settledJsGrowth: 1 * MIB });
    const violations = evaluate({
      firstDownload,
      secondDownload: window({
        baselineJs: 201 * MIB,
        maxJsGrowth: 61 * MIB,
        settledJsGrowth: 21 * MIB,
      }),
    });

    expect(violations.map((violation) => violation.id)).not.toContain('second_download_raw_js_frontier');
    expect(violations.map((violation) => violation.id)).toContain('second_download_settled_js_frontier');
  });

  it('does not turn raw JS collector timing into a failure while retaining process RSS bounds', () => {
    const violations = evaluate({
      control: window({ maxJsGrowth: 10 * MIB, maxBrowserRssGrowth: 20 * MIB, maxDaemonRssGrowth: 20 * MIB }),
      firstDownload: window({ maxJsGrowth: 31 * MIB, maxBrowserRssGrowth: 149 * MIB, maxDaemonRssGrowth: 149 * MIB }),
    });

    expect(violations.map((violation) => violation.id)).not.toContain('first_download_raw_js_vs_control');
    expect(violations.map((violation) => violation.id)).toEqual(expect.arrayContaining([
      'first_download_browser_rss_vs_control',
      'first_download_daemon_rss_vs_control',
    ]));
  });

  it('retains the JS contract when process RSS measurement is unavailable', () => {
    const noRss = window({ baselineBrowserRss: null, baselineDaemonRss: null, maxJsGrowth: 10 * MIB });

    expect(evaluate({ control: noRss, firstDownload: noRss, secondDownload: noRss })).toEqual([]);
  });
});
