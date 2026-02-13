import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { fetchSessionsV2 } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: multi-server group projection (session lists stay server-scoped)', () => {
  let serverA: StartedServer | null = null;
  let serverB: StartedServer | null = null;
  let authA: TestAuth | null = null;
  let authB: TestAuth | null = null;

  afterAll(async () => {
    await serverA?.stop().catch(() => {});
    await serverB?.stop().catch(() => {});
  });

  it('does not mix sessions across two servers when listing sessions', async () => {
    const testDir = run.testDir('multi-server-session-list-projection');

    serverA = await startServerLight({ testDir: `${testDir}/server-a` });
    serverB = await startServerLight({ testDir: `${testDir}/server-b` });

    authA = await createTestAuth(serverA.baseUrl);
    authB = await createTestAuth(serverB.baseUrl);

    const { sessionId: sessionA } = await createSession(serverA.baseUrl, authA.token);
    const { sessionId: sessionB } = await createSession(serverB.baseUrl, authB.token);

    const listA = await fetchSessionsV2(serverA.baseUrl, authA.token, { limit: 50 });
    const listB = await fetchSessionsV2(serverB.baseUrl, authB.token, { limit: 50 });

    expect(listA.sessions.some((row) => row.id === sessionA)).toBe(true);
    expect(listB.sessions.some((row) => row.id === sessionB)).toBe(true);

    expect(listA.sessions.some((row) => row.id === sessionB)).toBe(false);
    expect(listB.sessions.some((row) => row.id === sessionA)).toBe(false);
  }, 180_000);
});

