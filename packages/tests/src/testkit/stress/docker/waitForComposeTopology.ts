import { setTimeout as sleep } from 'node:timers/promises';

import { waitForOkHealth } from '../../http';
import type { ComposeRuntime } from './composeRuntime';
import { inspectComposeTopology } from './inspectComposeTopology';

type DockerInspectEntry = {
  State?: {
    Status?: string;
    ExitCode?: number;
    Health?: {
      Status?: string;
    };
  };
};

function isHealthy(entry: unknown): boolean {
  const row = entry as DockerInspectEntry;
  const health = row.State?.Health?.Status;
  if (typeof health === 'string') return health === 'healthy';
  return row.State?.Status === 'running';
}

async function isHttpOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function assertServiceMetricsReachable(runtime: ComposeRuntime, service: 'api' | 'worker'): Promise<void> {
  await runtime.execCapture(
    service,
    [
      'node',
      '-e',
      "fetch('http://127.0.0.1:9090/metrics').then(async (response) => { if (!response.ok) throw new Error(String(response.status)); process.stdout.write(await response.text()); }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
    ],
  );
}

export async function waitForComposeTopology(params: {
  runtime: ComposeRuntime;
  baseUrl: string;
  expectedApiReplicas: number;
  expectedWorkerReplicas: number;
  ports: Record<string, number | undefined>;
  metricsEnabled: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const postgresIds = await params.runtime.serviceContainerIds('postgres');
      const redisIds = await params.runtime.serviceContainerIds('redis');
      const minioIds = await params.runtime.serviceContainerIds('minio');
      const minioInitIds = await params.runtime.serviceContainerIds('minio-init');
      const apiIds = await params.runtime.serviceContainerIds('api');

      const [postgresInspect, redisInspect, minioInspect, minioInitInspect, apiInspect] = await Promise.all([
        params.runtime.inspectContainers(postgresIds),
        params.runtime.inspectContainers(redisIds),
        params.runtime.inspectContainers(minioIds),
        params.runtime.inspectContainers(minioInitIds),
        params.runtime.inspectContainers(apiIds),
      ]);

      const minioInitComplete = minioInitInspect.every((entry) => {
        const state = (entry as DockerInspectEntry).State;
        return state?.Status === 'exited' && state.ExitCode === 0;
      });

      const topology = await inspectComposeTopology({
        runtime: params.runtime,
        expectedPorts: params.ports,
      });

      if (
        postgresInspect.every(isHealthy)
        && redisInspect.every(isHealthy)
        && minioInspect.every(isHealthy)
        && minioInitComplete
        && apiInspect.length === params.expectedApiReplicas
        && apiInspect.every(isHealthy)
        && await isHttpOk(`http://127.0.0.1:${params.ports.minio ?? 49000}/minio/health/live`)
        && topology.resolvedApiReplicas === params.expectedApiReplicas
        && topology.resolvedWorkerReplicas === params.expectedWorkerReplicas
      ) {
        await waitForOkHealth(params.baseUrl, { timeoutMs: 10_000, intervalMs: 250 });
        if (params.metricsEnabled) {
          await assertServiceMetricsReachable(params.runtime, 'api');
          await assertServiceMetricsReachable(params.runtime, 'worker');
        }
        return;
      }
    } catch {
      // keep polling until timeout
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for full-compose stress topology at ${params.baseUrl}`);
}
