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

describe('core e2e: automation CRUD + run history', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('supports create/edit/delete and reflects run state in automation history', async () => {
    const testDir = run.testDir('automations-crud');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const machineId = 'machine-crud-1';
    await requestJson({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: machineId, metadata: 'meta' },
    });

    const created = await requestJson<{ id: string; name: string; enabled: boolean }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'CRUD automation',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
        assignments: [{ machineId, enabled: true, priority: 1 }],
      },
    });
    expect(created.name).toBe('CRUD automation');
    expect(created.enabled).toBe(true);

    const patched = await requestJson<{ id: string; name: string; description: string | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}`,
      method: 'PATCH',
      body: {
        name: 'CRUD automation updated',
        description: 'updated',
        schedule: { kind: 'interval', everyMs: 120_000 },
      },
    });
    expect(patched.id).toBe(created.id);
    expect(patched.name).toBe('CRUD automation updated');
    expect(patched.description).toBe('updated');

    const runNow = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.run.state).toBe('queued');

    const claim = await requestJson<{ run: { id: string; state: string } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId, leaseDurationMs: 30_000 },
    });
    expect(claim.run?.id).toBe(runNow.run.id);

    const started = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/runs/${encodeURIComponent(runNow.run.id)}/start`,
      method: 'POST',
      body: { machineId },
    });
    expect(started.run.state).toBe('running');

    const succeeded = await requestJson<{ run: { id: string; state: string; producedSessionId: string | null } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/runs/${encodeURIComponent(runNow.run.id)}/succeed`,
      method: 'POST',
      body: { machineId },
    });
    expect(succeeded.run.state).toBe('succeeded');
    expect(succeeded.run.producedSessionId).toBeNull();

    const history = await requestJson<{ runs: Array<{ id: string; state: string; producedSessionId: string | null }> }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}/runs`,
      method: 'GET',
    });
    const finishedRun = history.runs.find((entry) => entry.id === runNow.run.id);
    expect(finishedRun?.state).toBe('succeeded');
    expect(finishedRun?.producedSessionId).toBeNull();

    await requestJson<{ ok: boolean }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}`,
      method: 'DELETE',
    });

    const listAfterDelete = await requestJson<Array<{ id: string }>>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
    });
    expect(listAfterDelete.some((entry) => entry.id === created.id)).toBe(false);
  });
});
