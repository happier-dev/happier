import { readdir } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createDeferred } from '@/testkit/async/deferred';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createManagedOpenCodeClientFixture, createOpenCodeSseResponse } from './managedOpenCodeClient.testkit';
import { createOpenCodeServerRuntime } from './runtime';

afterEach(() => vi.restoreAllMocks());

async function readClientClaims(statePath: string): Promise<string[]> {
  try {
    return (await readdir(`${statePath}.clients`)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function createProviderHttpBoundary() {
  const healthEntered = createDeferred();
  const releaseHealth = createDeferred();
  let holdNextHealth = true;
  let sessionsCreated = 0;
  const streams: ReturnType<typeof createOpenCodeSseResponse>[] = [];

  // Provider HTTP boundary only: runtime acquisition, client claims and disposal remain real.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.pathname === '/global/health') {
      if (holdNextHealth) {
        holdNextHealth = false;
        healthEntered.resolve();
        await releaseHealth.promise;
      }
      return Response.json({ healthy: true, version: '1.18.33' });
    }
    if (url.pathname === '/session' && init?.method === 'POST') {
      sessionsCreated += 1;
      return Response.json({ id: `ses_custody_${sessionsCreated}` });
    }
    if (url.pathname === '/event') {
      const stream = createOpenCodeSseResponse(init?.signal);
      streams.push(stream);
      stream.send({ type: 'server.connected', properties: {} });
      return stream.response;
    }
    if (url.pathname === '/skill') {
      return Response.json([{ name: 'review', description: 'Review code', location: '/skills/review/SKILL.md' }]);
    }
    if (url.pathname === '/config') return Response.json({});
    return Response.json([]);
  });

  return {
    healthEntered: healthEntered.promise,
    releaseHealth: () => releaseHealth.resolve(),
    sessionsCreated: () => sessionsCreated,
    close: () => {
      releaseHealth.resolve();
      for (const stream of streams) stream.close();
    },
  };
}

function createRuntime(directory: string) {
  // The canonical Session fixture replaces the relay boundary; no runtime/client logic is mocked.
  const session = createMutableApiSessionClientFixture({
    metadata: createTestMetadata({ flavor: 'opencode', path: directory }),
    overrides: { sendSessionEvent: () => {} },
  });
  return createOpenCodeServerRuntime({
    directory,
    env: { ...process.env, HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0' },
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    happierMcpAdmission: { kind: 'not_available_for_execution_run' },
    permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[custody-test]' }),
    onThinkingChange: () => {},
  });
}

describe('OpenCode runtime client custody', () => {
  it('releases all custody after a cold skill request overlaps startup', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    const http = createProviderHttpBoundary();
    const runtime = createRuntime(fixture.homeDir);
    const startup = runtime.startOrLoad();
    const skills = runtime.listSkills();
    try {
      await http.healthEntered;
      http.releaseHealth();
      await Promise.all([startup, skills]);

      await runtime.reset();

      expect(await readClientClaims(fixture.statePath)).toEqual([]);
      expect(await waitForProcessExit(fixture.pid, { timeoutMs: 1_000 })).toBe(true);
    } finally {
      http.releaseHealth();
      await Promise.allSettled([startup, skills]);
      await runtime.reset();
      http.close();
      await fixture.close();
    }
  });

  it('drains acquisition overtaken by reset without provider setup, then permits an intentional restart', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    const http = createProviderHttpBoundary();
    let pendingHttp: ReturnType<typeof createProviderHttpBoundary> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let settledStartup: Promise<void> | undefined;
    try {
      // Another real client keeps the shared provider available for the intentional restart.
      http.releaseHealth();
      await fixture.createClient({ directory: fixture.homeDir, messageBuffer: new MessageBuffer() });
      const baselineClaims = await readClientClaims(fixture.statePath);
      expect(baselineClaims).toHaveLength(1);
      http.close();
      pendingHttp = createProviderHttpBoundary();
      runtime = createRuntime(fixture.homeDir);
      const startup = runtime.startOrLoad();
      // Reset is allowed to reject the interrupted startup, but must dispose its late client.
      settledStartup = startup.then(() => undefined, () => undefined);
      await pendingHttp.healthEntered;
      const reset = runtime.reset();
      pendingHttp.releaseHealth();
      await Promise.all([settledStartup, reset]);

      expect(runtime.getSessionId()).toBeNull();
      expect(runtime.getManagedServerIdentity()).toBeNull();
      expect(pendingHttp.sessionsCreated()).toBe(0);
      expect(await readClientClaims(fixture.statePath)).toEqual(baselineClaims);

      await expect(runtime.startOrLoad()).resolves.toBe('ses_custody_1');
      expect(await readClientClaims(fixture.statePath)).toHaveLength(baselineClaims.length + 1);
      await runtime.reset();
      expect(await readClientClaims(fixture.statePath)).toEqual(baselineClaims);
    } finally {
      http.close();
      pendingHttp?.releaseHealth();
      await settledStartup;
      await runtime?.reset();
      pendingHttp?.close();
      await fixture.close();
    }
  });
});
