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
}): Promise<{ status: number; data: T }> {
  const hasBody = params.body !== undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };

  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? 'GET',
    headers,
    ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload as T };
}

describe('core e2e: automation actions', () => {
  const started: StartedServer[] = [];

  afterAll(async () => {
    await Promise.all(started.map(async (server) => await server.stop()));
  });

  async function startTestServer(testName: string): Promise<{ server: StartedServer; token: string }> {
    const testDir = run.testDir(testName);
    const server = await startServerLight({ testDir });
    started.push(server);
    const auth = await createTestAuth(server.baseUrl);
    return { server, token: auth.token };
  }

  it('pauses/resumes automation and supports run-now POST without body', async () => {
    const { server, token } = await startTestServer('automations-actions-pause-resume');

    const created = await requestJson<{ id: string; enabled: boolean }>({
      baseUrl: server.baseUrl,
      token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'PauseResume',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
      },
    });
    expect(created.data.id).toBeTruthy();
    expect(created.data.enabled).toBe(true);

    const paused = await requestJson<{ enabled: boolean }>({
      baseUrl: server.baseUrl,
      token,
      path: `/v2/automations/${encodeURIComponent(created.data.id)}/pause`,
      method: 'POST',
    });
    expect(paused.data.enabled).toBe(false);

    const resumed = await requestJson<{ enabled: boolean }>({
      baseUrl: server.baseUrl,
      token,
      path: `/v2/automations/${encodeURIComponent(created.data.id)}/resume`,
      method: 'POST',
    });
    expect(resumed.data.enabled).toBe(true);

    const runNowResponse = await fetch(
      `${server.baseUrl}/v2/automations/${encodeURIComponent(created.data.id)}/run-now`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(runNowResponse.status).toBe(200);
    const runNowPayload = await runNowResponse.json() as { run: { state: string } };
    expect(runNowPayload.run.state).toBe('queued');
  }, 60_000);

  it('allows only one machine to claim the same queued run', async () => {
    const { server, token } = await startTestServer('automations-actions-claim-exclusivity');

    const m1 = 'machine-claim-1';
    const m2 = 'machine-claim-2';
    await requestJson({
      baseUrl: server.baseUrl,
      token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: m1, metadata: 'meta-1' },
    });
    await requestJson({
      baseUrl: server.baseUrl,
      token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: m2, metadata: 'meta-2' },
    });

    const created = await requestJson<{ id: string }>({
      baseUrl: server.baseUrl,
      token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'ClaimExclusivity',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
        assignments: [
          { machineId: m1, enabled: true, priority: 100 },
          { machineId: m2, enabled: true, priority: 100 },
        ],
      },
    });

    const runNow = await requestJson<{ run: { id: string } }>({
      baseUrl: server.baseUrl,
      token,
      path: `/v2/automations/${encodeURIComponent(created.data.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.data.run.id).toBeTruthy();

    const claim1 = await requestJson<{ run: { id: string; claimedByMachineId: string } | null }>({
      baseUrl: server.baseUrl,
      token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId: m1, leaseDurationMs: 30_000 },
    });
    expect(claim1.data.run?.id).toBe(runNow.data.run.id);
    expect(claim1.data.run?.claimedByMachineId).toBe(m1);

    const claim2 = await requestJson<{ run: { id: string } | null }>({
      baseUrl: server.baseUrl,
      token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId: m2, leaseDurationMs: 30_000 },
    });
    expect(claim2.data.run).toBeNull();
  }, 60_000);
});
