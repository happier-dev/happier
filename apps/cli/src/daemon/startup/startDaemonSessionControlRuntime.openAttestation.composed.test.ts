import { join } from 'node:path';
import { ChildProcess } from 'node:child_process';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { writeSessionMarker } from '@/daemon/sessionRegistry';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createDeferred } from '@/testkit/async/deferred';

const boundary = vi.hoisted(() => ({ control: null as unknown }));
// Substitute only the OS listener; retain the actual startup and private dispatcher.
vi.mock('@/daemon/controlServer', async original => {
  const actual = await original<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof actual.startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    return { port: 46312, stop: async () => { await app.close(); } };
  } };
});

it('settles native-open exit from the captured runner cause while Home exit publication is pending', async () => {
  const fixture = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control as Parameters<typeof startDaemonControlServer>[0]);
  const { tracked, sessionId, daemon } = fixture;
  const publication = createDeferred<void>();
  const requestedPublication = createDeferred<void>();
  // Home HTTP is an external boundary; the actual exit owner retains its cause
  // before this publication and resource retirement have completed.
  vi.spyOn(axios, 'get').mockImplementation(async () => {
    requestedPublication.resolve();
    await publication.promise;
    throw new Error('Home unavailable');
  });
  tracked.childProcess = new ChildProcess();
  const controller = new AbortController();
  const opened = daemon.awaitAgentSessionOpen({ sessionId, timeoutMs: null, signal: controller.signal });
  Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
  const exiting = daemon.onChildExited(tracked.pid, { reason: 'process-exited', code: 1, signal: null,
    failureCause: { code: 'agent_startup_failed', phase: 'client_start', failureReason: 'unclassified_provider_error' } });
  try {
    await requestedPublication.promise;
    expect(await Promise.race([opened,
      new Promise(resolve => setImmediate(() => resolve('still waiting'))),
    ])).toMatchObject({ status: 'runner_exited', code: 'agent_startup_failed' });
  } finally {
    controller.abort();
    publication.resolve();
    await opened.catch(() => undefined);
    await exiting;
  }
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('wakes the native-open observer from a committed attestation through production daemon dispatch', async () => {
  const fixture = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control as Parameters<typeof startDaemonControlServer>[0]);
  const { tracked, runner, retainedAgent, sessionId, daemon } = fixture;
  const authorityPath = join(fixture.f.directory, 'open-authority.json');
  tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityPath;
  await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: tracked.pid, happySessionId: sessionId,
    startedBy: 'daemon', processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerAgentSourceCustodyV1: retainedAgent.sourceCustody, agentRuntimeDaemonServiceAuthorityFilePath: authorityPath });
  // The commit must wake its observer within this event-loop turn.
  const controller = new AbortController();
  const opened = daemon.awaitAgentSessionOpen({ sessionId, timeoutMs: null, signal: controller.signal });
  const request = { kind: 'create' as const, sessionId, cwd: fixture.cwd };
  try {
    expect(await fixture.dispatch({ kind: 'session.open.attest', requestId: 'open-attestation', phase: 'commit', request,
      providerSessionId: 'provider-child' })).toMatchObject({ ok: true });
    expect(await Promise.race([opened,
      new Promise(resolve => setImmediate(() => resolve('still waiting'))),
    ])).toEqual({ status: 'opened', request });
  } finally {
    controller.abort();
    await opened.catch(() => undefined);
  }
});
