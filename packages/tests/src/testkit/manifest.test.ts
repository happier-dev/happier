import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeTestManifest } from './manifest';

describe('writeTestManifest', () => {
  it('persists extended stress topology and scenario metadata in the canonical manifest', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-manifest-'));
    const manifestPath = writeTestManifest(testDir, {
      startedAt: '2026-04-18T12:00:00.000Z',
      testName: 'stress-rpc',
      targetMode: 'full-compose',
      topology: {
        kind: 'full-compose',
        composeProjectName: 'stress-project',
        services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
        expectedApiReplicas: 3,
        expectedWorkerReplicas: 2,
        resolvedApiReplicas: 3,
        resolvedWorkerReplicas: 2,
        baseUrl: 'http://127.0.0.1:43080',
        ports: {
          gateway: 43080,
          postgres: 45432,
        },
      },
      scenario: {
        name: 'rpc.multiReplica',
        resolvedConfig: {
          targetMode: 'full-compose',
        },
      },
      artifacts: {
        composeFile: '/tmp/compose.yml',
        gatewayConfigFile: '/tmp/nginx.conf',
        summaryFile: '/tmp/summary.json',
      },
      results: {
        status: 'passed',
        startedAt: '2026-04-18T12:00:00.000Z',
        endedAt: '2026-04-18T12:05:00.000Z',
        failureClassification: 'none',
      },
    });

    const written = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(written.targetMode).toBe('full-compose');
    expect(written.topology).toMatchObject({
      kind: 'full-compose',
      composeProjectName: 'stress-project',
      expectedApiReplicas: 3,
      resolvedWorkerReplicas: 2,
    });
    expect(written.scenario).toMatchObject({ name: 'rpc.multiReplica' });
    expect(written.artifacts).toMatchObject({ composeFile: '/tmp/compose.yml' });
    expect(written.results).toMatchObject({ status: 'passed', failureClassification: 'none' });
  });
});
