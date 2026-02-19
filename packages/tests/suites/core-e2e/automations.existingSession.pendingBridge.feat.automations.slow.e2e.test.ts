import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
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

describe('core e2e: existing_session automation target', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('supports existing_session target lifecycle', async () => {
    const testDir = run.testDir('automations-existing-session-target');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const machineId = 'machine-existing-session';
    await requestJson({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/machines',
      method: 'POST',
      body: { id: machineId, metadata: 'meta' },
    });

    const session = await createSession(server.baseUrl, auth.token);

    const created = await requestJson<{ id: string; targetType: 'new_session' | 'existing_session' }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'Existing-session target',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        targetType: 'existing_session',
        templateCiphertext: buildAutomationTemplateEnvelope({ existingSessionId: session.sessionId }),
        assignments: [{ machineId, enabled: true, priority: 1 }],
      },
    });
    expect(created.targetType).toBe('existing_session');

    const runNow = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(created.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.run.state).toBe('queued');

    const claim = await requestJson<{ run: { id: string } | null; automation: { targetType: string } | null }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v2/automations/runs/claim',
      method: 'POST',
      body: { machineId, leaseDurationMs: 30_000 },
    });
    expect(claim.run?.id).toBe(runNow.run.id);
    expect(claim.automation?.targetType).toBe('existing_session');

    const started = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/runs/${encodeURIComponent(runNow.run.id)}/start`,
      method: 'POST',
      body: { machineId },
    });
    expect(started.run.state).toBe('running');

    const failed = await requestJson<{ run: { id: string; state: string; errorCode: string | null } }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v2/automations/runs/${encodeURIComponent(runNow.run.id)}/fail`,
      method: 'POST',
      body: { machineId, errorCode: 'pending_bridge_not_wired' },
    });
    expect(failed.run.state).toBe('failed');
    expect(failed.run.errorCode).toBe('pending_bridge_not_wired');
  }, 45_000);
});
