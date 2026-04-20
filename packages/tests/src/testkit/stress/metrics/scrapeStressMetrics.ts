export type ScrapedStressMetrics = Readonly<{
  rawText: string;
  counters: Record<string, number>;
}>;

function readCounter(metricsText: string, metricName: string): number {
  const pattern = new RegExp(`^${metricName}(?:\\{[^\\n]*\\})?\\s+(\\d+(?:\\.\\d+)?)$`, 'gm');
  let total = 0;
  for (const match of metricsText.matchAll(pattern)) {
    total += Number.parseFloat(match[1] ?? '0');
  }
  return total;
}

export async function scrapeStressMetrics(params: {
  baseUrl: string;
  metricNames: readonly string[];
}): Promise<ScrapedStressMetrics> {
  const response = await fetch(`${params.baseUrl}/metrics`);
  if (!response.ok) {
    throw new Error(`Failed to scrape metrics from ${params.baseUrl}/metrics (${response.status})`);
  }

  const rawText = await response.text();
  return {
    rawText,
    counters: Object.fromEntries(params.metricNames.map((metricName) => [metricName, readCounter(rawText, metricName)])),
  };
}
