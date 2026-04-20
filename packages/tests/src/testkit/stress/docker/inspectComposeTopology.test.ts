import { describe, expect, it, vi } from 'vitest';

import { inspectComposeTopology } from './inspectComposeTopology';

describe('inspectComposeTopology', () => {
  it('counts running api and worker replicas from docker compose ndjson ps output', async () => {
    const topology = await inspectComposeTopology({
      runtime: {
        imageExists: vi.fn(async () => true),
        inspectImage: vi.fn(async () => null),
        buildServerImage: vi.fn(async () => {}),
        listOwnedProjects: vi.fn(async () => []),
        projectHasRunningContainers: vi.fn(async () => false),
        removeProjectResources: vi.fn(async () => {}),
        up: vi.fn(async () => {}),
        down: vi.fn(async () => {}),
        restart: vi.fn(async () => {}),
        logs: vi.fn(async () => ''),
        execCapture: vi.fn(async () => ''),
        serviceContainerIds: vi.fn(async () => []),
        inspectContainers: vi.fn(async () => []),
        ps: vi.fn(async () => [
          JSON.stringify({ Service: 'api', State: 'running' }),
          JSON.stringify({ Service: 'api', State: 'running' }),
          JSON.stringify({ Service: 'worker', State: 'running' }),
          JSON.stringify({ Service: 'gateway', State: 'running' }),
          JSON.stringify({ Service: 'minio-init', State: 'exited' }),
        ].join('\n')),
      },
      expectedPorts: {
        gateway: 43080,
      },
    });

    expect(topology.services).toEqual(['api', 'worker', 'gateway', 'minio-init']);
    expect(topology.resolvedApiReplicas).toBe(2);
    expect(topology.resolvedWorkerReplicas).toBe(1);
    expect(topology.ports).toEqual({ gateway: 43080 });
  });
});
