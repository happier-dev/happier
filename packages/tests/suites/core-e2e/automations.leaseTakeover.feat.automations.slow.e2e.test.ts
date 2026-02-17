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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('core e2e: automation lease takeover', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('allows another assigned machine to claim a run after lease expiry', async () => {
    const testDir = run.testDir('automations-lease-takeover');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const m1 = 'machine-lease-1';
    const m2 = 'machine-lease-2';

    await requestJson({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: m1, metadata: 'meta-1' },
    });
    await requestJson({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: m2, metadata: 'meta-2' },
    });

    const automation = await requestJson<{ id: string }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'Lease takeover',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
        assignments: [
          { machineId: m1, enabled: true, priority: 10 },
          { machineId: m2, enabled: true, priority: 10 },
        ],
      },
    });

    const runNow = await requestJson<{ run: { id: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(automation.id)}/run-now`,
      method: 'POST',
    });

    const claim1 = await requestJson<{ run: { id: string; claimedByMachineId: string; attempt: number } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId: m1, leaseDurationMs: 5_000 },
    });
    expect(claim1.run?.id).toBe(runNow.run.id);
    expect(claim1.run?.claimedByMachineId).toBe(m1);
    expect(claim1.run?.attempt).toBe(1);

    const beforeExpiry = await requestJson<{ run: { id: string } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId: m2, leaseDurationMs: 5_000 },
    });
    expect(beforeExpiry.run).toBeNull();

    await sleep(5_200);

    const claim2 = await requestJson<{ run: { id: string; claimedByMachineId: string; attempt: number } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId: m2, leaseDurationMs: 5_000 },
    });
    expect(claim2.run?.id).toBe(runNow.run.id);
    expect(claim2.run?.claimedByMachineId).toBe(m2);
    expect(claim2.run?.attempt).toBe(2);
  }, 45_000);
});
