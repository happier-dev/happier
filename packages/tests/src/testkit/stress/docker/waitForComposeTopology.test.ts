import { describe, expect, it, vi } from 'vitest';

vi.mock('../../http', () => ({
  waitForOkHealth: vi.fn(async () => {}),
}));

vi.mock('./inspectComposeTopology', () => ({
  inspectComposeTopology: vi.fn(async () => ({
    services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
    resolvedApiReplicas: 2,
    resolvedWorkerReplicas: 1,
    ports: {
      gateway: 43080,
      postgres: 45432,
      redis: 46379,
      minio: 49000,
      minioConsole: 49001,
    },
  })),
}));

describe('waitForComposeTopology', () => {
  it('waits until every expected api replica reports healthy before returning', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true } as Response)
      .mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    let apiInspectionCount = 0;
    const runtime = {
      serviceContainerIds: vi.fn(async (service: string) => {
        if (service === 'api') return ['api-1', 'api-2'];
        if (service === 'worker') return ['worker-1'];
        return [`${service}-1`];
      }),
      inspectContainers: vi.fn(async (containerIds: readonly string[]) => {
        if (containerIds[0]?.startsWith('api-')) {
          apiInspectionCount += 1;
          if (apiInspectionCount === 1) {
            return [
              { State: { Health: { Status: 'healthy' } } },
              { State: { Health: { Status: 'starting' } } },
            ];
          }

          return [
            { State: { Health: { Status: 'healthy' } } },
            { State: { Health: { Status: 'healthy' } } },
          ];
        }

        if (containerIds[0] === 'minio-init-1') {
          return [{ State: { Status: 'exited', ExitCode: 0 } }];
        }

        return [{ State: { Health: { Status: 'healthy' } } }];
      }),
      execCapture: vi.fn(async () => 'worker metrics'),
      ps: vi.fn(async () => ''),
      logs: vi.fn(async () => ''),
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
    };

    const { waitForComposeTopology } = await import('./waitForComposeTopology');

    await expect(
      waitForComposeTopology({
        runtime,
        baseUrl: 'http://127.0.0.1:43080',
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
        ports: {
          gateway: 43080,
          postgres: 45432,
          redis: 46379,
          minio: 49000,
          minioConsole: 49001,
        },
        metricsEnabled: false,
        timeoutMs: 2_500,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.serviceContainerIds).toHaveBeenCalledWith('api');
    expect(runtime.inspectContainers).toHaveBeenCalledWith(['api-1', 'api-2']);
    expect(apiInspectionCount).toBe(2);
  });

  it('checks direct api and worker metrics endpoints when metrics are enabled', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const runtime = {
      serviceContainerIds: vi.fn(async (service: string) => {
        if (service === 'api') return ['api-1', 'api-2'];
        if (service === 'worker') return ['worker-1'];
        return [`${service}-1`];
      }),
      inspectContainers: vi.fn(async (containerIds: readonly string[]) => {
        if (containerIds[0] === 'minio-init-1') {
          return [{ State: { Status: 'exited', ExitCode: 0 } }];
        }
        return Array.from({ length: containerIds.length }, () => ({ State: { Health: { Status: 'healthy' } } }));
      }),
      execCapture: vi
        .fn(async (service: string) => `${service}-metrics`),
      ps: vi.fn(async () => ''),
      logs: vi.fn(async () => ''),
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
    };

    const { waitForComposeTopology } = await import('./waitForComposeTopology');

    await expect(
      waitForComposeTopology({
        runtime,
        baseUrl: 'http://127.0.0.1:43080',
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
        ports: {
          gateway: 43080,
          postgres: 45432,
          redis: 46379,
          minio: 49000,
          minioConsole: 49001,
        },
        metricsEnabled: true,
        timeoutMs: 2_500,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.execCapture).toHaveBeenCalledWith(
      'api',
      expect.arrayContaining(['node']),
    );
    expect(runtime.execCapture).toHaveBeenCalledWith(
      'worker',
      expect.arrayContaining(['node']),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49000/minio/health/live');
  });
});
