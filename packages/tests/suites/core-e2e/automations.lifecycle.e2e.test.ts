import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
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
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

describe('core e2e: automations lifecycle', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('creates, runs, and surfaces automation changes', async () => {
    const testDir = run.testDir('automations-lifecycle');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const cursor0 = await fetchCursor(server.baseUrl, auth.token);

    const created = await requestJson<{
      id: string;
      name: string;
      enabled: boolean;
      schedule: { kind: 'interval'; everyMs: number | null; scheduleExpr: string | null };
      assignments: Array<{ machineId: string }>;
    }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'E2E automation',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'new_session',
        templateCiphertext: buildAutomationTemplateEnvelope(),
      },
    });

    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    expect(created.schedule.kind).toBe('interval');

    const listed = await requestJson<Array<{ id: string }>>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
    });
    expect(listed.some((entry) => entry.id === created.id)).toBe(true);

    const runNow = await requestJson<{ run: { id: string; automationId: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}/run-now`,
      method: 'POST',
      body: {},
    });
    expect(runNow.run.automationId).toBe(created.id);
    expect(runNow.run.state).toBe('queued');

    const runs = await requestJson<{ runs: Array<{ id: string }> }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}/runs`,
    });
    expect(runs.runs.some((entry) => entry.id === runNow.run.id)).toBe(true);

    const changes = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
    expect(changes.changes.some((entry) => entry.kind === 'automation' && entry.entityId === created.id)).toBe(true);
  }, 30_000);
});
