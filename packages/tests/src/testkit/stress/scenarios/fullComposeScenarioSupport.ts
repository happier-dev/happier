import { readFileSync } from 'node:fs';

import { waitFor } from '../../timing';
import { scrapeStressMetrics } from '../metrics/scrapeStressMetrics';
import type { StartedStressTarget } from '../targets/stressTargetTypes';

type FullComposeAdmin = NonNullable<StartedStressTarget['admin']>;

export type ServiceReplicaTarget = Readonly<{
  target: string;
  containerId: string;
  containerName: string;
}>;

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
  return (await resolveServiceReplicaTargets(target, service, port)).map((replica) => replica.target);
}

async function resolveServiceReplicaTargets(
  target: StartedStressTarget,
  service: string,
  port: number,
): Promise<readonly ServiceReplicaTarget[]> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) return [];

  const containers = await admin.listServiceContainers(service);
  return containers.flatMap((container) => {
    const ipAddress = container.ipv4Addresses[0];
    if (!ipAddress) {
      return [];
    }
    return [{
      target: `${ipAddress}:${port}`,
      containerId: container.id,
      containerName: container.name,
    }];
  });
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
  return (await readClusterServiceMetricsByReplicaViaNodeFetch(target, service))
    .map((replica) => replica.metricsText)
    .join('\n');
}

export async function readClusterServiceMetricsByReplicaViaNodeFetch(
  target: StartedStressTarget,
  service: string,
): Promise<ReadonlyArray<ServiceReplicaTarget & { metricsText: string }>> {
  const admin = requireFullComposeAdmin(target);
  if (!admin) {
    throw new Error(`Cluster service metrics fetch requires a full-compose target (service=${service})`);
  }

  const replicas = await resolveServiceReplicaTargets(target, service, 9090);
  if (replicas.length === 0) {
    return [{
      target: service,
      containerId: service,
      containerName: service,
      metricsText: await readServiceMetricsViaNodeFetch(target, service),
    }];
  }

  const output = await admin.execInService(
    service,
    [
      'node',
      '-e',
      "const targets = JSON.parse(process.argv[1] ?? '[]'); Promise.all(targets.map(async (target) => { const response = await fetch(`http://${target}/metrics`); if (!response.ok) throw new Error(`${target}:${response.status}`); return await response.text(); })).then((values) => { process.stdout.write(JSON.stringify(values)); }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
      JSON.stringify(replicas.map((replica) => replica.target)),
    ],
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array of metrics texts from ${service} cluster scrape`);
  }
  if (parsed.length !== replicas.length) {
    throw new Error(`Expected ${replicas.length} replica metrics payloads from ${service} cluster scrape`);
  }
  return replicas.map((replica, index) => {
    const metricsText = parsed[index];
    if (typeof metricsText !== 'string') {
      throw new Error(`Expected metrics payload ${index} from ${service} cluster scrape to be a string`);
    }
    return {
      ...replica,
      metricsText,
    };
  });
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

export type ClusterServiceMetricPeakReplica = Readonly<{
  target: string;
  containerId: string;
  containerName: string;
  values: Record<string, number>;
}>;

export type ClusterServiceMetricThresholdSignal = Readonly<{
  valueKey: string;
  threshold: number;
  signal: NodeJS.Signals;
}>;

export type ClusterServiceMetricThresholdSignalEvent = Readonly<{
  target: string;
  containerId: string;
  containerName: string;
  valueKey: string;
  threshold: number;
  observedValue: number;
  signal: NodeJS.Signals;
}>;

type ContainerMemoryPeakSnapshot = Readonly<{
  service: string;
  containerId: string;
  containerName: string;
  peakMemoryUsageBytes: number;
  memoryLimitBytes?: number;
  peakMemoryPercent?: number;
  peakPids?: number;
}>;

function parseContainerCgroupStats(output: string): {
  usageBytes: number;
  limitBytes?: number;
  pids?: number;
} {
  const [usageLine, limitLine, pidsLine] = output.split('\n').map((line) => line.trim());
  const usageBytes = Number.parseInt(usageLine ?? '0', 10);
  const parsedLimit = (limitLine ?? '').toLowerCase() === 'max'
    ? undefined
    : Number.parseInt(limitLine ?? '', 10);
  const pids = Number.parseInt(pidsLine ?? '', 10);

  return {
    usageBytes: Number.isFinite(usageBytes) ? usageBytes : 0,
    ...(typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) ? { limitBytes: parsedLimit } : {}),
    ...(Number.isFinite(pids) ? { pids } : {}),
  };
}

async function readContainerCgroupStats(params: {
  target: StartedStressTarget;
  service: string;
  containerId: string;
}): Promise<ContainerMemoryPeakSnapshot> {
  const admin = requireFullComposeAdmin(params.target);
  if (!admin) {
    throw new Error('Container memory sampling requires a full-compose target');
  }

  const command = [
    'sh',
    '-lc',
    [
      'usage_file=/sys/fs/cgroup/memory.current',
      'limit_file=/sys/fs/cgroup/memory.max',
      'pids_file=/sys/fs/cgroup/pids.current',
      'if [ ! -f "$usage_file" ]; then usage_file=/sys/fs/cgroup/memory/memory.usage_in_bytes; fi',
      'if [ ! -f "$limit_file" ]; then limit_file=/sys/fs/cgroup/memory/memory.limit_in_bytes; fi',
      'if [ ! -f "$pids_file" ]; then pids_file=/sys/fs/cgroup/pids/pids.current; fi',
      'printf "%s\\n%s\\n%s\\n" "$(cat "$usage_file")" "$(cat "$limit_file" 2>/dev/null || printf max)" "$(cat "$pids_file" 2>/dev/null || printf 0)"',
    ].join('; '),
  ] as const;
  const output = admin.execInContainer
    ? await admin.execInContainer(params.containerId, command)
    : await admin.execInService(params.service, command);
  const parsed = parseContainerCgroupStats(output);

  return {
    service: params.service,
    containerId: params.containerId,
    containerName: params.containerId,
    peakMemoryUsageBytes: parsed.usageBytes,
    ...(parsed.limitBytes !== undefined ? { memoryLimitBytes: parsed.limitBytes } : {}),
    ...(parsed.limitBytes !== undefined && parsed.limitBytes > 0
      ? { peakMemoryPercent: (parsed.usageBytes / parsed.limitBytes) * 100 }
      : {}),
    ...(parsed.pids !== undefined ? { peakPids: parsed.pids } : {}),
  };
}

function readReplicaMetricValues(params: {
  metricsText: string;
  metricNames: readonly string[];
  selectors?: ReadonlyArray<{
    alias: string;
    metricName: string;
    labels: Readonly<Record<string, string>>;
  }>;
}): Record<string, number> {
  return {
    ...Object.fromEntries(
      params.metricNames.map((metricName) => [metricName, readScalarMetricValue(params.metricsText, metricName)]),
    ),
    ...Object.fromEntries(
      (params.selectors ?? []).map((selector) => [
        selector.alias,
        readLabeledMetricValue({
          metricsText: params.metricsText,
          metricName: selector.metricName,
          labels: selector.labels,
        }),
      ]),
    ),
  };
}

function mergePeakReplicaValues(
  existingValues: Readonly<Record<string, number>> | undefined,
  nextValues: Readonly<Record<string, number>>,
): Record<string, number> {
  if (!existingValues) {
    return { ...nextValues };
  }

  return Object.fromEntries(
    Object.entries(nextValues).map(([key, value]) => [key, Math.max(existingValues[key] ?? 0, value)]),
  );
}

async function sendSignalToReplicaContainer(params: {
  target: StartedStressTarget;
  containerId: string;
  signal: NodeJS.Signals;
}): Promise<void> {
  const admin = requireFullComposeAdmin(params.target);
  if (!admin) {
    throw new Error(`Container signal delivery requires a full-compose target (${params.containerId})`);
  }
  if (!admin.execInContainer) {
    throw new Error(`Full-compose target cannot exec in container ${params.containerId} to send ${params.signal}`);
  }

  await admin.execInContainer(params.containerId, [
    'node',
    '-e',
    'process.kill(1, process.argv[1] ?? "SIGUSR2");',
    params.signal,
  ]);
}

export function startClusterServiceMetricPeakSampler(params: {
  target: StartedStressTarget;
  service: string;
  metricNames: readonly string[];
  selectors?: ReadonlyArray<{
    alias: string;
    metricName: string;
    labels: Readonly<Record<string, string>>;
  }>;
  thresholdSignals?: readonly ClusterServiceMetricThresholdSignal[];
  intervalMs?: number;
}) {
  let stopped = false;
  let lastError: string | undefined;
  let replicas: ClusterServiceMetricPeakReplica[] = [];
  const signalEvents: ClusterServiceMetricThresholdSignalEvent[] = [];
  const signalErrors: string[] = [];
  const signaledKeys = new Set<string>();

  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const replicaMetrics = await readClusterServiceMetricsByReplicaViaNodeFetch(params.target, params.service);
      const existingReplicasByContainerId = new Map(replicas.map((replica) => [replica.containerId, replica] as const));
      const sampledReplicas = replicaMetrics.map((replica) => ({
        replica,
        observedValues: readReplicaMetricValues({
          metricsText: replica.metricsText,
          metricNames: params.metricNames,
          selectors: params.selectors,
        }),
      }));
      replicas = sampledReplicas.map(({ replica, observedValues }) => {
        const existingReplica = existingReplicasByContainerId.get(replica.containerId);
        return {
          target: replica.target,
          containerId: replica.containerId,
          containerName: replica.containerName,
          values: mergePeakReplicaValues(existingReplica?.values, observedValues),
        };
      });
      lastError = undefined;

      for (const { replica, observedValues } of sampledReplicas) {
        for (const thresholdSignal of params.thresholdSignals ?? []) {
          const observedValue = observedValues[thresholdSignal.valueKey];
          if (typeof observedValue !== 'number' || observedValue < thresholdSignal.threshold) {
            continue;
          }
          const signalKey = `${replica.containerId}:${thresholdSignal.valueKey}:${thresholdSignal.threshold}:${thresholdSignal.signal}`;
          if (signaledKeys.has(signalKey)) {
            continue;
          }
          signaledKeys.add(signalKey);

          try {
            await sendSignalToReplicaContainer({
              target: params.target,
              containerId: replica.containerId,
              signal: thresholdSignal.signal,
            });
            signalEvents.push({
              target: replica.target,
              containerId: replica.containerId,
              containerName: replica.containerName,
              valueKey: thresholdSignal.valueKey,
              threshold: thresholdSignal.threshold,
              observedValue,
              signal: thresholdSignal.signal,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            signalErrors.push(
              `Failed to send ${thresholdSignal.signal} to ${replica.containerName} (${replica.containerId}) at ${replica.target}: ${message}`,
            );
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  void poll();
  const interval = setInterval(() => {
    void poll();
  }, params.intervalMs ?? 5_000);
  interval.unref?.();

  return {
    stop: async () => {
      clearInterval(interval);
      await poll();
      stopped = true;
      return {
        replicas,
        ...(lastError ? { error: lastError } : {}),
        ...(signalEvents.length > 0 ? { signalEvents } : {}),
        signalErrors,
      };
    },
  };
}

export function startContainerMemoryPeakSampler(params: {
  target: StartedStressTarget;
  services: readonly string[];
  intervalMs?: number;
}) {
  let stopped = false;
  let lastError: string | undefined;
  const containers = new Map<string, ContainerMemoryPeakSnapshot>();

  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      for (const service of params.services) {
        const replicas = await params.target.admin?.listServiceContainers(service) ?? [];
        for (const replica of replicas) {
          const snapshot = await readContainerCgroupStats({
            target: params.target,
            service,
            containerId: replica.id,
          });
          const existing = containers.get(replica.id);
          const peakMemoryUsageBytes = Math.max(
            existing?.peakMemoryUsageBytes ?? 0,
            snapshot.peakMemoryUsageBytes,
          );
          const peakPids = Math.max(existing?.peakPids ?? 0, snapshot.peakPids ?? 0);
          containers.set(replica.id, {
            ...snapshot,
            containerName: replica.name,
            peakMemoryUsageBytes,
            ...(snapshot.memoryLimitBytes !== undefined ? { memoryLimitBytes: snapshot.memoryLimitBytes } : {}),
            ...(snapshot.memoryLimitBytes !== undefined && snapshot.memoryLimitBytes > 0
              ? { peakMemoryPercent: (peakMemoryUsageBytes / snapshot.memoryLimitBytes) * 100 }
              : {}),
            ...(peakPids > 0 ? { peakPids } : {}),
          });
        }
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  void poll();
  const interval = setInterval(() => {
    void poll();
  }, params.intervalMs ?? 5_000);
  interval.unref?.();

  return {
    stop: async () => {
      clearInterval(interval);
      await poll();
      stopped = true;
      return {
        containers: Array.from(containers.values()),
        error: lastError,
      };
    },
  };
}

export async function resolveComposeNetworkControlPlaneBaseUrls(
  target: StartedStressTarget,
  _config: { compose: { apiReplicas: number } },
): Promise<readonly string[]> {
  const upstreamTargets = await resolveServiceUpstreamTargets(target, 'api', 53288);
  return upstreamTargets.map((targetEntry) => `http://${targetEntry}`);
}

export async function recoverFullComposeFailureDiagnosticsMetrics(params: {
  target: StartedStressTarget;
  metrics: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const nextMetrics: Record<string, unknown> = {
    ...params.metrics,
  };

  try {
    nextMetrics.gatewayStatusText = await fetchGatewayStubStatus(params.target);
  } catch (error) {
    nextMetrics.gatewayStatusError = error instanceof Error ? error.message : String(error);
  }

  try {
    nextMetrics.gatewayLogSummary = await summarizeGatewayLogs(params.target);
  } catch (error) {
    nextMetrics.gatewayLogSummaryError = error instanceof Error ? error.message : String(error);
  }

  return nextMetrics;
}
