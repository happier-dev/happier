export type BrowserTransferMemoryPoint = Readonly<{
  jsHeapUsedBytes: number;
  browserProcessTreeRssBytes: number | null;
  daemonRssBytes: number | null;
}>;

export type BrowserTransferMemoryWindow = Readonly<{
  baseline: BrowserTransferMemoryPoint;
  maxJsHeapUsedBytes: number;
  maxBrowserProcessTreeRssBytes: number | null;
  maxDaemonRssBytes: number | null;
  settledAfterGc: BrowserTransferMemoryPoint;
}>;

export type BrowserTransferMemoryViolation = Readonly<{
  id: string;
  actualBytes: number;
  limitBytes: number;
}>;

export function evaluateBrowserTransferMemoryContract(input: Readonly<{
  control: BrowserTransferMemoryWindow;
  firstDownload: BrowserTransferMemoryWindow;
  secondDownload: BrowserTransferMemoryWindow;
  maxRetainedJsHeapGrowthBytes: number;
  maxBrowserProcessTreeRssGrowthBytes: number;
  maxDaemonRssGrowthBytes: number;
}>): readonly BrowserTransferMemoryViolation[] {
  const violations: BrowserTransferMemoryViolation[] = [];
  const record = (id: string, actualBytes: number, limitBytes: number): void => {
    if (actualBytes < limitBytes) return;
    violations.push({ id, actualBytes, limitBytes });
  };
  const jsSettledGrowth = (window: BrowserTransferMemoryWindow): number => (
    window.settledAfterGc.jsHeapUsedBytes - window.baseline.jsHeapUsedBytes
  );
  const rssMaxGrowth = (
    window: BrowserTransferMemoryWindow,
    owner: 'browser' | 'daemon',
  ): number | null => {
    const baseline = owner === 'browser'
      ? window.baseline.browserProcessTreeRssBytes
      : window.baseline.daemonRssBytes;
    const max = owner === 'browser'
      ? window.maxBrowserProcessTreeRssBytes
      : window.maxDaemonRssBytes;
    return baseline === null || max === null ? null : max - baseline;
  };
  const rssPoint = (
    point: BrowserTransferMemoryPoint,
    owner: 'browser' | 'daemon',
  ): number | null => owner === 'browser' ? point.browserProcessTreeRssBytes : point.daemonRssBytes;

  for (const [label, transfer] of [
    ['first_download', input.firstDownload],
    ['second_download', input.secondDownload],
  ] as const) {
    record(
      `${label}_retained_js`,
      jsSettledGrowth(transfer),
      input.maxRetainedJsHeapGrowthBytes,
    );
    for (const owner of ['browser', 'daemon'] as const) {
      const transferGrowth = rssMaxGrowth(transfer, owner);
      const controlGrowth = rssMaxGrowth(input.control, owner);
      if (transferGrowth === null || controlGrowth === null) continue;
      const margin = owner === 'browser'
        ? input.maxBrowserProcessTreeRssGrowthBytes
        : input.maxDaemonRssGrowthBytes;
      record(
        `${label}_${owner}_rss_vs_control`,
        transferGrowth,
        Math.max(0, controlGrowth) + margin,
      );
    }
  }

  record(
    'second_download_settled_js_frontier',
    input.secondDownload.settledAfterGc.jsHeapUsedBytes,
    input.firstDownload.settledAfterGc.jsHeapUsedBytes + input.maxRetainedJsHeapGrowthBytes,
  );

  for (const owner of ['browser', 'daemon'] as const) {
    const margin = owner === 'browser'
      ? input.maxBrowserProcessTreeRssGrowthBytes
      : input.maxDaemonRssGrowthBytes;
    const firstMax = owner === 'browser'
      ? input.firstDownload.maxBrowserProcessTreeRssBytes
      : input.firstDownload.maxDaemonRssBytes;
    const secondMax = owner === 'browser'
      ? input.secondDownload.maxBrowserProcessTreeRssBytes
      : input.secondDownload.maxDaemonRssBytes;
    if (firstMax !== null && secondMax !== null) {
      record(`second_download_raw_${owner}_rss_frontier`, secondMax, firstMax + margin);
    }
    const firstSettled = rssPoint(input.firstDownload.settledAfterGc, owner);
    const secondSettled = rssPoint(input.secondDownload.settledAfterGc, owner);
    if (firstSettled !== null && secondSettled !== null) {
      record(`second_download_settled_${owner}_rss_frontier`, secondSettled, firstSettled + margin);
    }
  }

  return violations;
}
