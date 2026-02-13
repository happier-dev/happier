import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { buildAutomationTemplateEnvelope } from '../../src/testkit/automations';

const run = createRunDirs({ runLabel: 'core' });

async function requestJson<T>(params: {
  baseUrl: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}): Promise<T> {
  const hasBody = params.body !== undefined;
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('core e2e: automation delayed claim recovery', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('claims overdue queued runs when machine comes online later', async () => {
    const testDir = run.testDir('automations-offline-recovery');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const machineId = 'machine-offline-recovery';
    await requestJson({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: machineId, metadata: 'meta' },
    });

    const automation = await requestJson<{ id: string }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'Offline recovery automation',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
        assignments: [{ machineId, enabled: true, priority: 1 }],
      },
    });

    const runNow = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(automation.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.run.state).toBe('queued');

    // Simulate offline delay before machine starts polling/claiming.
    await sleep(2_000);

    const claim = await requestJson<{ run: { id: string; claimedByMachineId: string } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId, leaseDurationMs: 30_000 },
    });

    expect(claim.run?.id).toBe(runNow.run.id);
    expect(claim.run?.claimedByMachineId).toBe(machineId);
  }, 45_000);
});
