import { readFileSync } from 'node:fs';

import { waitFor } from '../../timing';
import { scrapeStressMetrics } from '../metrics/scrapeStressMetrics';
import type { StartedStressTarget } from '../targets/stressTargetTypes';

type FullComposeAdmin = NonNullable<StartedStressTarget['admin']>;

export function requireFullComposeAdmin(target: StartedStressTarget): FullComposeAdmin | null {
  if (target.mode !== 'full-compose' || !target.admin) {
    return null;
  }
  return target.admin;
}

export async function resolveServiceUpstreamTargets(
  target: StartedStressTarget,
  service: string,
  port: number,
): Promise<string[]> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) return [];

  const containers = await admin.listServiceContainers(service);
  return containers.flatMap((container) =>
    container.ipv4Addresses.map((ipAddress) => `${ipAddress}:${port}`),
  );
}

export function readScalarMetricValue(metricsText: string, metricName: string): number {
  const pattern = new RegExp(`^${metricName}(?:\\{[^\\n]*\\})?\\s+(\\d+(?:\\.\\d+)?)$`, 'gm');
  let total = 0;
  for (const match of metricsText.matchAll(pattern)) {
    total += Number.parseFloat(match[1] ?? '0');
  }
  return total;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelsMatch(selector: Readonly<Record<string, string>>, labelsText: string): boolean {
  const parsed = Object.fromEntries(
    labelsText
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const index = entry.indexOf('=');
        if (index === -1) {
          return [entry, ''];
        }
        const key = entry.slice(0, index).trim();
        const rawValue = entry.slice(index + 1).trim();
        return [key, rawValue.replace(/^"|"$/g, '')];
      }),
  );
  return Object.entries(selector).every(([key, value]) => parsed[key] === value);
}

export function readLabeledMetricValue(params: {
  metricsText: string;
  metricName: string;
  labels: Readonly<Record<string, string>>;
}): number {
  const pattern = new RegExp(`^${escapeRegex(params.metricName)}\\{([^\\n}]*)\\}\\s+(\\d+(?:\\.\\d+)?)$`, 'gm');
  let total = 0;
  for (const match of params.metricsText.matchAll(pattern)) {
    const labelsText = match[1] ?? '';
    if (!labelsMatch(params.labels, labelsText)) {
      continue;
    }
    total += Number.parseFloat(match[2] ?? '0');
  }
  return total;
}

export async function readServiceMetricsViaNodeFetch(target: StartedStressTarget, service: string): Promise<string> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error(`Service metrics fetch requires a full-compose target (service=${service})`);
  }

  return await admin.execInService(
    service,
    [
      'node',
      '-e',
      "fetch('http://127.0.0.1:9090/metrics').then(async (response) => { if (!response.ok) throw new Error(String(response.status)); process.stdout.write(await response.text()); }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
    ],
  );
}

export async function readClusterServiceMetricsViaNodeFetch(
  target: StartedStressTarget,
  service: string,
): Promise<string> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error(`Cluster service metrics fetch requires a full-compose target (service=${service})`);
  }

  const upstreamTargets = await resolveServiceUpstreamTargets(target, service, 9090);
  if (upstreamTargets.length === 0) {
    return await readServiceMetricsViaNodeFetch(target, service);
  }

  const output = await admin.execInService(
    service,
    [
      'node',
      '-e',
      "const targets = JSON.parse(process.argv[1] ?? '[]'); Promise.all(targets.map(async (target) => { const response = await fetch(`http://${target}/metrics`); if (!response.ok) throw new Error(`${target}:${response.status}`); return await response.text(); })).then((values) => { process.stdout.write(JSON.stringify(values)); }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
      JSON.stringify(upstreamTargets),
    ],
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array of metrics texts from ${service} cluster scrape`);
  }
  return parsed
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

export async function scrapeServiceMetricCounters(params: {
  target: StartedStressTarget;
  service: string;
  metricNames: readonly string[];
}): Promise<Record<string, number>> {
  const metricsText = await readServiceMetricsViaNodeFetch(params.target, params.service);
  return Object.fromEntries(
    params.metricNames.map((metricName) => [metricName, readScalarMetricValue(metricsText, metricName)]),
  );
}

export async function scrapeServiceMetricSelectors(params: {
  target: StartedStressTarget;
  service: string;
  selectors: ReadonlyArray<{
    alias: string;
    metricName: string;
    labels: Readonly<Record<string, string>>;
  }>;
}): Promise<Record<string, number>> {
  const metricsText = await readServiceMetricsViaNodeFetch(params.target, params.service);
  return Object.fromEntries(
    params.selectors.map((selector) => [
      selector.alias,
      readLabeledMetricValue({
        metricsText,
        metricName: selector.metricName,
        labels: selector.labels,
      }),
    ]),
  );
}

export async function fetchGatewayStubStatus(target: StartedStressTarget, timeoutMs = 2_000): Promise<string> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error('Gateway stub status requires a full-compose target');
  }

  try {
    return await admin.execInService('gateway', [
      'sh',
      '-lc',
      'wget -qO- http://127.0.0.1:8080/nginx_status',
    ]);
  } catch {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${target.baseUrl}/nginx_status`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gateway stub status returned ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type GatewayLogSummary = Readonly<{
  access: {
    totalRequests: number;
    updatesRequests: number;
    status101: number;
    status499: number;
    status502: number;
    status5xx: number;
  };
  error: {
    connectFailed: number;
    upstreamTimedOut: number;
    upstreamPrematurelyClosed: number;
    noLiveUpstreams: number;
  };
}>;

function countPatternMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function summarizeGatewayLogTexts(params: {
  accessLogText: string;
  errorLogText: string;
}): GatewayLogSummary {
  const candidateAccessLines = params.accessLogText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const accessLines = candidateAccessLines.filter((line) =>
    /"([A-Z]+)\s+([^"\s]+)[^"]*"\s+(\d{3})\s/u.test(line),
  );

  let updatesRequests = 0;
  let status101 = 0;
  let status499 = 0;
  let status502 = 0;
  let status5xx = 0;

  for (const line of accessLines) {
    const match = line.match(/"([A-Z]+)\s+([^"\s]+)[^"]*"\s+(\d{3})\s/u);
    if (!match) {
      continue;
    }
    const path = match[2] ?? '';
    const status = Number.parseInt(match[3] ?? '0', 10);
    if (path.startsWith('/v1/updates')) {
      updatesRequests += 1;
    }
    if (status === 101) status101 += 1;
    if (status === 499) status499 += 1;
    if (status === 502) status502 += 1;
    if (status >= 500 && status <= 599) status5xx += 1;
  }

  return {
    access: {
      totalRequests: accessLines.length,
      updatesRequests,
      status101,
      status499,
      status502,
      status5xx,
    },
    error: {
      connectFailed: countPatternMatches(params.errorLogText, /connect\(\) failed/gu),
      upstreamTimedOut: countPatternMatches(params.errorLogText, /upstream timed out/gu),
      upstreamPrematurelyClosed: countPatternMatches(params.errorLogText, /upstream prematurely closed connection/gu),
      noLiveUpstreams: countPatternMatches(params.errorLogText, /no live upstreams/gu),
    },
  };
}

export function summarizeGatewayLogsFromComposeLogs(composeLogsText: string): GatewayLogSummary {
  const gatewayLines = composeLogsText
    .split('\n')
    .map((line) => {
      const match = line.match(/^gateway-\d+\s+\|\s?(.*)$/u);
      return match?.[1]?.trim() ?? null;
    })
    .filter((line): line is string => typeof line === 'string' && line.length > 0);

  const gatewayLogText = gatewayLines.join('\n');
  return summarizeGatewayLogTexts({
    accessLogText: gatewayLogText,
    errorLogText: gatewayLogText,
  });
}

export async function summarizeGatewayLogs(target: StartedStressTarget): Promise<GatewayLogSummary> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error('Gateway log summary requires a full-compose target');
  }

  const [accessLog, errorLog] = await Promise.all([
    admin.execInService('gateway', ['sh', '-lc', 'cat /var/log/nginx/access.log 2>/dev/null || true']),
    admin.execInService('gateway', ['sh', '-lc', 'cat /var/log/nginx/error.log 2>/dev/null || true']),
  ]);

  return summarizeGatewayLogTexts({
    accessLogText: accessLog,
    errorLogText: errorLog,
  });
}

export async function scrapeClusterServiceMetricCounters(params: {
  target: StartedStressTarget;
  service: string;
  metricNames: readonly string[];
}): Promise<Record<string, number>> {
  const metricsText = await readClusterServiceMetricsViaNodeFetch(params.target, params.service);
  return Object.fromEntries(
    params.metricNames.map((metricName) => [metricName, readScalarMetricValue(metricsText, metricName)]),
  );
}

export async function scrapeClusterServiceMetricSelectors(params: {
  target: StartedStressTarget;
  service: string;
  selectors: ReadonlyArray<{
    alias: string;
    metricName: string;
    labels: Readonly<Record<string, string>>;
  }>;
}): Promise<Record<string, number>> {
  const metricsText = await readClusterServiceMetricsViaNodeFetch(params.target, params.service);
  return Object.fromEntries(
    params.selectors.map((selector) => [
      selector.alias,
      readLabeledMetricValue({
        metricsText,
        metricName: selector.metricName,
        labels: selector.labels,
      }),
    ]),
  );
}

export async function waitForServiceMetricAtLeast(params: {
  target: StartedStressTarget;
  service: string;
  metricName: string;
  minimum: number;
  timeoutMs?: number;
}): Promise<number> {
  let lastValue = 0;
  await waitFor(
    async () => {
      lastValue = readScalarMetricValue(await readServiceMetricsViaNodeFetch(params.target, params.service), params.metricName);
      return lastValue >= params.minimum;
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
      intervalMs: 1_000,
      shouldRetryOnError: () => true,
      context: `${params.service} metric ${params.metricName} >= ${params.minimum}`,
    },
  );
  return lastValue;
}

export async function waitForRedisServiceHealthy(target: StartedStressTarget, timeoutMs = 30_000): Promise<void> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error('Redis health checks require a full-compose target');
  }

  await waitFor(
    async () => (await admin.execInService('redis', ['redis-cli', 'ping'])).includes('PONG'),
    {
      timeoutMs,
      intervalMs: 1_000,
      shouldRetryOnError: () => true,
      context: 'redis service healthy',
    },
  );
}

export async function activateGatewayConfig(target: StartedStressTarget, configPath: string): Promise<void> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error('Gateway reconfiguration requires a full-compose target');
  }
  await admin.activateGatewayConfig(configPath);
}

export async function writeScenarioGatewayConfig(params: {
  target: StartedStressTarget;
  fileName: string;
  contents: string;
}): Promise<string> {
  const admin = requireFullComposeAdmin(params.target);
  if (!admin) {
    throw new Error('Gateway config writing requires a full-compose target');
  }
  return await admin.writeGatewayConfig(params.fileName, params.contents);
}

export function readActiveGatewayConfig(target: StartedStressTarget): string | undefined {
  const path = target.artifacts?.gatewayConfigFile;
  if (!path) return undefined;
  return readFileSync(path, 'utf8');
}

export async function scrapeMetricCounter(params: {
  target: StartedStressTarget;
  metricName: string;
}): Promise<number> {
  if (params.target.mode === 'full-compose') {
    const counters = await scrapeServiceMetricCounters({
      target: params.target,
      service: 'api',
      metricNames: [params.metricName],
    });
    return counters[params.metricName] ?? 0;
  }

  const scraped = await scrapeStressMetrics({
    baseUrl: params.target.baseUrl,
    metricNames: [params.metricName],
  });
  return scraped.counters[params.metricName] ?? 0;
}
