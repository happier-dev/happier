import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

const TEST_ENCRYPTION = {
  type: 'legacy' as const,
  secret: new Uint8Array(32).fill(7),
};

function buildEncryptedTemplateCiphertext(template: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 'happier_automation_template_encrypted_v1',
    payloadCiphertext: encodeBase64(encryptLegacy(template, TEST_ENCRYPTION.secret)),
    ...(typeof template.existingSessionId === 'string' && template.existingSessionId.trim().length > 0
      ? { existingSessionId: template.existingSessionId.trim() }
      : {}),
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type RecordedState = {
  requests: string[];
  started: unknown[];
  heartbeats: unknown[];
  succeeded: unknown[];
  failed: unknown[];
  pendingEnqueue: unknown[];
  pendingMaterialize: unknown[];
};

async function startAutomationServer(params: {
  claimRunOnce: { run: Record<string, unknown>; automation: Record<string, unknown> } | null;
  missingAutomationRoutes?: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void>; state: RecordedState }> {
  const state: RecordedState = {
    requests: [],
    started: [],
    heartbeats: [],
    succeeded: [],
    failed: [],
    pendingEnqueue: [],
    pendingMaterialize: [],
  };

  let claimConsumed = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    state.requests.push(`${String(request.method ?? 'GET').toUpperCase()} ${url.pathname}`);

    if (!params.missingAutomationRoutes && request.method === 'GET' && url.pathname === '/v2/automations/daemon/assignments') {
      writeJson(response, 200, { assignments: [] });
      return;
    }

    if (!params.missingAutomationRoutes && request.method === 'POST' && url.pathname === '/v2/automations/runs/claim') {
      if (!claimConsumed && params.claimRunOnce) {
        claimConsumed = true;
        writeJson(response, 200, params.claimRunOnce);
        return;
      }
      writeJson(response, 200, { run: null, automation: null });
      return;
    }

    if (request.method === 'POST' && /\/v2\/automations\/runs\/.+\/start$/.test(url.pathname)) {
      state.started.push(await readJsonBody(request));
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && /\/v2\/automations\/runs\/.+\/heartbeat$/.test(url.pathname)) {
      state.heartbeats.push(await readJsonBody(request));
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && /\/v2\/automations\/runs\/.+\/succeed$/.test(url.pathname)) {
      state.succeeded.push(await readJsonBody(request));
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && /\/v2\/automations\/runs\/.+\/fail$/.test(url.pathname)) {
      state.failed.push(await readJsonBody(request));
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && /\/v2\/sessions\/.+\/pending$/.test(url.pathname)) {
      state.pendingEnqueue.push(await readJsonBody(request));
      writeJson(response, 200, { didWrite: true });
      return;
    }

    if (request.method === 'POST' && /\/v2\/sessions\/.+\/pending\/materialize-next$/.test(url.pathname)) {
      state.pendingMaterialize.push(await readJsonBody(request));
      writeJson(response, 200, { ok: true, didMaterialize: true, didWriteMessage: true });
      return;
    }

    writeJson(response, 404, { error: 'not_found', path: url.pathname });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    state,
  };
}

describe('automationWorker integration', () => {
  const previousHome = process.env.HAPPIER_HOME_DIR;
  const previousServer = process.env.HAPPIER_SERVER_URL;
  const previousWebapp = process.env.HAPPIER_WEBAPP_URL;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHome;

    if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServer;

    if (previousWebapp === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebapp;

    vi.resetModules();
  });

  it('claims and executes a new-session automation run to success', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({ directory: '/tmp/happier-automation', agent: 'codex' });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-1',
          name: 'Daily run',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.succeeded.length === 1);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(server.state.started).toHaveLength(1);
      expect(server.state.failed).toHaveLength(0);
      expect(server.state.succeeded[0]).toEqual(
        expect.objectContaining({
          machineId: 'machine-1',
          producedSessionId: 'session-1',
        }),
      );
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('stops polling when automation endpoints are missing (404)', async () => {
    const server = await startAutomationServer({
      claimRunOnce: null,
      missingAutomationRoutes: true,
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-missing-routes-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
      } as NodeJS.ProcessEnv,
    });

    await waitForCondition(() => server.state.requests.some((entry) => entry.includes('/v2/automations/')), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // If the worker doesn't self-disable on 404 route-missing errors, we'd see the claim/assignment routes
    // spammed on a tight interval.
    const automationRequests = server.state.requests.filter((entry) => entry.includes('/v2/automations/'));
    expect(automationRequests.length).toBeLessThanOrEqual(4);

    worker.stop();
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('marks claimed run as failed when template payload is invalid', async () => {
    const now = Date.now();

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-2',
          automationId: 'automation-2',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-2',
          name: 'Broken template',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: '{',
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-invalid-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-2' }));

    const worker = startAutomationWorker({
      token: 'token-2',
      machineId: 'machine-2',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.failed.length === 1);
      expect(spawnSession).not.toHaveBeenCalled();
      expect(server.state.started).toHaveLength(1);
      expect(server.state.succeeded).toHaveLength(0);
      expect(server.state.failed[0]).toEqual(
        expect.objectContaining({
          machineId: 'machine-2',
          errorCode: 'invalid_template',
        }),
      );
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not execute when HAPPIER_FEATURE_AUTOMATIONS__ENABLED is disabled', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({ directory: '/tmp/happier-automation' });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-3',
          automationId: 'automation-3',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-3',
          name: 'Disabled worker',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-disabled-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-3' }));

    const worker = startAutomationWorker({
      token: 'token-3',
      machineId: 'machine-3',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(spawnSession).not.toHaveBeenCalled();
      expect(server.state.started).toHaveLength(0);
      expect(server.state.succeeded).toHaveLength(0);
      expect(server.state.failed).toHaveLength(0);
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('executes existing_session runs', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      directory: '/tmp/happier-automation',
      existingSessionId: 'session-existing',
      sessionEncryptionKeyBase64: 'dGVzdA==',
      sessionEncryptionVariant: 'dataKey',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-4',
          automationId: 'automation-4',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-4',
          name: 'Existing target disabled',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-existing-disabled-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-4' }));

    const worker = startAutomationWorker({
      token: 'token-4',
      machineId: 'machine-4',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.succeeded.length === 1);
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: '/tmp/happier-automation',
          existingSessionId: 'session-existing',
        }),
      );
      expect(server.state.failed).toHaveLength(0);
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('enqueues and materializes existing_session automation prompt when provided', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      directory: '/tmp/happier-automation',
      existingSessionId: 'session-existing',
      sessionEncryptionKeyBase64: 'sV5GvMBrN+41qh6QleA1zoao46PdM6f95wo4keJ2H2Y=',
      sessionEncryptionVariant: 'dataKey',
      prompt: 'Run the scheduled maintenance checks.',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-6',
          automationId: 'automation-6',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-6',
          name: 'Existing target with prompt',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-existing-prompt-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-existing' }));

    const worker = startAutomationWorker({
      token: 'token-6',
      machineId: 'machine-6',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.succeeded.length === 1);
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          existingSessionId: 'session-existing',
        }),
      );
      expect(server.state.pendingEnqueue).toHaveLength(1);
      expect(server.state.pendingMaterialize).toHaveLength(1);
      expect(server.state.failed).toHaveLength(0);
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('enqueues and materializes existing_session automation prompt', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      directory: '/tmp/happier-automation',
      existingSessionId: 'session-existing',
      sessionEncryptionKeyBase64: 'sV5GvMBrN+41qh6QleA1zoao46PdM6f95wo4keJ2H2Y=',
      sessionEncryptionVariant: 'dataKey',
      prompt: 'Run the scheduled maintenance checks.',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-6b',
          automationId: 'automation-6b',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-6b',
          name: 'Existing target with prompt next heartbeat',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-existing-prompt-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-existing' }));

    const worker = startAutomationWorker({
      token: 'token-6b',
      machineId: 'machine-6b',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

	    try {
	      await waitForCondition(() => server.state.succeeded.length === 1);
	      expect(server.state.pendingEnqueue).toHaveLength(1);
	      expect(server.state.pendingMaterialize).toHaveLength(1);
	      expect(server.state.failed).toHaveLength(0);
	    } finally {
	      worker.stop();
	      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('marks existing_session runs as unavailable on machine when spawn fails before webhook', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      directory: '/tmp/happier-automation',
      existingSessionId: 'session-existing',
      sessionEncryptionKeyBase64: 'dGVzdA==',
      sessionEncryptionVariant: 'dataKey',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-7-unavailable',
          automationId: 'automation-7-unavailable',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-7-unavailable',
          name: 'Existing target unavailable',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-existing-unavailable-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');
    type StartAutomationWorkerParams = Parameters<typeof startAutomationWorker>[0];

    const spawnSession: StartAutomationWorkerParams['spawnSession'] = vi.fn(async () => ({
      type: 'error' as const,
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' as const,
      errorMessage: 'Session process exited before webhook',
    }));

    const worker = startAutomationWorker({
      token: 'token-7-unavailable',
      machineId: 'machine-7-unavailable',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.failed.length === 1);
      expect(server.state.failed[0]).toEqual(
        expect.objectContaining({
          machineId: 'machine-7-unavailable',
          errorCode: 'existing_session_unavailable_on_machine',
        }),
      );
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('passes new_session automation prompt to spawn options when provided', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      directory: '/tmp/happier-automation',
      prompt: 'Generate the daily maintenance summary.',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-7',
          automationId: 'automation-7',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-7',
          name: 'New session prompt handoff',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-new-prompt-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-automation-new-prompt' }));

    const worker = startAutomationWorker({
      token: 'token-7',
      machineId: 'machine-7',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await waitForCondition(() => server.state.succeeded.length === 1);
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: '/tmp/happier-automation',
          initialPrompt: 'Generate the daily maintenance summary.',
        }),
      );
      expect(server.state.failed).toHaveLength(0);
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not execute runs when daemon execution budget has no ephemeral task capacity', async () => {
    const now = Date.now();
    const template = buildEncryptedTemplateCiphertext({
      agent: 'claude',
      directory: '/tmp/happier-automation',
      prompt: 'Hello',
    });

    const server = await startAutomationServer({
      claimRunOnce: {
        run: {
          id: 'run-budget-1',
          automationId: 'automation-budget-1',
          state: 'queued',
          scheduledAt: now,
          dueAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          claimedByMachineId: null,
          leaseExpiresAt: null,
          attempt: 1,
          summaryCiphertext: null,
          errorCode: null,
          errorMessage: null,
          producedSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
        automation: {
          id: 'automation-budget-1',
          name: 'Budgeted run',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: template,
        },
      },
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-automation-worker-budget-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    vi.resetModules();
    const { startAutomationWorker } = await import('./automationWorker');

    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-budget-1' }));

    const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentEphemeralTasks: 1 });
    expect(budgetRegistry.tryAcquireEphemeralTask('busy', 'ephemeral_task')).toBe(true);

    const worker = startAutomationWorker({
      token: 'token-budget-1',
      machineId: 'machine-budget-1',
      encryption: TEST_ENCRYPTION,
      spawnSession,
      budgetRegistry,
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '20',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '20',
        HAPPIER_AUTOMATION_LEASE_MS: '200',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '50',
      } as NodeJS.ProcessEnv,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(spawnSession).toHaveBeenCalledTimes(0);
      expect(server.state.started).toHaveLength(0);
      expect(server.state.succeeded).toHaveLength(0);
    } finally {
      worker.stop();
      await server.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
