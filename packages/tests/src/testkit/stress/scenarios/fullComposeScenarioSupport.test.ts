import { describe, expect, it, vi } from 'vitest';

import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  fetchGatewayStubStatus,
  readClusterServiceMetricsByReplicaViaNodeFetch,
  scrapeClusterServiceMetricCounters,
  scrapeClusterServiceMetricSelectors,
  scrapeServiceMetricCounters,
  scrapeServiceMetricSelectors,
  startClusterServiceMetricPeakSampler,
  startContainerMemoryPeakSampler,
  summarizeGatewayLogs,
  summarizeGatewayLogsFromComposeLogs,
} from './fullComposeScenarioSupport';

describe('fullComposeScenarioSupport', () => {
  it('exposes per-replica metrics with the exact compose container identity', async () => {
    const execInService = vi.fn(async () => JSON.stringify([
      'websocket_connections_active{role="api",type="user-scoped"} 1',
      'websocket_connections_active{role="api",type="user-scoped"} 0',
    ]));
    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api'],
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 0,
        resolvedApiReplicas: 2,
        resolvedWorkerReplicas: 0,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async () => [
          {
            id: 'api-a',
            name: 'project-api-1',
            service: 'api',
            state: 'running',
            health: 'healthy',
            ipv4Addresses: ['172.20.0.11'],
          },
          {
            id: 'api-b',
            name: 'project-api-2',
            service: 'api',
            state: 'running',
            health: 'healthy',
            ipv4Addresses: ['172.20.0.12'],
          },
        ]),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService,
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    await expect(readClusterServiceMetricsByReplicaViaNodeFetch(target, 'api')).resolves.toEqual([
      {
        target: '172.20.0.11:9090',
        containerId: 'api-a',
        containerName: 'project-api-1',
        metricsText: 'websocket_connections_active{role="api",type="user-scoped"} 1',
      },
      {
        target: '172.20.0.12:9090',
        containerId: 'api-b',
        containerName: 'project-api-2',
        metricsText: 'websocket_connections_active{role="api",type="user-scoped"} 0',
      },
    ]);
  });

  it('scrapes selected counters directly from a full-compose service metrics endpoint', async () => {
    const execInService = vi.fn(async () => [
      'session_alive_events_total 12',
      'machine_alive_events_total 7',
      'presence_stream_pending_entries 4',
    ].join('\n'));

    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api', 'worker'],
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
        resolvedApiReplicas: 2,
        resolvedWorkerReplicas: 1,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async () => []),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService,
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    await expect(
      scrapeServiceMetricCounters({
        target,
        service: 'worker',
        metricNames: [
          'session_alive_events_total',
          'machine_alive_events_total',
          'presence_stream_pending_entries',
        ],
      }),
    ).resolves.toEqual({
      session_alive_events_total: 12,
      machine_alive_events_total: 7,
      presence_stream_pending_entries: 4,
    });

    expect(execInService).toHaveBeenCalledWith(
      'worker',
      expect.arrayContaining(['node']),
    );
  });

  it('scrapes labeled metric selectors directly from a full-compose service metrics endpoint', async () => {
    const execInService = vi.fn(async () => [
      'session_write_create_message_duration_seconds_sum{stage="access",result="ok"} 2.5',
      'session_write_create_message_duration_seconds_count{stage="access",result="ok"} 10',
      'session_write_create_message_duration_seconds_sum{stage="persist",result="ok"} 7.5',
      'session_write_create_message_duration_seconds_count{stage="persist",result="ok"} 10',
      'database_transaction_retries_total{provider="postgres"} 4',
    ].join('\n'));

    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api', 'worker'],
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
        resolvedApiReplicas: 2,
        resolvedWorkerReplicas: 1,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async () => []),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService,
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    await expect(
      scrapeServiceMetricSelectors({
        target,
        service: 'api',
        selectors: [
          {
            alias: 'access_sum',
            metricName: 'session_write_create_message_duration_seconds_sum',
            labels: { stage: 'access', result: 'ok' },
          },
          {
            alias: 'access_count',
            metricName: 'session_write_create_message_duration_seconds_count',
            labels: { stage: 'access', result: 'ok' },
          },
          {
            alias: 'persist_sum',
            metricName: 'session_write_create_message_duration_seconds_sum',
            labels: { stage: 'persist', result: 'ok' },
          },
          {
            alias: 'retry_total',
            metricName: 'database_transaction_retries_total',
            labels: { provider: 'postgres' },
          },
        ],
      }),
    ).resolves.toEqual({
      access_sum: 2.5,
      access_count: 10,
      persist_sum: 7.5,
      retry_total: 4,
    });
  });

  it('aggregates selected counters and labeled metrics across all service replicas', async () => {
    const execInService = vi.fn(async (_service: string, command: readonly string[]) => {
      const encodedTargets = command[3];
      const targets = typeof encodedTargets === 'string' ? JSON.parse(encodedTargets) : [];
      expect(targets).toEqual([
        '10.20.0.11:9090',
        '10.20.0.12:9090',
      ]);
      return JSON.stringify([
        [
          'rpc_calls_total 120',
          'session_write_create_message_duration_seconds_sum{stage="total",result="ok"} 4',
          'session_write_create_message_duration_seconds_count{stage="total",result="ok"} 8',
        ].join('\n'),
        [
          'rpc_calls_total 80',
          'session_write_create_message_duration_seconds_sum{stage="total",result="ok"} 6',
          'session_write_create_message_duration_seconds_count{stage="total",result="ok"} 12',
        ].join('\n'),
      ]);
    });

    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api', 'worker'],
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
        resolvedApiReplicas: 2,
        resolvedWorkerReplicas: 1,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async (service: string) =>
          service === 'api'
            ? [
                {
                  id: 'api-1',
                  name: 'api-1',
                  service: 'api',
                  state: 'running',
                  health: 'healthy',
                  ipv4Addresses: ['10.20.0.11'],
                },
                {
                  id: 'api-2',
                  name: 'api-2',
                  service: 'api',
                  state: 'running',
                  health: 'healthy',
                  ipv4Addresses: ['10.20.0.12'],
                },
              ]
            : []),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService,
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    await expect(
      scrapeClusterServiceMetricCounters({
        target,
        service: 'api',
        metricNames: ['rpc_calls_total'],
      }),
    ).resolves.toEqual({
      rpc_calls_total: 200,
    });

    await expect(
      scrapeClusterServiceMetricSelectors({
        target,
        service: 'api',
        selectors: [
          {
            alias: 'total_sum',
            metricName: 'session_write_create_message_duration_seconds_sum',
            labels: { stage: 'total', result: 'ok' },
          },
          {
            alias: 'total_count',
            metricName: 'session_write_create_message_duration_seconds_count',
            labels: { stage: 'total', result: 'ok' },
          },
        ],
      }),
    ).resolves.toEqual({
      total_sum: 10,
      total_count: 20,
    });
  });

  it('fetches gateway stub status text from the full-compose base URL', async () => {
    const execInService = vi.fn(async () =>
      [
        'Active connections: 12',
        'server accepts handled requests',
        ' 100 100 120',
        'Reading: 2 Writing: 3 Waiting: 7',
      ].join('\n'));

    await expect(
      fetchGatewayStubStatus({
        mode: 'full-compose',
        baseUrl: 'http://127.0.0.1:43080',
        topology: {
          kind: 'full-compose',
          services: ['api', 'worker', 'gateway'],
          expectedApiReplicas: 2,
          expectedWorkerReplicas: 1,
          resolvedApiReplicas: 2,
          resolvedWorkerReplicas: 1,
          baseUrl: 'http://127.0.0.1:43080',
          ports: {},
        },
        admin: {
          listServiceContainers: vi.fn(async () => []),
          writeGatewayConfig: vi.fn(async () => ''),
          activateGatewayConfig: vi.fn(async () => {}),
          startService: vi.fn(async () => {}),
          stopService: vi.fn(async () => {}),
          stopContainer: vi.fn(async () => {}),
          killContainer: vi.fn(async () => {}),
          execInService,
        },
        preserveForInspection: vi.fn(),
        stop: vi.fn(async () => {}),
        collectDiagnostics: vi.fn(async () => {}),
      } satisfies StartedStressTarget),
    ).resolves.toContain('Active connections: 12');

    expect(execInService).toHaveBeenCalledWith('gateway', [
      'sh',
      '-lc',
      'wget -qO- http://127.0.0.1:8080/nginx_status',
    ]);
  });

  it('summarizes gateway access and error logs from the gateway container', async () => {
    const execInService = vi
      .fn(async (_service: string, command: readonly string[]) => {
        const script = command[2];
        if (script === 'cat /var/log/nginx/access.log 2>/dev/null || true') {
          return [
            '127.0.0.1 - - [20/Apr/2026:19:00:00 +0000] "GET /health HTTP/1.1" 200 12 "-" "curl/8.0"',
            '127.0.0.1 - - [20/Apr/2026:19:00:01 +0000] "GET /v1/updates HTTP/1.1" 101 0 "-" "socket.io"',
            '127.0.0.1 - - [20/Apr/2026:19:00:02 +0000] "GET /v1/updates HTTP/1.1" 499 0 "-" "socket.io"',
            '127.0.0.1 - - [20/Apr/2026:19:00:03 +0000] "GET /v1/updates HTTP/1.1" 502 0 "-" "socket.io"',
          ].join('\n');
        }
        if (script === 'cat /var/log/nginx/error.log 2>/dev/null || true') {
          return [
            '2026/04/20 19:00:02 [error] 30#30: *101 connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
            '2026/04/20 19:00:03 [error] 30#30: *102 upstream timed out (110: Operation timed out) while reading response header from upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
            '2026/04/20 19:00:04 [error] 30#30: *103 upstream prematurely closed connection while reading response header from upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
            '2026/04/20 19:00:05 [error] 30#30: *104 no live upstreams while connecting to upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://happier_api_upstream/v1/updates"',
          ].join('\n');
        }
        throw new Error(`unexpected command ${command.join(' ')}`);
      });

    await expect(
      summarizeGatewayLogs({
        mode: 'full-compose',
        baseUrl: 'http://127.0.0.1:43080',
        topology: {
          kind: 'full-compose',
          services: ['api', 'worker', 'gateway'],
          expectedApiReplicas: 2,
          expectedWorkerReplicas: 1,
          resolvedApiReplicas: 2,
          resolvedWorkerReplicas: 1,
          baseUrl: 'http://127.0.0.1:43080',
          ports: {},
        },
        admin: {
          listServiceContainers: vi.fn(async () => []),
          writeGatewayConfig: vi.fn(async () => ''),
          activateGatewayConfig: vi.fn(async () => {}),
          startService: vi.fn(async () => {}),
          stopService: vi.fn(async () => {}),
          stopContainer: vi.fn(async () => {}),
          killContainer: vi.fn(async () => {}),
          execInService,
        },
        preserveForInspection: vi.fn(),
        stop: vi.fn(async () => {}),
        collectDiagnostics: vi.fn(async () => {}),
      } satisfies StartedStressTarget),
    ).resolves.toEqual({
      access: {
        totalRequests: 4,
        updatesRequests: 3,
        status101: 1,
        status499: 1,
        status502: 1,
        status5xx: 1,
      },
      error: {
        connectFailed: 1,
        upstreamTimedOut: 1,
        upstreamPrematurelyClosed: 1,
        noLiveUpstreams: 1,
      },
    });
  });

  it('summarizes gateway access and error lines from persisted compose logs', () => {
    const composeLogs = [
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:00 +0000] "GET /health HTTP/1.1" 200 12 "-" "curl/8.0"',
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:01 +0000] "GET /v1/updates HTTP/1.1" 101 0 "-" "socket.io"',
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:02 +0000] "GET /v1/updates HTTP/1.1" 499 0 "-" "socket.io"',
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:03 +0000] "GET /v1/updates HTTP/1.1" 502 0 "-" "socket.io"',
      'gateway-1     | 2026/04/20 19:00:02 [error] 30#30: *101 connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
      'gateway-1     | 2026/04/20 19:00:03 [error] 30#30: *102 upstream timed out (110: Operation timed out) while reading response header from upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
      'gateway-1     | 2026/04/20 19:00:04 [error] 30#30: *103 upstream prematurely closed connection while reading response header from upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
      'gateway-1     | 2026/04/20 19:00:05 [error] 30#30: *104 no live upstreams while connecting to upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://happier_api_upstream/v1/updates"',
      'api-1         | [19:00:05.000] INFO request completed',
    ].join('\n');

    expect(summarizeGatewayLogsFromComposeLogs(composeLogs)).toEqual({
      access: {
        totalRequests: 4,
        updatesRequests: 3,
        status101: 1,
        status499: 1,
        status502: 1,
        status5xx: 1,
      },
      error: {
        connectFailed: 1,
        upstreamTimedOut: 1,
        upstreamPrematurelyClosed: 1,
        noLiveUpstreams: 1,
      },
    });
  });

  it('collects per-replica peak samples and delivers threshold diagnostic signals when stop is called before the next interval fires', async () => {
    const metricPayloads = [
      JSON.stringify([
        'runtime_heap_space_used_old_space_bytes 128',
        'runtime_heap_space_used_old_space_bytes 448',
      ]),
      JSON.stringify([
        'runtime_heap_space_used_old_space_bytes 96',
        'runtime_heap_space_used_old_space_bytes 512',
      ]),
    ];
    const execInService = vi.fn(async () => metricPayloads.shift() ?? JSON.stringify([]));
    const execInContainer = vi.fn(async () => '');
    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api'],
        expectedApiReplicas: 1,
        expectedWorkerReplicas: 0,
        resolvedApiReplicas: 1,
        resolvedWorkerReplicas: 0,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async () => [
          {
            id: 'api-1',
            name: 'api-1',
            service: 'api',
            state: 'running',
            health: 'healthy',
            ipv4Addresses: ['10.20.0.11'],
          },
          {
            id: 'api-2',
            name: 'api-2',
            service: 'api',
            state: 'running',
            health: 'healthy',
            ipv4Addresses: ['10.20.0.12'],
          },
        ]),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService,
        execInContainer,
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    const sampler = startClusterServiceMetricPeakSampler({
      target,
      service: 'api',
      metricNames: ['runtime_heap_space_used_old_space_bytes'],
      thresholdSignals: [{
        valueKey: 'runtime_heap_space_used_old_space_bytes',
        threshold: 500,
        signal: 'SIGUSR2',
      }],
      intervalMs: 60_000,
    });

    await new Promise((resolve) => setImmediate(resolve));

    await expect(sampler.stop()).resolves.toEqual({
      replicas: [
        {
          target: '10.20.0.11:9090',
          containerId: 'api-1',
          containerName: 'api-1',
          values: {
            runtime_heap_space_used_old_space_bytes: 128,
          },
        },
        {
          target: '10.20.0.12:9090',
          containerId: 'api-2',
          containerName: 'api-2',
          values: {
            runtime_heap_space_used_old_space_bytes: 512,
          },
        },
      ],
      signalEvents: [{
        target: '10.20.0.12:9090',
        containerId: 'api-2',
        containerName: 'api-2',
        valueKey: 'runtime_heap_space_used_old_space_bytes',
        threshold: 500,
        observedValue: 512,
        signal: 'SIGUSR2',
      }],
      signalErrors: [],
    });

    expect(execInContainer).toHaveBeenCalledWith(
      'api-2',
      [
        'node',
        '-e',
        'process.kill(1, process.argv[1] ?? "SIGUSR2");',
        'SIGUSR2',
      ],
    );
  });

  it('samples container memory peaks from real full-compose container execs', async () => {
    const metricsByContainer = new Map<string, string[]>([
      ['api-1', ['2048\n8192\n24\n', '3072\n8192\n40\n']],
      ['worker-1', ['1024\nmax\n8\n', '1024\nmax\n8\n']],
    ]);
    const target = {
      mode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      topology: {
        kind: 'full-compose',
        services: ['api', 'worker'],
        expectedApiReplicas: 1,
        expectedWorkerReplicas: 1,
        resolvedApiReplicas: 1,
        resolvedWorkerReplicas: 1,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {},
      },
      admin: {
        listServiceContainers: vi.fn(async (service: string) => {
          if (service === 'api') {
            return [{
              id: 'api-1',
              name: 'api-1',
              service: 'api',
              state: 'running',
              health: 'healthy',
              ipv4Addresses: ['10.20.0.11'],
            }];
          }
          if (service === 'worker') {
            return [{
              id: 'worker-1',
              name: 'worker-1',
              service: 'worker',
              state: 'running',
              health: 'healthy',
              ipv4Addresses: ['10.20.0.21'],
            }];
          }
          return [];
        }),
        writeGatewayConfig: vi.fn(async () => ''),
        activateGatewayConfig: vi.fn(async () => {}),
        startService: vi.fn(async () => {}),
        stopService: vi.fn(async () => {}),
        stopContainer: vi.fn(async () => {}),
        killContainer: vi.fn(async () => {}),
        execInService: vi.fn(async () => ''),
        execInContainer: vi.fn(async (containerId: string) => metricsByContainer.get(containerId)?.shift() ?? '0\n0\n0\n'),
      },
      preserveForInspection: vi.fn(),
      stop: vi.fn(async () => {}),
      collectDiagnostics: vi.fn(async () => {}),
    } satisfies StartedStressTarget;

    const sampler = startContainerMemoryPeakSampler({
      target,
      services: ['api', 'worker'],
      intervalMs: 60_000,
    });

    await new Promise((resolve) => setImmediate(resolve));

    await expect(sampler.stop()).resolves.toEqual({
      containers: [
        {
          service: 'api',
          containerId: 'api-1',
          containerName: 'api-1',
          peakMemoryUsageBytes: 3072,
          memoryLimitBytes: 8192,
          peakMemoryPercent: 37.5,
          peakPids: 40,
        },
        {
          service: 'worker',
          containerId: 'worker-1',
          containerName: 'worker-1',
          peakMemoryUsageBytes: 1024,
          peakPids: 8,
        },
      ],
      error: undefined,
    });
  });
});
