import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionsV2 } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: multi-server server-scoped operation routing', () => {
  let serverA: StartedServer | null = null;
  let serverB: StartedServer | null = null;
  let authA: TestAuth | null = null;
  let authB: TestAuth | null = null;

  afterAll(async () => {
    await serverA?.stop().catch(() => {});
    await serverB?.stop().catch(() => {});
  });

  it('keeps session projections isolated when operations are executed on a non-active server', async () => {
    const testDir = run.testDir('multi-server-server-scoped-routing');

    serverA = await startServerLight({ testDir: `${testDir}/server-a` });
    serverB = await startServerLight({ testDir: `${testDir}/server-b` });

    authA = await createTestAuth(serverA.baseUrl);
    authB = await createTestAuth(serverB.baseUrl);

    const { sessionId: sessionA } = await createSession(serverA.baseUrl, authA.token);
    const { sessionId: sessionB1 } = await createSession(serverB.baseUrl, authB.token);

    const listAInitial = await fetchSessionsV2(serverA.baseUrl, authA.token, { limit: 100 });
    const listBInitial = await fetchSessionsV2(serverB.baseUrl, authB.token, { limit: 100 });

    expect(listAInitial.sessions.some((row) => row.id === sessionA)).toBe(true);
    expect(listAInitial.sessions.some((row) => row.id === sessionB1)).toBe(false);
    expect(listBInitial.sessions.some((row) => row.id === sessionB1)).toBe(true);
    expect(listBInitial.sessions.some((row) => row.id === sessionA)).toBe(false);

    // Execute another operation on server B and verify server A projection remains unchanged.
    const { sessionId: sessionB2 } = await createSession(serverB.baseUrl, authB.token);

    const listAFinal = await fetchSessionsV2(serverA.baseUrl, authA.token, { limit: 100 });
    const listBFinal = await fetchSessionsV2(serverB.baseUrl, authB.token, { limit: 100 });

    expect(listAFinal.sessions.some((row) => row.id === sessionA)).toBe(true);
    expect(listAFinal.sessions.some((row) => row.id === sessionB1)).toBe(false);
    expect(listAFinal.sessions.some((row) => row.id === sessionB2)).toBe(false);

    expect(listBFinal.sessions.some((row) => row.id === sessionB1)).toBe(true);
    expect(listBFinal.sessions.some((row) => row.id === sessionB2)).toBe(true);
    expect(listBFinal.sessions.some((row) => row.id === sessionA)).toBe(false);
  }, 180_000);
});
