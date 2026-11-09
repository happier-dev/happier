import { createServer, type IncomingMessage } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';

import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeferred } from '@/testkit/async/deferred';
import { createAutomationClaimClient } from './automation/automationClaimClient';
import { createWorkflowRunStorageClient } from './workflows/workflowRunStorageClient';

// HTTP is the system boundary. Publication, credential transport, and response
// decoding all remain real so a constructor-time URL cannot satisfy the test.
async function listener(onRequest?: (request: IncomingMessage) => boolean) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? '';
    paths.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (onRequest?.(request)) return;
    const body = path.endsWith('/assignments')
      ? { assignments: [], settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } }
      : path.endsWith('/run-lifecycle') ? { sources: [] }
      : { origin: paths.length };
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  return { origin: `http://127.0.0.1:${address.port}`, paths, server,
    close: () => !server.listening ? Promise.resolve()
      : new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

describe('daemon Home HTTP consumers', () => {
  const listeners: Awaited<ReturnType<typeof listener>>[] = [];
  const releases: (() => void)[] = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const boundary of listeners.splice(0)) await boundary.close();
  });
  async function boundary(onRequest?: Parameters<typeof listener>[0]) {
    const value = await listener(onRequest);
    listeners.push(value);
    return value;
  }
  function publish(origin: string) {
    const release = publishServerHttpRuntimeOrigin(origin, 'iroh', undefined, 'daemon-home');
    releases.push(release);
    return release;
  }

  it.each(['automation', 'workflow storage'] as const)('moves retained %s requests to the successor listener', async kind => {
    const first = await boundary();
    const retire = publish(first.origin);
    const automation = createAutomationClaimClient({ token: 'test-token', createPublisherHeader: async () => null });
    const storage = createWorkflowRunStorageClient({ token: 'test-token' });
    const next = await boundary();
    publish(next.origin);
    retire();
    await first.close();
    listeners.splice(listeners.indexOf(first), 1);

    if (kind === 'automation') {
      await expect(automation.fetchAssignments('machine')).resolves.toMatchObject({ assignments: [], runLifecycleSources: [] });
      expect(next.paths).toEqual(['/v3/automations/worker/assignments', '/v3/automations/worker/run-lifecycle']);
    } else {
      await expect(storage.execute({ operation: 'get', runId: 'run' })).resolves.toEqual({ origin: 1 });
      expect(next.paths).toEqual(['/v3/automations/runs/workflow-storage']);
    }
    expect(first.paths).toEqual([]);
  });

  it('keeps both assignment reads on the origin captured before asynchronous proof preparation', async () => {
    const first = await boundary();
    publish(first.origin);
    const entered = createDeferred();
    const proof = createDeferred<null>();
    const client = createAutomationClaimClient({ token: 'test-token', createPublisherHeader: async () => {
      entered.resolve();
      return await proof.promise;
    } });
    const pending = client.fetchAssignments('machine');
    await entered.promise;
    const next = await boundary();
    publish(next.origin);
    proof.resolve(null);
    await expect(pending).resolves.toMatchObject({ assignments: [] });
    expect(first.paths).toEqual(['/v3/automations/worker/assignments', '/v3/automations/worker/run-lifecycle']);
    expect(next.paths).toEqual([]);
    await client.fetchAssignments('machine');
    expect(next.paths).toEqual(['/v3/automations/worker/assignments', '/v3/automations/worker/run-lifecycle']);
  });

  it('keeps a workflow operation and its lost-response rejoin on their starting origin', async () => {
    let disconnect = true;
    const first = await boundary((request) => {
      if (!disconnect) return false;
      disconnect = false;
      publish(next.origin);
      request.socket.destroy();
      return true;
    });
    publish(first.origin);
    const next = await boundary();
    const client = createWorkflowRunStorageClient({ token: 'test-token', machineId: 'machine', createPublisherHeader: async () => null });
    await expect(client.execute({ operation: 'initialize', runId: 'run' })).resolves.toEqual({ origin: 2 });
    expect(first.paths).toHaveLength(2);
    expect(next.paths).toEqual([]);
    await expect(client.execute({ operation: 'get', runId: 'run' })).resolves.toEqual({ origin: 1 });
  });

  it('preserves explicit workflow endpoints and finite invocation bindings across publication changes', async () => {
    const first = await boundary();
    publish(first.origin);
    const explicit = createWorkflowRunStorageClient({ token: 'test-token', serverHttpBaseUrl: first.origin });
    const finite = runWithServerHttpBaseUrl(first.origin, () => createAutomationClaimClient({ token: 'test-token', createPublisherHeader: async () => null }));
    const next = await boundary();
    publish(next.origin);
    await explicit.execute({ operation: 'get', runId: 'run' });
    await finite.fetchAssignments('machine');
    expect(first.paths).toHaveLength(3);
    expect(next.paths).toEqual([]);
  });

  it('opens a retained storage client observation on the successor listener', async () => {
    const first = await boundary();
    publish(first.origin);
    const storage = createWorkflowRunStorageClient({ token: 'test-token' });
    const next = await boundary();
    const socketServer = new Server(next.server, { path: '/v1/updates' });
    publish(next.origin);
    const connected = createDeferred();
    const observation = storage.observeChanges('run', () => connected.resolve(), error => connected.reject(error));
    try {
      await connected.promise;
      expect(socketServer.sockets.sockets.size).toBe(1);
      expect(first.paths).toEqual([]);
    } finally {
      await observation.dispose();
      await new Promise<void>(resolve => socketServer.close(() => resolve()));
    }
  });
});
