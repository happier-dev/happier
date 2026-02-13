import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { waitFor, sleep } from '../../src/testkit/timing';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: multi-server group prerequisites (auth + sockets across multiple servers)', () => {
  let serverA: StartedServer | null = null;
  let serverB: StartedServer | null = null;
  let authA: TestAuth | null = null;
  let authB: TestAuth | null = null;
  let uiA: SocketCollector | null = null;
  let uiB: SocketCollector | null = null;

  afterAll(async () => {
    uiA?.close();
    uiB?.close();
    await Promise.race([
      serverA?.stop().catch(() => {}),
      sleep(30_000),
    ]);
    await Promise.race([
      serverB?.stop().catch(() => {}),
      sleep(30_000),
    ]);
  }, 70_000);

  it('connects user-scoped sockets to two servers and routes updates independently', async () => {
    const testDir = run.testDir('multi-server-auth-and-sockets');
    serverA = await startServerLight({ testDir: `${testDir}/server-a` });
    serverB = await startServerLight({ testDir: `${testDir}/server-b` });

    authA = await createTestAuth(serverA.baseUrl);
    authB = await createTestAuth(serverB.baseUrl);

    uiA = createUserScopedSocketCollector(serverA.baseUrl, authA.token);
    uiB = createUserScopedSocketCollector(serverB.baseUrl, authB.token);
    uiA.connect();
    uiB.connect();

    await waitFor(() => uiA!.isConnected(), { timeoutMs: 20_000, context: 'ui socket connected to server A' });
    await waitFor(() => uiB!.isConnected(), { timeoutMs: 20_000, context: 'ui socket connected to server B' });

    const updatesA0 = uiA.getEvents().filter((e) => e.kind === 'update').length;
    const updatesB0 = uiB.getEvents().filter((e) => e.kind === 'update').length;

    await createSession(serverA.baseUrl, authA.token);
    await waitFor(
      () => uiA!.getEvents().filter((e) => e.kind === 'update').length > updatesA0,
      { timeoutMs: 20_000, context: 'server A emits update to its UI socket' },
    );

    // Best-effort isolation check: creating a session on server A should not advance server B's UI stream.
    // Allow a short wait in case there are delayed non-session updates.
    await sleep(500);
    const updatesB1 = uiB.getEvents().filter((e) => e.kind === 'update').length;
    expect(updatesB1).toBe(updatesB0);
  }, 240_000);
});

