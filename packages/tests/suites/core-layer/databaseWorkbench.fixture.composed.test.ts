import { expect, it } from 'vitest';

import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// Fixture readiness only: this is neither F1 acceptance nor a database G1 control.
// F1/F4 must drive first Connect and product Project/service creation themselves.
it('creates a fresh Account before Machine enrollment through the real credentialed executor', async () => {
  const fixture = await startDatabaseWorkbenchFixture({ testDir: run.testDir('database-workbench-fresh-account') });
  try {
    const account = await fixture.createAccount('fresh-owner');
    expect(await account.execute('machines.list', { serverId: fixture.serverId }))
      .toMatchObject({ ok: true, result: { items: [] } });
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "ProjectSource"')).toBe('0');
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Machine"')).toBe('0');
    const authenticated = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/features/authenticated`, {
      headers: { Authorization: `Bearer ${account.credentials.token}` },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.data).toMatchObject({ homeConnectionDescriptor: {
      homeServerIdentityId: fixture.serverId,
      endpoints: expect.arrayContaining([expect.objectContaining({ kind: 'https', url: fixture.server.baseUrl })]),
    } });
  } finally {
    await fixture.stop();
  }
});
